//! Installing into a scope, and removing from one. The staging and the
//! review are `plugins.rs`'s; this places an approved plugin where its
//! scope keeps it, records it, and tells the rest of OpenRemote.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::StatusCode;
use openremote_core::{
    InstalledPlugin, PluginRuntime as Runtime, PluginScope, PluginSource, ProjectId,
};

use super::scope;
use crate::app::App;
use crate::plugins::{Manifest, PluginError, Staged};
use crate::supervisor::lock_recovering;

pub type Failure = (StatusCode, String);

/// The scopes a staged plugin may install into. A plugin a command makes
/// is re-made on this machine at each chat start, so it stays on this
/// machine; a harness lives in every picker on the machine, so it can't
/// belong to one project.
pub fn allowed_scopes(manifest: &Manifest, from_command: bool) -> Vec<PluginScope> {
    let mut scopes = Vec::new();
    if !from_command {
        scopes.push(PluginScope::Global);
    }
    scopes.push(PluginScope::Machine);
    if !from_command && manifest.contributes.harnesses.is_empty() {
        scopes.push(PluginScope::ProjectLocal);
        scopes.push(PluginScope::Project);
    }
    scopes
}

/// At review: a WASM plugin's module compiles, exports what OpenRemote
/// calls and imports only what its powers allow.
pub fn check_staged(root: &Path, manifest: &Manifest) -> Result<(), PluginError> {
    if manifest.runtime != Runtime::Wasm {
        return Ok(());
    }
    let entry = manifest
        .entry
        .as_deref()
        .ok_or_else(|| PluginError::Invalid("a wasm plugin names its module".into()))?;
    super::wasm::check(&root.join(entry), &manifest.powers).map_err(PluginError::Invalid)
}

/// Put `from` at `target`, replacing what is there whole. A rename is
/// tried first; a target on another drive (a project's folder) gets a
/// copy. The old folder moves aside before anything lands, and comes back
/// if the new one can't.
pub fn place(from: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let aside = target.with_file_name(format!(
        ".{}.old-{}",
        target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        uuid::Uuid::new_v4()
    ));
    let had = target.exists();
    if had {
        std::fs::rename(target, &aside).map_err(|e| e.to_string())?;
    }
    let landed = std::fs::rename(from, target).or_else(|_| copy_tree(from, target));
    match landed {
        Ok(()) => {
            if had {
                let _ = std::fs::remove_dir_all(&aside);
            }
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(target);
            if had {
                let _ = std::fs::rename(&aside, target);
            }
            Err(e.to_string())
        }
    }
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// The folder a project's plugins hang under, for a project scope.
fn project_folder(app: &App, project: ProjectId) -> Result<PathBuf, Failure> {
    let store = lock_recovering(&app.store);
    let project = store
        .project(&project)
        .map_err(|_| (StatusCode::NOT_FOUND, "no such project".to_string()))?;
    project.folders.first().cloned().ok_or((
        StatusCode::CONFLICT,
        "the project has no folder".to_string(),
    ))
}

/// Place an approved plugin in its scope and record it. An install of an
/// id already here replaces it whole and keeps it on or off as it was.
pub async fn install(
    app: &Arc<App>,
    staged: Staged,
    scope: PluginScope,
    project: Option<ProjectId>,
) -> Result<InstalledPlugin, Failure> {
    let bad = |message: String| (StatusCode::BAD_REQUEST, message);
    let manifest = staged.manifest.clone();
    let from_command = staged.command.is_some();
    if !allowed_scopes(&manifest, from_command).contains(&scope) {
        let why = if from_command {
            "a plugin made by a command installs for this machine only"
        } else {
            "a plugin with a harness installs for this machine or for every device, not for one project"
        };
        app.plugins.discard(staged);
        return Err(bad(why.into()));
    }
    let project = match (scope.is_project(), project) {
        (true, Some(project)) => Some(project),
        (true, None) => {
            app.plugins.discard(staged);
            return Err(bad("say which project it is for".into()));
        }
        (false, _) => None,
    };
    let id = openremote_core::plugin_id(&staged.name, &staged.marketplace, scope, project);
    // A harness id belongs to one plugin on a machine.
    {
        let store = lock_recovering(&app.store);
        for other in store.installed_plugins() {
            if other.id() == id {
                continue;
            }
            if let Some(clash) = other.contributes.harnesses.iter().find(|h| {
                manifest
                    .contributes
                    .harnesses
                    .iter()
                    .any(|mine| mine.id == h.id)
            }) {
                let message = format!(
                    "the harness id {} is already {}'s - remove that plugin first",
                    clash.id,
                    other.id()
                );
                drop(store);
                app.plugins.discard(staged);
                return Err((StatusCode::CONFLICT, message));
            }
        }
    }
    let target = match scope {
        PluginScope::Global | PluginScope::Machine => {
            app.plugins.dir_of(&staged.marketplace, &staged.name)
        }
        PluginScope::ProjectLocal => scope::project_local_dir(
            &app.data_dir,
            project.expect("a project scope has a project"),
            &staged.marketplace,
            &staged.name,
        ),
        PluginScope::Project => {
            let folder = match project_folder(app, project.expect("a project scope has a project"))
            {
                Ok(folder) => folder,
                Err(e) => {
                    app.plugins.discard(staged);
                    return Err(e);
                }
            };
            scope::repo_dir(&folder, &staged.name)
        }
    };
    let placed = place(staged.root(), &target);
    let (name, marketplace, source, resolved, command) = (
        staged.name.clone(),
        staged.marketplace.clone(),
        staged.source.clone(),
        staged.resolved.clone(),
        staged.command.clone(),
    );
    app.plugins.discard(staged);
    placed.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // A repo plugin is approved by its content: exactly these bytes run.
    let hash = crate::plugins::content_hash(&target)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let now = openremote_core::now_ms();
    let (plugin, was_global) = {
        let mut store = lock_recovering(&app.store);
        let before = store.installed_plugin(&id).ok().cloned();
        let was_global = before
            .as_ref()
            .is_some_and(|b| b.scope == PluginScope::Global);
        let plugin = InstalledPlugin {
            name,
            marketplace,
            resolved: if scope == PluginScope::Project {
                Some(hash.clone())
            } else {
                resolved
            },
            command,
            version: manifest.version.clone(),
            description: manifest.description.clone(),
            runtime: manifest.runtime,
            powers: manifest.powers.clone(),
            source,
            scope,
            project,
            contributes: manifest.contributes.clone(),
            enabled: before.as_ref().is_none_or(|p| p.enabled),
            installed_at: before.as_ref().map_or(now, |p| p.installed_at),
            updated_at: now,
        };
        // The same plugin moved to another scope leaves the old one.
        if let Some(old) = before.filter(|b| b.scope != scope) {
            let _ = store.remove_installed_plugin(&old.id());
        }
        store
            .put_installed_plugin(plugin.clone())
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        (plugin, was_global)
    };
    // Moved from Global to this machine alone: the other devices let it go.
    if was_global && scope != PluginScope::Global {
        super::global::publish(app, &plugin, String::new(), true).await;
    }
    match scope {
        PluginScope::Global => super::global::publish(app, &plugin, hash, false).await,
        PluginScope::Project => {
            if let Some(project) = project {
                if let Ok(folder) = project_folder(app, project) {
                    let _ = scope::note_in_repo_index(&folder, &plugin);
                }
            }
        }
        _ => {}
    }
    app.plugin_runtime.changed(&id).await;
    Ok(plugin)
}

/// Uninstall: its files go (from the project's folder too, for a Project
/// plugin - the repo then shows the removal for the user to commit), its
/// record and settings go, and a Global plugin goes from every device.
pub async fn remove(app: &Arc<App>, id: &str) -> Result<(), Failure> {
    let plugin = lock_recovering(&app.store)
        .installed_plugin(id)
        .cloned()
        .map_err(|_| (StatusCode::NOT_FOUND, format!("{id} is not installed")))?;
    app.plugin_runtime.processes.stop(id).await;
    if let Some(dir) = app.plugin_runtime.folder(&plugin) {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
        }
    }
    if plugin.scope == PluginScope::Project {
        if let Some(project) = plugin.project {
            if let Ok(folder) = project_folder(app, project) {
                scope::forget_in_repo_index(&folder, &plugin.name);
            }
        }
    }
    lock_recovering(&app.store)
        .remove_installed_plugin(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    app.plugin_runtime.settings.forget(id);
    if plugin.scope == PluginScope::Global {
        super::global::publish(app, &plugin, String::new(), true).await;
    }
    app.plugin_runtime.changed(id).await;
    Ok(())
}

/// A repo plugin read for this machine's approval: the folder the project
/// carries, staged like any other folder.
pub fn project_source(
    app: &App,
    project: &str,
    name: &str,
) -> Result<crate::plugins::StageRequest, Failure> {
    let project =
        ProjectId::parse(project).ok_or((StatusCode::BAD_REQUEST, "bad project id".to_string()))?;
    let folder = project_folder(app, project)?;
    if !crate::plugins::relative_inside(name) || name.contains('/') {
        return Err((StatusCode::BAD_REQUEST, "not a plugin's folder name".into()));
    }
    let dir = scope::repo_dir(&folder, name);
    if !dir.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("the project has no plugin {name}"),
        ));
    }
    Ok(crate::plugins::StageRequest {
        fetch: crate::plugins::Fetch::Folder(dir.clone()),
        marketplace: scope::repo_marketplace(&folder, name)
            .unwrap_or_else(|| openremote_core::LOCAL_MARKETPLACE.to_string()),
        entry_name: Some(name.to_string()),
        entry: None,
        recorded: PluginSource::Folder {
            path: dir.to_string_lossy().into_owned(),
        },
    })
}
