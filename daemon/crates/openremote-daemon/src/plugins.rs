//! The plugin system's foundation (Plugins): what a plugin folder says
//! about itself, staging an install - from a folder, a git repo or an
//! archive - for the user to approve, and the install itself. The six
//! harnesses are built-in plugins; what the user installs lives under
//! `<data dir>/plugins/<name>/`.
//!
//! A plugin folder is Claude Code's own layout (`.claude-plugin/
//! plugin.json`, skills/, agents/, commands/, hooks, `.mcp.json`) plus
//! OpenRemote's part in `openremote.json` beside it. Claude's file is
//! never extended, so one folder is a plugin to both.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;

use openremote_core::{PluginPower, PluginRuntime, PluginSource};
use serde::{Deserialize, Serialize};

/// The `openremote.json` api this daemon speaks.
pub const API_VERSION: u64 = 1;

/// An archive is refused past this size, packed or unpacked.
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

/// Names a plugin cannot take: the routes' own words.
const RESERVED_NAMES: &[&str] = &["stage"];

#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    /// The plugin itself is wrong - its manifest, its name, its powers.
    #[error("{0}")]
    Invalid(String),
    /// Its source could not be read - a missing folder, a failed clone.
    #[error("{0}")]
    Source(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// What a plugin folder says about itself, as the approval screen shows it.
#[derive(Clone, Serialize, Debug)]
pub struct Manifest {
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub runtime: PluginRuntime,
    /// Declared in openremote.json, plus what its parts imply: a process
    /// plugin runs a program; Claude hooks and MCP servers run programs.
    pub powers: Vec<PluginPower>,
    /// The Claude Code parts it carries: skills, agents, commands, hooks, mcp.
    pub claude_parts: Vec<String>,
    /// It runs programs as the user, outside any sandbox - said before the
    /// user approves (a JS or WASM plugin is sandboxed; a program is not).
    pub not_sandboxed: bool,
}

#[derive(Deserialize, Default)]
struct ClaudeManifest {
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    hooks: Option<serde_json::Value>,
    #[serde(rename = "mcpServers")]
    mcp_servers: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct OpenRemoteManifest {
    api: u64,
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    runtime: Option<String>,
    #[serde(default)]
    powers: Vec<String>,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, PluginError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| {
            PluginError::Invalid(format!(
                "{} is not valid: {e}",
                path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("manifest")
            ))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Claude's own rule for a plugin name: kebab-case, short.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn power(word: &str) -> Option<PluginPower> {
    Some(match word {
        "run_programs" => PluginPower::RunPrograms,
        "read_chats" => PluginPower::ReadChats,
        "agent_tools" => PluginPower::AgentTools,
        "network" => PluginPower::Network,
        "microphone" => PluginPower::Microphone,
        _ => return None,
    })
}

/// Read a plugin folder's manifests. `builtin_ids` are the harness ids no
/// installed plugin may take as its name.
pub fn read_manifest(dir: &Path, builtin_ids: &[String]) -> Result<Manifest, PluginError> {
    let claude: Option<ClaudeManifest> =
        read_json(&dir.join(".claude-plugin").join("plugin.json"))?;
    let ours: Option<OpenRemoteManifest> = read_json(&dir.join("openremote.json"))?;
    if claude.is_none() && ours.is_none() {
        return Err(PluginError::Invalid(
            "this is not a plugin: it has neither openremote.json nor .claude-plugin/plugin.json"
                .into(),
        ));
    }
    if let Some(o) = &ours {
        if o.api != API_VERSION {
            return Err(PluginError::Invalid(format!(
                "openremote.json says api {}; this OpenRemote speaks api {API_VERSION}",
                o.api
            )));
        }
    }
    let claude = claude.unwrap_or_default();
    let name = ours
        .as_ref()
        .and_then(|o| o.name.clone())
        .or(claude.name.clone())
        .ok_or_else(|| PluginError::Invalid("the plugin names itself nowhere".into()))?;
    if !valid_name(&name) {
        return Err(PluginError::Invalid(format!(
            "'{name}' is not a plugin name: lowercase letters, digits and dashes, up to 64"
        )));
    }
    if builtin_ids.iter().any(|b| b == &name) || RESERVED_NAMES.contains(&name.as_str()) {
        return Err(PluginError::Invalid(format!(
            "'{name}' is taken by OpenRemote itself"
        )));
    }

    let has_hooks = claude.hooks.is_some() || dir.join("hooks").join("hooks.json").is_file();
    let has_mcp = claude.mcp_servers.is_some() || dir.join(".mcp.json").is_file();
    let mut claude_parts = Vec::new();
    for part in ["skills", "agents", "commands"] {
        if dir.join(part).is_dir() {
            claude_parts.push(part.to_string());
        }
    }
    if has_hooks {
        claude_parts.push("hooks".into());
    }
    if has_mcp {
        claude_parts.push("mcp".into());
    }

    let runtime = match &ours {
        None => PluginRuntime::Content,
        Some(o) => match o.runtime.as_deref() {
            Some("process") => PluginRuntime::Process,
            Some("js") => PluginRuntime::Js,
            Some("wasm") => PluginRuntime::Wasm,
            Some("content") => PluginRuntime::Content,
            Some(other) => {
                return Err(PluginError::Invalid(format!(
                    "openremote.json names runtime '{other}'; this OpenRemote runs process, js, wasm or content"
                )));
            }
            None => {
                return Err(PluginError::Invalid(
                    "openremote.json names no runtime".into(),
                ));
            }
        },
    };

    let mut powers = Vec::new();
    if let Some(o) = &ours {
        for word in &o.powers {
            powers.push(power(word).ok_or_else(|| {
                PluginError::Invalid(format!(
                    "openremote.json asks for '{word}'; the powers are run_programs, read_chats, agent_tools, network and microphone"
                ))
            })?);
        }
    }
    if runtime == PluginRuntime::Process || has_hooks || has_mcp {
        powers.push(PluginPower::RunPrograms);
    }
    powers.sort();
    powers.dedup();
    let not_sandboxed = powers.contains(&PluginPower::RunPrograms)
        && matches!(runtime, PluginRuntime::Process | PluginRuntime::Content);

    Ok(Manifest {
        version: ours
            .as_ref()
            .and_then(|o| o.version.clone())
            .or(claude.version),
        description: ours
            .as_ref()
            .and_then(|o| o.description.clone())
            .or(claude.description),
        name,
        runtime,
        powers,
        claude_parts,
        not_sandboxed,
    })
}

/// Where the user asked to install from.
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceRequest {
    Folder {
        path: String,
    },
    Git {
        url: String,
    },
    /// A .zip or .tar.gz: a path on this machine or an http(s) URL.
    Archive {
        location: String,
    },
}

impl SourceRequest {
    fn recorded(&self) -> PluginSource {
        match self {
            SourceRequest::Folder { path } => PluginSource::Folder { path: path.clone() },
            SourceRequest::Git { url } => PluginSource::Git { url: url.clone() },
            SourceRequest::Archive { location } => PluginSource::Archive {
                location: location.clone(),
            },
        }
    }
}

/// An install fetched and read, waiting for the user's approval.
pub struct Staged {
    dir: PathBuf,
    root: PathBuf,
    pub manifest: Manifest,
    pub source: PluginSource,
}

/// The plugin folders on this machine, and the installs waiting for an
/// answer. A staged install that is never answered is swept with its
/// folder the next time the daemon starts.
pub struct PluginHost {
    root: PathBuf,
    staged: StdMutex<HashMap<String, Staged>>,
}

impl PluginHost {
    pub fn new(data_dir: &Path) -> Self {
        let root = data_dir.join("plugins");
        let _ = std::fs::remove_dir_all(root.join(".staging"));
        let _ = std::fs::remove_dir_all(root.join(".trash"));
        Self {
            root,
            staged: StdMutex::new(HashMap::new()),
        }
    }

    pub fn dir_of(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// Fetch and read a plugin into a staging folder. Nothing is installed
    /// until `install` runs on the user's approval.
    pub async fn stage(
        &self,
        source: SourceRequest,
        builtin_ids: Vec<String>,
    ) -> Result<(String, Manifest), PluginError> {
        let id = uuid::Uuid::new_v4().to_string();
        let dir = self.root.join(".staging").join(&id);
        let fetched = dir.join("plugin");
        std::fs::create_dir_all(&dir)?;
        let outcome = async {
            match &source {
                SourceRequest::Folder { path } => {
                    let from = PathBuf::from(path);
                    if !from.is_dir() {
                        return Err(PluginError::Source(format!("{path} is not a folder")));
                    }
                    let to = fetched.clone();
                    tokio::task::spawn_blocking(move || copy_tree(&from, &to))
                        .await
                        .map_err(|e| PluginError::Source(e.to_string()))??;
                }
                SourceRequest::Git { url } => git_clone(url, &fetched).await?,
                SourceRequest::Archive { location } => {
                    let bytes = read_archive(location).await?;
                    let to = fetched.clone();
                    tokio::task::spawn_blocking(move || unpack(&bytes, &to))
                        .await
                        .map_err(|e| PluginError::Source(e.to_string()))??;
                }
            }
            let root = plugin_root(&fetched);
            let manifest = read_manifest(&root, &builtin_ids)?;
            Ok((root, manifest))
        }
        .await;
        match outcome {
            Ok((root, manifest)) => {
                self.staged.lock().expect("staged lock").insert(
                    id.clone(),
                    Staged {
                        dir,
                        root,
                        manifest: manifest.clone(),
                        source: source.recorded(),
                    },
                );
                Ok((id, manifest))
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                Err(e)
            }
        }
    }

    pub fn take_staged(&self, id: &str) -> Option<Staged> {
        self.staged.lock().expect("staged lock").remove(id)
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.take_staged(id) {
            Some(staged) => {
                let _ = std::fs::remove_dir_all(&staged.dir);
                true
            }
            None => false,
        }
    }

    /// Move an approved install into place. An installed plugin of the
    /// same name is replaced whole - an update never mixes two versions.
    pub fn install(&self, staged: Staged) -> Result<(), PluginError> {
        let target = self.dir_of(&staged.manifest.name);
        let result = (|| {
            if target.exists() {
                let trash = self
                    .root
                    .join(".trash")
                    .join(uuid::Uuid::new_v4().to_string());
                std::fs::create_dir_all(trash.parent().expect("trash parent"))?;
                std::fs::rename(&target, &trash)?;
                std::fs::rename(&staged.root, &target)?;
                let _ = std::fs::remove_dir_all(&trash);
            } else {
                std::fs::create_dir_all(&self.root)?;
                std::fs::rename(&staged.root, &target)?;
            }
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(&staged.dir);
        result
    }

    pub fn uninstall(&self, name: &str) -> Result<(), PluginError> {
        match std::fs::remove_dir_all(self.dir_of(name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// A plugin is the fetched folder itself, or - the common archive and
/// repo shape - the one folder inside it that holds the manifests.
fn plugin_root(fetched: &Path) -> PathBuf {
    let has_manifest = |d: &Path| {
        d.join("openremote.json").is_file()
            || d.join(".claude-plugin").join("plugin.json").is_file()
    };
    if has_manifest(fetched) {
        return fetched.to_path_buf();
    }
    let dirs: Vec<PathBuf> = std::fs::read_dir(fetched)
        .map(|it| {
            it.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default();
    match dirs.as_slice() {
        [only] if has_manifest(only) => only.clone(),
        _ => fetched.to_path_buf(),
    }
}

/// Copy a folder, leaving out its git history and anything that is not a
/// plain file or folder (a link could reach outside the plugin).
fn copy_tree(from: &Path, to: &Path) -> Result<(), PluginError> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        if kind.is_dir() {
            copy_tree(&entry.path(), &to.join(&name))?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}

async fn git_clone(url: &str, to: &Path) -> Result<(), PluginError> {
    let output = tokio::process::Command::new("git")
        .args(["clone", "--depth", "1", "--quiet", "--"])
        .arg(url)
        .arg(to)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| {
            PluginError::Source(if e.kind() == std::io::ErrorKind::NotFound {
                "installing from git needs git on this machine".into()
            } else {
                format!("git could not start: {e}")
            })
        })?;
    if !output.status.success() {
        let words = String::from_utf8_lossy(&output.stderr);
        return Err(PluginError::Source(format!(
            "git could not clone {url}: {}",
            words.trim().lines().last().unwrap_or("no reason given")
        )));
    }
    let _ = std::fs::remove_dir_all(to.join(".git"));
    Ok(())
}

/// An archive's bytes: from a path on this machine, or downloaded over
/// http(s), following a few redirects (release and repo download links
/// redirect once or twice).
async fn read_archive(location: &str) -> Result<Vec<u8>, PluginError> {
    if !(location.starts_with("https://") || location.starts_with("http://")) {
        let meta = std::fs::metadata(location)
            .map_err(|_| PluginError::Source(format!("{location} is not a file")))?;
        if meta.len() > MAX_ARCHIVE_BYTES {
            return Err(PluginError::Source("the archive is too large".into()));
        }
        return Ok(std::fs::read(location)?);
    }
    let http = openremote_cloud::https::Http::new();
    let mut url = location.to_string();
    for _ in 0..5 {
        let response = http
            .request("GET", &url, &[("user-agent", "OpenRemote")], None)
            .await
            .map_err(|e| PluginError::Source(format!("could not download {url}: {e}")))?;
        match response.status {
            200 => {
                if response.body.len() as u64 > MAX_ARCHIVE_BYTES {
                    return Err(PluginError::Source("the archive is too large".into()));
                }
                return Ok(response.body);
            }
            301 | 302 | 303 | 307 | 308 => {
                url = response
                    .headers
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .map(String::from)
                    .ok_or_else(|| PluginError::Source(format!("{url} redirects nowhere")))?;
            }
            status => {
                return Err(PluginError::Source(format!("{url} answered {status}")));
            }
        }
    }
    Err(PluginError::Source(format!(
        "{location} redirects too many times"
    )))
}

/// Unpack a .zip or .tar.gz into `to`, refusing any entry that would land
/// outside it and any archive that unpacks past the size limit.
fn unpack(bytes: &[u8], to: &Path) -> Result<(), PluginError> {
    std::fs::create_dir_all(to)?;
    let mut total: u64 = 0;
    if bytes.starts_with(b"PK\x03\x04") {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|e| PluginError::Source(format!("the zip is unreadable: {e}")))?;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| PluginError::Source(format!("the zip is unreadable: {e}")))?;
            let Some(relative) = entry.enclosed_name() else {
                return Err(PluginError::Invalid(
                    "the zip reaches outside its folder".into(),
                ));
            };
            let out = to.join(relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&out)?;
                continue;
            }
            total += entry.size();
            if total > MAX_ARCHIVE_BYTES {
                return Err(PluginError::Source("the archive unpacks too large".into()));
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut file = std::fs::File::create(&out)?;
            std::io::copy(&mut (&mut entry).take(MAX_ARCHIVE_BYTES), &mut file)?;
        }
        return Ok(());
    }
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bytes)));
        for entry in archive
            .entries()
            .map_err(|e| PluginError::Source(format!("the archive is unreadable: {e}")))?
        {
            let mut entry = entry
                .map_err(|e| PluginError::Source(format!("the archive is unreadable: {e}")))?;
            let kind = entry.header().entry_type();
            if !(kind.is_file() || kind.is_dir()) {
                continue;
            }
            total += entry.header().size().unwrap_or(0);
            if total > MAX_ARCHIVE_BYTES {
                return Err(PluginError::Source("the archive unpacks too large".into()));
            }
            // unpack_in refuses a path that climbs out of `to`.
            if !entry
                .unpack_in(to)
                .map_err(|e| PluginError::Source(format!("the archive is unreadable: {e}")))?
            {
                return Err(PluginError::Invalid(
                    "the archive reaches outside its folder".into(),
                ));
            }
        }
        return Ok(());
    }
    Err(PluginError::Invalid(
        "an archive is a .zip or a .tar.gz".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, body) in files {
            let p = dir.path().join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        dir
    }

    fn builtins() -> Vec<String> {
        vec!["claude".into(), "codex".into()]
    }

    #[test]
    fn a_process_plugin_runs_programs_and_says_it_is_not_sandboxed() {
        let dir = folder(&[(
            "openremote.json",
            r#"{"api": 1, "name": "toy", "version": "1.0.0", "runtime": "process", "powers": ["network"]}"#,
        )]);
        let m = read_manifest(dir.path(), &builtins()).unwrap();
        assert_eq!(m.runtime, PluginRuntime::Process);
        assert_eq!(
            m.powers,
            vec![PluginPower::RunPrograms, PluginPower::Network]
        );
        assert!(m.not_sandboxed);
    }

    #[test]
    fn a_claude_plugin_alone_is_content_and_its_mcp_runs_programs() {
        let dir = folder(&[
            (
                ".claude-plugin/plugin.json",
                r#"{"name": "docs", "version": "2.1.0"}"#,
            ),
            ("skills/search/SKILL.md", "# search"),
            (".mcp.json", "{}"),
        ]);
        let m = read_manifest(dir.path(), &builtins()).unwrap();
        assert_eq!(m.runtime, PluginRuntime::Content);
        assert_eq!(m.claude_parts, vec!["skills", "mcp"]);
        assert_eq!(m.powers, vec![PluginPower::RunPrograms]);
        assert!(m.not_sandboxed);
        assert_eq!(m.version.as_deref(), Some("2.1.0"));
    }

    #[test]
    fn a_js_plugin_is_sandboxed_even_with_the_microphone() {
        let dir = folder(&[(
            "openremote.json",
            r#"{"api": 1, "name": "dictation", "runtime": "js", "powers": ["microphone"]}"#,
        )]);
        let m = read_manifest(dir.path(), &builtins()).unwrap();
        assert_eq!(m.powers, vec![PluginPower::Microphone]);
        assert!(!m.not_sandboxed);
    }

    #[test]
    fn wrong_manifests_say_what_is_wrong() {
        let cases = [
            (r#"{"api": 2, "name": "x", "runtime": "js"}"#, "api 2"),
            (
                r#"{"api": 1, "name": "Bad Name", "runtime": "js"}"#,
                "not a plugin name",
            ),
            (
                r#"{"api": 1, "name": "claude", "runtime": "js"}"#,
                "taken by OpenRemote",
            ),
            (
                r#"{"api": 1, "name": "x", "runtime": "lua"}"#,
                "runtime 'lua'",
            ),
            (r#"{"api": 1, "name": "x"}"#, "no runtime"),
            (
                r#"{"api": 1, "name": "x", "runtime": "js", "powers": ["root"]}"#,
                "'root'",
            ),
        ];
        for (json, says) in cases {
            let dir = folder(&[("openremote.json", json)]);
            let err = read_manifest(dir.path(), &builtins())
                .unwrap_err()
                .to_string();
            assert!(err.contains(says), "{json}: {err}");
        }
        let empty = folder(&[("README.md", "hi")]);
        assert!(
            read_manifest(empty.path(), &builtins())
                .unwrap_err()
                .to_string()
                .contains("not a plugin")
        );
    }

    #[test]
    fn an_archive_that_climbs_out_is_refused() {
        let mut bytes = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(Cursor::new(&mut bytes));
            zip.start_file("../escape.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut zip, b"nope").unwrap();
            zip.finish().unwrap();
        }
        let to = tempfile::tempdir().unwrap();
        let err = unpack(&bytes, to.path()).unwrap_err().to_string();
        assert!(err.contains("outside"), "{err}");
    }
}
