//! Install scopes: where an installed plugin's files live and which chats
//! get it.
//!
//! - Global and Machine plugins live in `<data dir>/plugins/<marketplace>/
//!   <name>/` and ride every chat on this machine.
//! - A Project-local plugin lives in `<data dir>/plugins/.projects/
//!   <project>/<marketplace>/<name>/`, outside the repo.
//! - A Project plugin lives in the repo, `<project folder>/.openremote/
//!   plugins/<name>/`, so whoever clones the repo has its files. Files are
//!   not approval: the machine runs exactly the content it approved (by
//!   content hash), and a plugin the repo brings, or changes, waits for
//!   the user's review.
//!
//! Project plugins ride the chats whose folder is that project's folder -
//! the same rule the sidebar groups chats by.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::SystemTime;

use openremote_core::{InstalledPlugin, PluginScope, ProjectId, Store};
use serde::Serialize;

/// The folder a project's own plugins sit in, inside the repo
/// (`.openremote/plugins`), and the repo's note of where each came from
/// (`.openremote/plugins.json`).
fn repo_plugins(project_folder: &Path) -> PathBuf {
    project_folder.join(".openremote").join("plugins")
}

fn repo_index(project_folder: &Path) -> PathBuf {
    project_folder.join(".openremote").join("plugins.json")
}

/// An installed plugin a chat gets, with where its files are.
#[derive(Clone, Debug)]
pub struct Active {
    pub plugin: InstalledPlugin,
    pub dir: PathBuf,
}

pub fn project_local_dir(
    data_dir: &Path,
    project: ProjectId,
    marketplace: &str,
    name: &str,
) -> PathBuf {
    data_dir
        .join("plugins")
        .join(".projects")
        .join(project.to_string())
        .join(marketplace)
        .join(name)
}

pub fn repo_dir(project_folder: &Path, name: &str) -> PathBuf {
    repo_plugins(project_folder).join(name)
}

/// Where an installed plugin's files are; none when its project is gone.
pub fn folder(data_dir: &Path, store: &Store, plugin: &InstalledPlugin) -> Option<PathBuf> {
    match plugin.scope {
        PluginScope::Global | PluginScope::Machine => Some(crate::plugins::plugin_dir(
            data_dir,
            &plugin.marketplace,
            &plugin.name,
        )),
        PluginScope::ProjectLocal => Some(project_local_dir(
            data_dir,
            plugin.project?,
            &plugin.marketplace,
            &plugin.name,
        )),
        PluginScope::Project => {
            let project = store.project(&plugin.project?).ok()?;
            Some(repo_dir(project.folders.first()?, &plugin.name))
        }
    }
}

fn same_folder(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The registered project whose folder a chat runs in.
pub fn project_of(store: &Store, workspace: &Path) -> Option<ProjectId> {
    store
        .projects()
        .into_iter()
        .find(|p| p.folders.iter().any(|f| same_folder(f, workspace)))
        .map(|p| p.id)
}

/// The plugins a chat in `workspace` gets: every enabled Global and Machine
/// plugin, and - for a chat in a project - that project's enabled ones
/// whose files are still what the user approved.
pub fn active(store: &Store, data_dir: &Path, workspace: Option<&Path>) -> Vec<Active> {
    let project = workspace.and_then(|w| project_of(store, w));
    let mut out = Vec::new();
    for plugin in store.installed_plugins() {
        if !plugin.enabled {
            continue;
        }
        let wanted = match plugin.scope {
            PluginScope::Global | PluginScope::Machine => true,
            PluginScope::ProjectLocal | PluginScope::Project => {
                project.is_some() && plugin.project == project
            }
        };
        if !wanted {
            continue;
        }
        let Some(dir) = folder(data_dir, store, plugin) else {
            continue;
        };
        if plugin.scope == PluginScope::Project && !unchanged(&dir, plugin.resolved.as_deref()) {
            continue;
        }
        out.push(Active {
            plugin: plugin.clone(),
            dir,
        });
    }
    out
}

/// Whether a repo plugin's files are exactly the approved ones.
pub fn unchanged(dir: &Path, approved: Option<&str>) -> bool {
    match (approved, cached_hash(dir)) {
        (Some(approved), Some(hash)) => approved == hash,
        _ => false,
    }
}

/// A cheap look at a folder: how many files, how many bytes, the newest
/// change. Equal looks reuse the last content hash instead of reading
/// every byte at each chat's start.
#[derive(PartialEq, Eq, Clone, Copy)]
struct Look {
    files: u64,
    bytes: u64,
    newest: Option<SystemTime>,
}

fn look(dir: &Path) -> Option<Look> {
    fn walk(dir: &Path, look: &mut Look) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_name() == ".git" {
                continue;
            }
            let meta = entry.metadata()?;
            if meta.is_dir() {
                walk(&entry.path(), look)?;
            } else if meta.is_file() {
                look.files += 1;
                look.bytes += meta.len();
                let modified = meta.modified().ok();
                if modified > look.newest {
                    look.newest = modified;
                }
            }
        }
        Ok(())
    }
    let mut out = Look {
        files: 0,
        bytes: 0,
        newest: None,
    };
    walk(dir, &mut out).ok()?;
    Some(out)
}

fn cached_hash(dir: &Path) -> Option<String> {
    static HASHES: OnceLock<StdMutex<HashMap<PathBuf, (Look, String)>>> = OnceLock::new();
    let now = look(dir)?;
    let cache = HASHES.get_or_init(Default::default);
    if let Some((seen, hash)) = cache.lock().ok()?.get(dir) {
        if *seen == now {
            return Some(hash.clone());
        }
    }
    let hash = crate::plugins::content_hash(dir).ok()?;
    cache
        .lock()
        .ok()?
        .insert(dir.to_path_buf(), (now, hash.clone()));
    Some(hash)
}

/// A plugin a project's repo carries that this machine hasn't approved,
/// or whose files changed since it was approved.
#[derive(Serialize, Debug)]
pub struct Found {
    pub project: ProjectId,
    pub name: String,
    pub path: String,
    /// `new` (never approved here) or `changed` (the repo's files differ
    /// from what was approved).
    pub why: &'static str,
    /// The installed plugin it would replace, for a changed one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// Every registered project's repo plugins that wait for review.
pub fn found(store: &Store) -> Vec<Found> {
    let mut out = Vec::new();
    for project in store.projects() {
        let Some(folder) = project.folders.first() else {
            continue;
        };
        let Ok(entries) = std::fs::read_dir(repo_plugins(folder)) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for dir in dirs {
            let Some(name) = dir.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            let approved = store.installed_plugins().into_iter().find(|p| {
                p.scope == PluginScope::Project && p.project == Some(project.id) && p.name == name
            });
            let why = match approved {
                None => "new",
                Some(p) if !unchanged(&dir, p.resolved.as_deref()) => "changed",
                Some(_) => continue,
            };
            out.push(Found {
                project: project.id,
                name,
                path: dir.to_string_lossy().into_owned(),
                why,
                id: approved.map(InstalledPlugin::id),
            });
        }
    }
    out
}

/// The marketplace a repo's index says one of its plugins came from.
pub fn repo_marketplace(project_folder: &Path, name: &str) -> Option<String> {
    let raw = std::fs::read(repo_index(project_folder)).ok()?;
    let index: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    index["plugins"][name]["marketplace"]
        .as_str()
        .map(String::from)
}

/// Note in the repo's index where one of its plugins came from, so a
/// teammate's review can say it too. A folder or file on this machine is
/// named only by its kind: a local path has no business in a repo.
pub fn note_in_repo_index(project_folder: &Path, plugin: &InstalledPlugin) -> std::io::Result<()> {
    let path = repo_index(project_folder);
    let source = match &plugin.source {
        openremote_core::PluginSource::Folder { .. } => serde_json::json!({"kind": "folder"}),
        openremote_core::PluginSource::Archive { location }
            if !(location.starts_with("https://") || location.starts_with("http://")) =>
        {
            serde_json::json!({"kind": "archive"})
        }
        other => serde_json::to_value(other).unwrap_or_default(),
    };
    let mut index: serde_json::Value = std::fs::read(&path)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({"plugins": {}}));
    if !index["plugins"].is_object() {
        index["plugins"] = serde_json::json!({});
    }
    index["plugins"][&plugin.name] = serde_json::json!({
        "marketplace": plugin.marketplace,
        "version": plugin.version,
        "source": source,
    });
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&index).expect("an index serializes"),
    )
}

/// Drop a removed plugin from the repo's index.
pub fn forget_in_repo_index(project_folder: &Path, name: &str) {
    let path = repo_index(project_folder);
    let Some(mut index) = std::fs::read(&path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
    else {
        return;
    };
    if let Some(plugins) = index["plugins"].as_object_mut() {
        plugins.remove(name);
    }
    let _ = std::fs::write(
        &path,
        serde_json::to_vec_pretty(&index).expect("an index serializes"),
    );
}
