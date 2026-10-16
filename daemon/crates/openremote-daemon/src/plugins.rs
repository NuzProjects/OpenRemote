//! The plugin system (Plugins): what a plugin folder says about itself,
//! fetching one - from a folder, a git repo, an archive, or the source a
//! marketplace entry names - into a staging folder for the user to
//! approve, and the install itself. The six harnesses are built-in
//! plugins; what the user installs lives under
//! `<data dir>/plugins/<marketplace>/<name>/`, a direct install under the
//! marketplace name `local`.
//!
//! A plugin folder is Claude Code's own layout (`.claude-plugin/
//! plugin.json`, skills/, agents/, commands/, hooks, `.mcp.json`) plus
//! OpenRemote's part in `openremote.json` beside it, so one folder is a
//! plugin to both. OpenRemote writes Claude's file only where Claude Code
//! itself would compute one - from a marketplace entry (Claude's rule:
//! with no plugin.json, the entry is the manifest) - or a bare one for a
//! folder that carries Claude parts without it, so `--plugin-dir` reads
//! the folder as one plugin and never as a folder of plugins. A plugin
//! written in the sibling layout `adapt` reads is rewritten into Claude's
//! at install.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use openremote_core::{
    ApprovedCommand, InstalledPlugin, LOCAL_MARKETPLACE, PluginPower, PluginRuntime, PluginSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;

/// The `openremote.json` api this daemon speaks.
pub const API_VERSION: u64 = 1;

/// An archive is refused past this size, packed or unpacked.
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

/// A folder copied in - a direct folder, a command's output - is refused
/// past this many files and folders (and past the archive size).
const MAX_ENTRIES: usize = 20_000;

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
    /// What it runs, in a line: its program and arguments, or its file.
    pub entry: Option<String>,
    /// What it adds to OpenRemote: harnesses, agent tools, composer
    /// inputs, views, settings.
    pub contributes: openremote_core::PluginContributions,
    /// For a plugin written in another layout: what the install rewrites
    /// so Claude Code runs it, and what it leaves out and why.
    pub adapted: Vec<String>,
    pub left_out: Vec<String>,
}

impl Manifest {
    /// Why nothing of the plugin would run here: every part it carries was
    /// left out. None while anything is left to install.
    pub fn nothing_left(&self) -> Option<String> {
        (self.runtime == PluginRuntime::Content
            && self.claude_parts.is_empty()
            && !self.left_out.is_empty())
        .then(|| format!("nothing in it can run here. {}", self.left_out.join(". ")))
    }
}

#[derive(Deserialize, Default)]
struct ClaudeManifest {
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    /// The sibling layout's description per language; the app speaks
    /// English, so its `en` comes before the plain field.
    description_i18n: Option<Value>,
    skills: Option<Value>,
    commands: Option<Value>,
    agents: Option<Value>,
    hooks: Option<Value>,
    #[serde(rename = "mcpServers")]
    mcp_servers: Option<Value>,
    #[serde(rename = "lspServers")]
    lsp_servers: Option<Value>,
}

impl ClaudeManifest {
    /// This manifest with its gaps filled from the plugin's manifest in the
    /// sibling layout: Claude's says it where both do. That layout runs no
    /// language servers, so it adds none.
    fn or(self, other: Option<ClaudeManifest>) -> ClaudeManifest {
        let Some(other) = other else {
            return self;
        };
        ClaudeManifest {
            name: self.name.or(other.name),
            version: self.version.or(other.version),
            description: self.description.or(other.description),
            description_i18n: self.description_i18n.or(other.description_i18n),
            skills: self.skills.or(other.skills),
            commands: self.commands.or(other.commands),
            agents: self.agents.or(other.agents),
            hooks: self.hooks.or(other.hooks),
            mcp_servers: self.mcp_servers.or(other.mcp_servers),
            lsp_servers: self.lsp_servers,
        }
    }

    fn english_description(&self) -> Option<String> {
        self.description_i18n
            .as_ref()
            .and_then(|by_language| by_language.get("en"))
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| self.description.clone())
    }
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

pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
) -> Result<Option<T>, PluginError> {
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

pub fn power(word: &str) -> Option<PluginPower> {
    Some(match word {
        "run_programs" => PluginPower::RunPrograms,
        "read_chats" => PluginPower::ReadChats,
        "agent_tools" => PluginPower::AgentTools,
        "network" => PluginPower::Network,
        "microphone" => PluginPower::Microphone,
        _ => return None,
    })
}

/// openremote.json's runtime word.
pub fn runtime(word: &str) -> Option<PluginRuntime> {
    Some(match word {
        "process" => PluginRuntime::Process,
        "js" => PluginRuntime::Js,
        "wasm" => PluginRuntime::Wasm,
        "content" => PluginRuntime::Content,
        _ => return None,
    })
}

/// Read a plugin folder's manifests. `builtin_ids` are the harness ids no
/// installed plugin may take as its name.
pub fn read_manifest(dir: &Path, builtin_ids: &[String]) -> Result<Manifest, PluginError> {
    let claude: Option<ClaudeManifest> =
        read_json(&dir.join(".claude-plugin").join("plugin.json"))?;
    // A plugin in the sibling layout carries its own manifest; where
    // Claude's says nothing (or there is none), that one speaks.
    let alternate: Option<ClaudeManifest> =
        read_json(&dir.join(crate::adapt::MANIFEST_DIR).join("plugin.json"))?;
    let ours: Option<OpenRemoteManifest> = read_json(&dir.join("openremote.json"))?;
    if claude.is_none() && alternate.is_none() && ours.is_none() && claude_dirs(dir).is_empty() {
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
    // What the install's rewrite of such a plugin leaves of it: a server or
    // hook it has to leave out is not one the plugin brings here.
    let plan = match &alternate {
        Some(_) => crate::adapt::plan(dir, None, None)?,
        None => None,
    };
    let claude = claude.unwrap_or_default().or(alternate);
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

    let survives = |kept: Option<bool>| kept != Some(false);
    let has_hooks = (claude.hooks.is_some() || dir.join("hooks").join("hooks.json").is_file())
        && survives(plan.as_ref().and_then(|p| p.hooks_kept));
    let has_mcp = (claude.mcp_servers.is_some() || dir.join(".mcp.json").is_file())
        && survives(plan.as_ref().and_then(|p| p.mcp_kept));
    let has_lsp = claude.lsp_servers.is_some() || dir.join(".lsp.json").is_file();
    // Parts in folders of the plugin's own choosing count as much as the
    // default folders.
    let declared = |part: &str| match part {
        "skills" => claude.skills.is_some(),
        "agents" => claude.agents.is_some(),
        _ => claude.commands.is_some(),
    };
    let mut claude_parts: Vec<String> = ["skills", "agents", "commands"]
        .into_iter()
        .filter(|part| dir.join(part).is_dir() || declared(part))
        .map(String::from)
        .collect();
    if has_hooks {
        claude_parts.push("hooks".into());
    }
    if has_mcp {
        claude_parts.push("mcp".into());
    }

    let runtime = match &ours {
        None => PluginRuntime::Content,
        Some(o) => match o.runtime.as_deref() {
            Some(word) => runtime(word).ok_or_else(|| {
                PluginError::Invalid(format!(
                    "openremote.json names runtime '{word}'; this OpenRemote runs process, js, wasm or content"
                ))
            })?,
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
    if runtime == PluginRuntime::Process || has_hooks || has_mcp || has_lsp {
        powers.push(PluginPower::RunPrograms);
    }
    // What it runs and adds (openremote.json's entry and contributes).
    let section = match read_json::<Value>(&dir.join("openremote.json"))? {
        Some(raw) => {
            crate::plugin_runtime::manifest::read_section(&raw, dir, &name, runtime, builtin_ids)?
        }
        None => Default::default(),
    };
    powers.extend(section.implied.iter().copied());
    powers.sort();
    powers.dedup();
    let not_sandboxed = powers.contains(&PluginPower::RunPrograms)
        && matches!(runtime, PluginRuntime::Process | PluginRuntime::Content);
    let description = ours
        .as_ref()
        .and_then(|o| o.description.clone())
        .or_else(|| claude.english_description());

    Ok(Manifest {
        version: ours
            .as_ref()
            .and_then(|o| o.version.clone())
            .or(claude.version),
        description,
        name,
        runtime,
        powers,
        claude_parts,
        not_sandboxed,
        entry: section.entry.as_ref().map(|e| e.describe()),
        contributes: section.contributes,
        adapted: plan
            .as_ref()
            .map(|p| p.notes.adapted.clone())
            .unwrap_or_default(),
        left_out: plan.map(|p| p.notes.left_out).unwrap_or_default(),
    })
}

/// The Claude part folders a plugin carries.
fn claude_dirs(dir: &Path) -> Vec<String> {
    ["skills", "agents", "commands"]
        .into_iter()
        .filter(|part| dir.join(part).is_dir())
        .map(String::from)
        .collect()
}

/// Where an installed plugin's folder lives.
pub fn plugin_dir(data_dir: &Path, marketplace: &str, name: &str) -> PathBuf {
    data_dir.join("plugins").join(marketplace).join(name)
}

/// What a plugin offers a composer, read from its own folder the way
/// Claude Code names it: skills and command files as `plugin:name`,
/// agents as `plugin:name`, and its MCP servers by their keys.
#[derive(Default, Debug, PartialEq, Eq)]
pub struct PluginParts {
    pub commands: Vec<openremote_harness::CommandDescriptor>,
    /// Which of `commands` are skills (skills/<name>/SKILL.md).
    pub skills: Vec<String>,
    pub agents: Vec<openremote_harness::AgentDescriptor>,
    pub mcp_servers: Vec<String>,
}

/// Read a plugin folder's commands, agents and MCP server names. `prefix`
/// is the name its commands carry (the manifest's name).
pub fn plugin_parts(dir: &Path, prefix: &str) -> PluginParts {
    let mut parts = PluginParts::default();
    // skills/<name>/SKILL.md: one command each, unless the skill is for
    // the model alone (`user-invocable: false`).
    if let Ok(entries) = std::fs::read_dir(dir.join("skills")) {
        let mut found: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        found.sort();
        for skill in found {
            let Ok(text) = std::fs::read_to_string(skill.join("SKILL.md")) else {
                continue;
            };
            let meta = frontmatter(&text);
            if meta.get("user-invocable").map(String::as_str) == Some("false") {
                continue;
            }
            let name = meta.get("name").cloned().unwrap_or_else(|| {
                skill
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
            parts.skills.push(format!("{prefix}:{name}"));
            parts.commands.push(openremote_harness::CommandDescriptor {
                name: format!("{prefix}:{name}"),
                description: meta.get("description").cloned(),
                argument_hint: meta.get("argument-hint").cloned(),
                aliases: Vec::new(),
            });
        }
    }
    // commands/<name>.md, a folder deeper joined with ':' as Claude does.
    let mut files = Vec::new();
    markdown_files(&dir.join("commands"), &mut files);
    for file in files {
        let Ok(relative) = file.strip_prefix(dir.join("commands")) else {
            continue;
        };
        let name = relative
            .with_extension("")
            .to_string_lossy()
            .replace(['\\', '/'], ":");
        let meta = std::fs::read_to_string(&file)
            .map(|t| frontmatter(&t))
            .unwrap_or_default();
        parts.commands.push(openremote_harness::CommandDescriptor {
            name: format!("{prefix}:{name}"),
            description: meta.get("description").cloned(),
            argument_hint: meta.get("argument-hint").cloned(),
            aliases: Vec::new(),
        });
    }
    let mut agents = Vec::new();
    markdown_files(&dir.join("agents"), &mut agents);
    for file in agents {
        let meta = std::fs::read_to_string(&file)
            .map(|t| frontmatter(&t))
            .unwrap_or_default();
        let name = meta.get("name").cloned().unwrap_or_else(|| {
            file.file_stem()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        parts.agents.push(openremote_harness::AgentDescriptor {
            name: format!("{prefix}:{name}"),
            description: meta.get("description").cloned(),
        });
    }
    // .mcp.json (Claude's own file: `mcpServers` or the map itself) and
    // plugin.json's `mcpServers`.
    let mut servers = std::collections::BTreeSet::new();
    for (file, pointer) in [
        (dir.join(".mcp.json"), ""),
        (
            dir.join(".claude-plugin").join("plugin.json"),
            "/mcpServers",
        ),
    ] {
        let Ok(Some(value)) = read_json::<Value>(&file) else {
            continue;
        };
        let map = if pointer.is_empty() {
            value.get("mcpServers").unwrap_or(&value)
        } else {
            match value.pointer(pointer) {
                Some(v) => v,
                None => continue,
            }
        };
        if let Some(map) = map.as_object() {
            servers.extend(map.keys().cloned());
        }
    }
    parts.mcp_servers = servers.into_iter().collect();
    parts
}

/// Every `.md` under `dir`, in order.
fn markdown_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            markdown_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "md") {
            out.push(path);
        }
    }
}

/// A markdown file's YAML frontmatter, read for the plain `key: value`
/// lines (and `>`/`|` blocks) the skill and command formats use.
pub fn frontmatter(text: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return out;
    }
    let body: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let mut i = 0;
    while i < body.len() {
        let line = body[i];
        i += 1;
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        let value = if value == ">" || value == "|" || value == ">-" || value == "|-" {
            let mut block = Vec::new();
            while i < body.len() && (body[i].starts_with(' ') || body[i].trim().is_empty()) {
                block.push(body[i].trim());
                i += 1;
            }
            block.join(if value.starts_with('|') { "\n" } else { " " })
        } else {
            value.trim_matches('"').trim_matches('\'').to_string()
        };
        out.insert(key.trim().to_string(), value.trim().to_string());
    }
    out
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
    /// An entry of an added marketplace, by names. A `command` entry runs
    /// only once `approve_command` repeats the exact command the user was
    /// shown.
    Marketplace {
        marketplace: String,
        plugin: String,
        #[serde(default)]
        approve_command: Option<String>,
    },
    /// A plugin a registered project's repo carries
    /// (`.openremote/plugins/<name>`), read for this machine's approval.
    Project {
        project: String,
        name: String,
    },
}

impl SourceRequest {
    /// A direct install's plan. None for a marketplace entry, which is
    /// resolved against its catalog first.
    pub fn direct(&self) -> Option<StageRequest> {
        let (fetch, recorded) = match self {
            SourceRequest::Folder { path } => (
                Fetch::Folder(PathBuf::from(path)),
                PluginSource::Folder { path: path.clone() },
            ),
            SourceRequest::Git { url } => (
                Fetch::Git {
                    url: url.clone(),
                    reference: None,
                    sha: None,
                    subdir: None,
                },
                PluginSource::Git { url: url.clone() },
            ),
            SourceRequest::Archive { location } => (
                Fetch::Archive {
                    location: location.clone(),
                    sha256: None,
                    path: None,
                },
                PluginSource::Archive {
                    location: location.clone(),
                },
            ),
            SourceRequest::Marketplace { .. } | SourceRequest::Project { .. } => return None,
        };
        Some(StageRequest {
            fetch,
            marketplace: LOCAL_MARKETPLACE.to_string(),
            entry_name: None,
            entry: None,
            recorded,
        })
    }
}

/// What to fetch: a direct source, or what a marketplace entry names.
#[derive(Clone, Debug)]
pub enum Fetch {
    /// Copied in.
    Folder(PathBuf),
    /// Cloned at depth one, at a pinned commit or ref when there is one;
    /// `subdir` checks out that one folder (a plugin inside a monorepo).
    Git {
        url: String,
        reference: Option<String>,
        sha: Option<String>,
        subdir: Option<String>,
    },
    /// `path`: the one folder inside the archive that is the plugin; only
    /// it is unpacked.
    Archive {
        location: String,
        sha256: Option<String>,
        path: Option<String>,
    },
    /// Straight from the registry over https - never through an npm
    /// client, never running a package's scripts.
    Npm {
        package: String,
        version: Option<String>,
        registry: Option<String>,
    },
    /// Run the command the user approved; it prints the plugin folder.
    Command(ApprovedCommand),
}

/// An install to stage: what to fetch, and what the plugin will be called.
pub struct StageRequest {
    pub fetch: Fetch,
    pub marketplace: String,
    /// The marketplace entry's name - the id's first half. None for a
    /// direct install: the manifest names it.
    pub entry_name: Option<String>,
    /// The marketplace entry, for a fetched folder with no plugin.json
    /// (the entry is the manifest) or one the entry adds components to.
    pub entry: Option<Value>,
    pub recorded: PluginSource,
}

/// An install fetched and read, waiting for the user's approval.
pub struct Staged {
    dir: PathBuf,
    root: PathBuf,
    pub manifest: Manifest,
    pub name: String,
    pub marketplace: String,
    pub source: PluginSource,
    pub resolved: Option<String>,
    pub command: Option<ApprovedCommand>,
}

impl Staged {
    pub fn id(&self) -> String {
        format!("{}@{}", self.name, self.marketplace)
    }

    /// The fetched plugin folder, before it is placed.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// The plugin folders on this machine, and the installs waiting for an
/// answer. A staged install that is never answered is swept with its
/// folder the next time the daemon starts.
pub struct PluginHost {
    data_dir: PathBuf,
    root: PathBuf,
    staged: StdMutex<HashMap<String, Staged>>,
}

impl PluginHost {
    pub fn new(data_dir: &Path) -> Self {
        let root = data_dir.join("plugins");
        let _ = std::fs::remove_dir_all(root.join(".staging"));
        let _ = std::fs::remove_dir_all(root.join(".trash"));
        file_flat_installs_under_local(&root);
        Self {
            data_dir: data_dir.to_path_buf(),
            root,
            staged: StdMutex::new(HashMap::new()),
        }
    }

    pub fn dir_of(&self, marketplace: &str, name: &str) -> PathBuf {
        plugin_dir(&self.data_dir, marketplace, name)
    }

    /// Fetch and read a plugin into a staging folder. Nothing is installed
    /// until `install` runs on the user's approval.
    pub async fn stage(
        &self,
        request: StageRequest,
        builtin_ids: Vec<String>,
    ) -> Result<(String, Manifest, String), PluginError> {
        let id = uuid::Uuid::new_v4().to_string();
        let dir = self.root.join(".staging").join(&id);
        let fetched = dir.join("plugin");
        std::fs::create_dir_all(&dir)?;
        let outcome = async {
            let resolved = fetch(&request.fetch, &fetched).await?;
            let root = match &request.fetch {
                Fetch::Git {
                    subdir: Some(sub), ..
                } => {
                    let root = fetched.join(sub);
                    if !root.is_dir() {
                        return Err(PluginError::Source(format!(
                            "the repository has no folder {sub}"
                        )));
                    }
                    root
                }
                _ => plugin_root(&fetched),
            };
            if matches!(request.fetch, Fetch::Npm { .. }) {
                install_node_packages(&root).await?;
            }
            // A plugin in the sibling layout is rewritten into Claude's
            // first, so the entry and the review both read what Claude
            // Code will run.
            let adapted =
                crate::adapt::adapt(&root, request.entry_name.as_deref(), &request.marketplace)?;
            if let Some(entry) = &request.entry {
                apply_entry(&root, entry)?;
            }
            let mut manifest = read_manifest(&root, &builtin_ids)?;
            if let Some(notes) = adapted {
                manifest.adapted = notes.adapted;
                manifest.left_out = notes.left_out;
            }
            if let Some(why) = manifest.nothing_left() {
                return Err(PluginError::Invalid(why));
            }
            crate::plugin_runtime::check_staged(&root, &manifest)?;
            write_bare_claude_manifest(&root, &manifest)?;
            Ok((root, manifest, resolved))
        }
        .await;
        match outcome {
            Ok((root, manifest, resolved)) => {
                let name = request
                    .entry_name
                    .clone()
                    .unwrap_or_else(|| manifest.name.clone());
                let command = match &request.fetch {
                    Fetch::Command(approved) => Some(approved.clone()),
                    _ => None,
                };
                self.staged.lock().expect("staged lock").insert(
                    id.clone(),
                    Staged {
                        dir,
                        root,
                        manifest: manifest.clone(),
                        name: name.clone(),
                        marketplace: request.marketplace,
                        source: request.recorded,
                        resolved,
                        command,
                    },
                );
                Ok((id, manifest, name))
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
    /// same id is replaced whole - an update never mixes two versions.
    pub fn install(&self, staged: Staged) -> Result<(), PluginError> {
        let target = self.dir_of(&staged.marketplace, &staged.name);
        let result = swap_in(&self.root, &staged.root, &target);
        let _ = std::fs::remove_dir_all(&staged.dir);
        result
    }

    /// A staged install's leftovers, once its folder was placed elsewhere
    /// (a project's own folder).
    pub fn discard(&self, staged: Staged) {
        let _ = std::fs::remove_dir_all(&staged.dir);
    }

    pub fn uninstall(&self, marketplace: &str, name: &str) -> Result<(), PluginError> {
        match std::fs::remove_dir_all(self.dir_of(marketplace, name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Put `from` at `target`, replacing what is there whole: the old folder
/// moves aside first, so a failure never leaves half of each.
pub(crate) fn swap_in(plugins_root: &Path, from: &Path, target: &Path) -> Result<(), PluginError> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if target.exists() {
        let trash = plugins_root
            .join(".trash")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(trash.parent().expect("trash parent"))?;
        std::fs::rename(target, &trash)?;
        std::fs::rename(from, target)?;
        let _ = std::fs::remove_dir_all(&trash);
    } else {
        std::fs::rename(from, target)?;
    }
    Ok(())
}

/// The first plugin builds put a plugin straight under `plugins/<name>`;
/// they are direct installs, so they move under `plugins/local/`. A
/// marketplace's folder never has a manifest at its top, a plugin's does.
fn file_flat_installs_under_local(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') || !path.is_dir() {
            continue;
        }
        if has_manifest(&path) {
            let target = root.join(LOCAL_MARKETPLACE).join(&name);
            if !target.exists() {
                let _ = std::fs::create_dir_all(root.join(LOCAL_MARKETPLACE));
                let _ = std::fs::rename(&path, &target);
            }
        }
    }
}

fn has_manifest(dir: &Path) -> bool {
    dir.join("openremote.json").is_file()
        || dir.join(".claude-plugin").join("plugin.json").is_file()
        || dir
            .join(crate::adapt::MANIFEST_DIR)
            .join("plugin.json")
            .is_file()
}

/// A plugin is the fetched folder itself, or - the common archive and
/// repo shape - the one folder inside it that holds the manifests.
fn plugin_root(fetched: &Path) -> PathBuf {
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

/// Fetch into `to`; what exactly arrived (a commit, a digest, a version,
/// a content hash) is what an update compares against.
async fn fetch(fetch: &Fetch, to: &Path) -> Result<Option<String>, PluginError> {
    match fetch {
        Fetch::Folder(from) => {
            if !from.is_dir() {
                return Err(PluginError::Source(format!(
                    "{} is not a folder",
                    from.display()
                )));
            }
            copy_in(from.clone(), to.to_path_buf()).await?;
            Ok(Some(content_hash(to)?))
        }
        Fetch::Git {
            url,
            reference,
            sha,
            subdir,
        } => git_fetch(
            url,
            reference.as_deref(),
            sha.as_deref(),
            subdir.as_deref(),
            to,
        )
        .await
        .map(Some),
        Fetch::Archive {
            location,
            sha256,
            path,
        } => {
            let bytes = read_archive(location).await?;
            let digest = hex(&sha2::Sha256::digest(&bytes));
            if let Some(want) = sha256 {
                if !digest.eq_ignore_ascii_case(want) {
                    return Err(PluginError::Source(format!(
                        "the archive's sha256 is {digest}, but its entry pins {want} - refusing a changed download"
                    )));
                }
            }
            let to = to.to_path_buf();
            let inner = path.clone();
            tokio::task::spawn_blocking(move || unpack_within(&bytes, &to, inner.as_deref()))
                .await
                .map_err(|e| PluginError::Source(e.to_string()))??;
            Ok(Some(digest))
        }
        Fetch::Npm {
            package,
            version,
            registry,
        } => npm_fetch(package, version.as_deref(), registry.as_deref(), to)
            .await
            .map(Some),
        Fetch::Command(approved) => {
            let printed = run_command(approved).await?;
            copy_in(printed, to.to_path_buf()).await?;
            Ok(Some(content_hash(to)?))
        }
    }
}

async fn copy_in(from: PathBuf, to: PathBuf) -> Result<(), PluginError> {
    tokio::task::spawn_blocking(move || {
        let mut budget = CopyBudget::default();
        copy_tree(&from, &to, &mut budget)
    })
    .await
    .map_err(|e| PluginError::Source(e.to_string()))?
}

#[derive(Default)]
struct CopyBudget {
    entries: usize,
    bytes: u64,
}

/// Copy a folder, leaving out its git history and anything that is not a
/// plain file or folder (a link could reach outside the plugin), within
/// the size limits.
fn copy_tree(from: &Path, to: &Path, budget: &mut CopyBudget) -> Result<(), PluginError> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        budget.entries += 1;
        if budget.entries > MAX_ENTRIES {
            return Err(PluginError::Source(format!(
                "the folder has more than {MAX_ENTRIES} files and folders"
            )));
        }
        if kind.is_dir() {
            copy_tree(&entry.path(), &to.join(&name), budget)?;
        } else if kind.is_file() {
            budget.bytes += entry.metadata()?.len();
            if budget.bytes > MAX_ARCHIVE_BYTES {
                return Err(PluginError::Source("the folder is too large".into()));
            }
            std::fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}

/// A folder's content as one digest: every plain file's path and bytes,
/// in order, git history and links left out (as copying leaves them out).
pub fn content_hash(dir: &Path) -> Result<String, PluginError> {
    fn walk(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if entry.file_name() == ".git" {
                continue;
            }
            if kind.is_dir() {
                walk(&entry.path(), files)?;
            } else if kind.is_file() {
                files.push(entry.path());
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(dir, &mut files)?;
    files.sort();
    let mut hasher = sha2::Sha256::new();
    for file in files {
        let relative = file.strip_prefix(dir).unwrap_or(&file);
        hasher.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update([0]);
        hasher.update(std::fs::read(&file)?);
        hasher.update([0]);
    }
    Ok(hex(&hasher.finalize()))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn git(dir: &Path, args: &[&str]) -> Result<String, PluginError> {
    let output = tokio::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        // git asks for nothing: a private repo it has no stored
        // credential for fails instead of waiting on a prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
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
        return Err(PluginError::Source(
            words
                .trim()
                .lines()
                .last()
                .unwrap_or("git gave no reason")
                .to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Fetch one commit of a repository at depth one - the pinned `sha`, else
/// the `reference` (a branch or tag), else the default branch - with only
/// `subdir` checked out when one is named, and its history dropped.
/// Answers the commit that arrived.
pub async fn git_fetch(
    url: &str,
    reference: Option<&str>,
    sha: Option<&str>,
    subdir: Option<&str>,
    to: &Path,
) -> Result<String, PluginError> {
    // A URL is an argument git would read as an option if it led with a
    // dash.
    if url.starts_with('-') || reference.is_some_and(|r| r.starts_with('-')) {
        return Err(PluginError::Invalid(format!("'{url}' is not a git URL")));
    }
    if let Some(sub) = subdir {
        if !relative_inside(sub) {
            return Err(PluginError::Invalid(format!(
                "'{sub}' is not a folder inside the repository"
            )));
        }
    }
    std::fs::create_dir_all(to)?;
    let failed = |e: PluginError| PluginError::Source(format!("git could not fetch {url}: {e}"));
    git(to, &["init", "--quiet"]).await.map_err(failed)?;
    git(to, &["remote", "add", "origin", url])
        .await
        .map_err(failed)?;
    if let Some(sub) = subdir {
        git(to, &["sparse-checkout", "init", "--cone"])
            .await
            .map_err(failed)?;
        git(to, &["sparse-checkout", "set", sub])
            .await
            .map_err(failed)?;
    }
    let want = sha.or(reference).unwrap_or("HEAD");
    git(to, &["fetch", "--quiet", "--depth", "1", "origin", want])
        .await
        .map_err(failed)?;
    git(to, &["checkout", "--quiet", "FETCH_HEAD"])
        .await
        .map_err(failed)?;
    let commit = git(to, &["rev-parse", "HEAD"]).await.map_err(failed)?;
    if let Some(sha) = sha {
        if !commit.eq_ignore_ascii_case(sha) {
            return Err(PluginError::Source(format!(
                "{url} answered commit {commit}, not the pinned {sha}"
            )));
        }
    }
    let _ = std::fs::remove_dir_all(to.join(".git"));
    Ok(commit)
}

/// The commit a branch or tag (or the default branch) points at now,
/// without fetching anything.
pub async fn git_head(url: &str, reference: Option<&str>) -> Result<String, PluginError> {
    if url.starts_with('-') {
        return Err(PluginError::Invalid(format!("'{url}' is not a git URL")));
    }
    let here = std::env::temp_dir();
    let out = git(&here, &["ls-remote", url, reference.unwrap_or("HEAD")]).await?;
    out.split_whitespace()
        .next()
        .map(String::from)
        .ok_or_else(|| PluginError::Source(format!("{url} has no {}", reference.unwrap_or("HEAD"))))
}

/// A path that stays inside its folder: relative, no `..`, forward
/// slashes.
pub fn relative_inside(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path.split('/').all(|part| part != "..")
}

/// GET over http(s), following a few redirects (release, repo and
/// registry links redirect once or twice), refused past `limit` bytes.
pub async fn http_get(location: &str, accept: &str, limit: u64) -> Result<Vec<u8>, PluginError> {
    let http = openremote_cloud::https::Http::new();
    // The client's own cap is sized for small answers; an archive may run
    // to the limit, with time to arrive at half a megabyte a second.
    let max_body = usize::try_from(limit).unwrap_or(usize::MAX);
    let time = Duration::from_secs((limit / (512 * 1024)).max(30));
    let mut url = location.to_string();
    for _ in 0..5 {
        let response = http
            .download(
                time,
                max_body,
                &url,
                &[("user-agent", "OpenRemote"), ("accept", accept)],
            )
            .await
            .map_err(|e| PluginError::Source(format!("could not download {url}: {e}")))?;
        match response.status {
            200 => {
                if response.body.len() as u64 > limit {
                    return Err(PluginError::Source(format!("{url} is too large")));
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

/// An archive's bytes: from a path on this machine, or downloaded.
async fn read_archive(location: &str) -> Result<Vec<u8>, PluginError> {
    if !(location.starts_with("https://") || location.starts_with("http://")) {
        let meta = std::fs::metadata(location)
            .map_err(|_| PluginError::Source(format!("{location} is not a file")))?;
        if meta.len() > MAX_ARCHIVE_BYTES {
            return Err(PluginError::Source("the archive is too large".into()));
        }
        return Ok(std::fs::read(location)?);
    }
    http_get(location, "*/*", MAX_ARCHIVE_BYTES).await
}

/// An npm package straight from its registry: the package's metadata, the
/// version the entry asks for (exact, a dist-tag, or a range), its
/// tarball - checked against the registry's integrity digest - unpacked.
/// Answers the version installed.
async fn npm_fetch(
    package: &str,
    version: Option<&str>,
    registry: Option<&str>,
    to: &Path,
) -> Result<String, PluginError> {
    let (tarball, integrity, resolved) =
        if package.starts_with("https://") || package.starts_with("http://") {
            (package.to_string(), None, package.to_string())
        } else {
            let (name, inline) = split_package(package);
            let registry = registry
                .unwrap_or("https://registry.npmjs.org")
                .trim_end_matches('/');
            let url = format!("{registry}/{}", name.replace('/', "%2f"));
            let body = http_get(&url, "application/json", 64 * 1024 * 1024).await?;
            let meta: Value = serde_json::from_slice(&body)
                .map_err(|e| PluginError::Source(format!("{url} is not package metadata: {e}")))?;
            let spec = inline.or(version).unwrap_or("latest");
            let chosen = npm_pick(&meta, spec).ok_or_else(|| {
                PluginError::Source(format!("{name} has no version matching '{spec}'"))
            })?;
            let dist = &meta["versions"][&chosen]["dist"];
            let tarball = dist["tarball"]
                .as_str()
                .ok_or_else(|| PluginError::Source(format!("{name} {chosen} has no tarball")))?
                .to_string();
            let integrity = dist["integrity"]
                .as_str()
                .map(|i| Integrity::Sri(i.to_string()))
                .or_else(|| {
                    dist["shasum"]
                        .as_str()
                        .map(|s| Integrity::Sha1(s.to_string()))
                });
            (tarball, integrity, chosen)
        };
    let bytes = http_get(&tarball, "*/*", MAX_ARCHIVE_BYTES).await?;
    if let Some(integrity) = integrity {
        integrity.check(&bytes, &tarball)?;
    }
    let to = to.to_path_buf();
    tokio::task::spawn_blocking(move || unpack(&bytes, &to))
        .await
        .map_err(|e| PluginError::Source(e.to_string()))??;
    Ok(resolved)
}

enum Integrity {
    /// `sha512-<base64>` (the registry's `dist.integrity`).
    Sri(String),
    /// The older hex sha1 `dist.shasum`.
    Sha1(String),
}

impl Integrity {
    fn check(&self, bytes: &[u8], url: &str) -> Result<(), PluginError> {
        use base64::Engine;
        let ok = match self {
            Integrity::Sri(sri) => match sri.split_once('-') {
                Some(("sha512", want)) => {
                    base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(bytes))
                        == want
                }
                Some(("sha256", want)) => {
                    base64::engine::general_purpose::STANDARD.encode(sha2::Sha256::digest(bytes))
                        == want
                }
                Some(("sha1", want)) => {
                    base64::engine::general_purpose::STANDARD.encode(sha1::Sha1::digest(bytes))
                        == want
                }
                _ => true,
            },
            Integrity::Sha1(want) => hex(&sha1::Sha1::digest(bytes)).eq_ignore_ascii_case(want),
        };
        if ok {
            Ok(())
        } else {
            Err(PluginError::Source(format!(
                "{url} does not match the registry's integrity digest - refusing it"
            )))
        }
    }
}

/// `@scope/name@1.2.3` -> (`@scope/name`, Some(`1.2.3`)).
fn split_package(package: &str) -> (&str, Option<&str>) {
    match package.rfind('@') {
        Some(at) if at > 0 => (&package[..at], Some(&package[at + 1..])),
        _ => (package, None),
    }
}

/// The version an npm spec picks: a dist-tag, an exact version, or the
/// highest release a range admits.
fn npm_pick(meta: &Value, spec: &str) -> Option<String> {
    if let Some(tagged) = meta["dist-tags"][spec].as_str() {
        return Some(tagged.to_string());
    }
    let versions = meta["versions"].as_object()?;
    if versions.contains_key(spec) {
        return Some(spec.to_string());
    }
    versions
        .keys()
        .filter_map(|v| semver::Version::parse(v).ok())
        .filter(|v| v.pre.is_empty() && npm_range_admits(spec, v))
        .max()
        .map(|v| v.to_string())
}

/// npm's range syntax read through semver's: `||` alternatives, hyphen
/// ranges, space-separated comparators, `x` wildcards.
pub fn npm_range_admits(range: &str, version: &semver::Version) -> bool {
    range.split("||").any(|part| {
        let part = part.trim();
        if part.is_empty() || part == "*" || part.eq_ignore_ascii_case("x") {
            return true;
        }
        let req = if let Some((low, high)) = part.split_once(" - ") {
            format!(">={}, <={}", low.trim(), high.trim())
        } else {
            let mut tight = part.to_string();
            for op in [">=", "<=", ">", "<", "=", "^", "~"] {
                tight = tight.replace(&format!("{op} "), op);
            }
            tight
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(", ")
                .replace(".x", ".*")
                .replace(".X", ".*")
        };
        semver::VersionReq::parse(&req).is_ok_and(|r| r.matches(version))
    })
}

/// A package with Node dependencies gets them - with npm, its scripts
/// never run. Without npm the install stops and says so.
async fn install_node_packages(root: &Path) -> Result<(), PluginError> {
    let package: Option<Value> = read_json(&root.join("package.json"))?;
    let needs = package
        .as_ref()
        .and_then(|p| p.get("dependencies"))
        .and_then(Value::as_object)
        .is_some_and(|deps| !deps.is_empty());
    if !needs {
        return Ok(());
    }
    let locked =
        root.join("package-lock.json").is_file() || root.join("npm-shrinkwrap.json").is_file();
    let mut args = vec![if locked { "ci" } else { "install" }];
    args.extend(["--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"]);
    if !locked {
        args.push("--no-package-lock");
    }
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let output = tokio::process::Command::new(npm)
        .args(&args)
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| {
            PluginError::Source(if e.kind() == std::io::ErrorKind::NotFound {
                "this plugin needs its Node packages installed, and that needs npm on this machine"
                    .into()
            } else {
                format!("npm could not start: {e}")
            })
        })?;
    if !output.status.success() {
        let words = String::from_utf8_lossy(&output.stderr);
        return Err(PluginError::Source(format!(
            "npm could not install the plugin's packages: {}",
            words.trim().lines().last().unwrap_or("no reason given")
        )));
    }
    Ok(())
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// Run a `command` source's command - only the exact one the user
/// approved - from the home folder: it must print one line, the absolute
/// path of a folder that holds a plugin, and exit 0 in time.
pub async fn run_command(approved: &ApprovedCommand) -> Result<PathBuf, PluginError> {
    #[cfg(windows)]
    let mut command = {
        let mut c = tokio::process::Command::new("cmd");
        // As typed: cmd.exe reads the rest of its line itself, and the
        // usual argument quoting would change what the user approved.
        c.arg("/C").raw_arg(&approved.command);
        c
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(&approved.command);
        c
    };
    command
        .current_dir(home_dir())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let limit = approved.timeout_secs.clamp(1, 600);
    let output = tokio::time::timeout(Duration::from_secs(limit), command.output())
        .await
        .map_err(|_| PluginError::Source(format!("the command ran past {limit}s")))?
        .map_err(|e| PluginError::Source(format!("the command could not start: {e}")))?;
    if !output.status.success() {
        let words = String::from_utf8_lossy(&output.stderr);
        return Err(PluginError::Source(format!(
            "the command failed: {}",
            words.trim().lines().last().unwrap_or("no reason given")
        )));
    }
    let printed = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = printed
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let [line] = lines.as_slice() else {
        return Err(PluginError::Source(
            "the command must print one line: the plugin folder's path".into(),
        ));
    };
    let path = PathBuf::from(line);
    if !path.is_absolute() || !path.is_dir() {
        return Err(PluginError::Source(format!(
            "the command printed {line}, which is not a folder"
        )));
    }
    if !has_manifest(&path) && claude_dirs(&path).is_empty() && !path.join("hooks").is_dir() {
        return Err(PluginError::Invalid(format!("{line} holds no plugin")));
    }
    Ok(path)
}

/// At a chat's start: run an installed plugin's approved command again
/// and take its folder if it changed. Answers whether it changed and the
/// new content hash; an error leaves the last copy in place.
pub async fn rerun_command(
    data_dir: &Path,
    plugin: &InstalledPlugin,
) -> Result<Option<String>, PluginError> {
    let Some(approved) = &plugin.command else {
        return Ok(None);
    };
    let printed = run_command(approved).await?;
    let hash = {
        let printed = printed.clone();
        tokio::task::spawn_blocking(move || content_hash(&printed))
            .await
            .map_err(|e| PluginError::Source(e.to_string()))??
    };
    if plugin.resolved.as_deref() == Some(hash.as_str()) {
        return Ok(None);
    }
    let root = data_dir.join("plugins");
    let target = plugin_dir(data_dir, &plugin.marketplace, &plugin.name);
    let fresh = root.join(".staging").join(uuid::Uuid::new_v4().to_string());
    copy_in(printed, fresh.clone()).await?;
    // Rewritten as the install rewrote it, when it is in the sibling layout.
    crate::adapt::adapt(&fresh, Some(&plugin.name), &plugin.marketplace)?;
    // The Claude manifest written at install (from the marketplace entry)
    // is not in the command's output: carry it over.
    let manifest = Path::new(".claude-plugin").join("plugin.json");
    if !fresh.join(&manifest).is_file() && target.join(&manifest).is_file() {
        std::fs::create_dir_all(fresh.join(".claude-plugin"))?;
        std::fs::copy(target.join(&manifest), fresh.join(&manifest))?;
    }
    let swapped = swap_in(&root, &fresh, &target);
    let _ = std::fs::remove_dir_all(&fresh);
    swapped?;
    Ok(Some(hash))
}

/// The marketplace entry's part in the plugin's Claude manifest, as Claude
/// Code itself applies it: with no plugin.json the entry is the manifest;
/// with one, a strict entry appends its components (hooks replace per
/// event) and a non-strict entry that lists components is a conflict.
pub fn apply_entry(root: &Path, entry: &Value) -> Result<(), PluginError> {
    const COMPONENTS: &[&str] = &[
        "commands",
        "agents",
        "skills",
        "hooks",
        "outputStyles",
        "themes",
    ];
    // Catalog fields that are not the plugin's own.
    const ENTRY_ONLY: &[&str] = &[
        "source",
        "category",
        "tags",
        "strict",
        "relevance",
        "dependencies",
        "defaultEnabled",
        "metadata",
        "headers",
        "headersHelper",
    ];
    let Some(fields) = entry.as_object() else {
        return Ok(());
    };
    let path = root.join(".claude-plugin").join("plugin.json");
    let strict = fields
        .get("strict")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let listed: Vec<&str> = COMPONENTS
        .iter()
        .copied()
        .filter(|c| fields.contains_key(*c))
        .collect();
    let manifest = match read_json::<Value>(&path)? {
        None => {
            // An OpenRemote plugin with no Claude side needs no Claude
            // manifest; anything else gets the entry as its manifest.
            if root.join("openremote.json").is_file()
                && listed.is_empty()
                && claude_dirs(root).is_empty()
            {
                return Ok(());
            }
            let mut own = serde_json::Map::new();
            for (key, value) in fields {
                if !ENTRY_ONLY.contains(&key.as_str()) {
                    own.insert(key.clone(), value.clone());
                }
            }
            Value::Object(own)
        }
        Some(mut manifest) => {
            if listed.is_empty() {
                return Ok(());
            }
            if !strict {
                return Err(PluginError::Invalid(format!(
                    "{} has conflicting manifests: its plugin.json and its marketplace entry both list components",
                    fields
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("the plugin")
                )));
            }
            let Some(own) = manifest.as_object_mut() else {
                return Err(PluginError::Invalid("plugin.json is not an object".into()));
            };
            for component in listed {
                let added = &fields[component];
                if component == "hooks" {
                    let mut hooks = own
                        .get("hooks")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(events) = added.as_object() {
                        for (event, matchers) in events {
                            hooks.insert(event.clone(), matchers.clone());
                        }
                    }
                    own.insert("hooks".into(), Value::Object(hooks));
                } else {
                    let mut list = as_list(own.get(component));
                    for item in as_list(Some(added)) {
                        if !list.contains(&item) {
                            list.push(item);
                        }
                    }
                    own.insert(component.into(), Value::Array(list));
                }
            }
            manifest
        }
    };
    std::fs::create_dir_all(root.join(".claude-plugin"))?;
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&manifest).expect("a manifest serializes"),
    )?;
    Ok(())
}

fn as_list(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(_)) => vec![value.cloned().expect("a string")],
        _ => Vec::new(),
    }
}

/// A folder that carries Claude parts with no plugin.json gets a bare one,
/// so claude's `--plugin-dir` takes the folder as one plugin.
fn write_bare_claude_manifest(root: &Path, manifest: &Manifest) -> Result<(), PluginError> {
    let path = root.join(".claude-plugin").join("plugin.json");
    if manifest.claude_parts.is_empty() || path.is_file() {
        return Ok(());
    }
    let mut own = serde_json::Map::new();
    own.insert("name".into(), Value::String(manifest.name.clone()));
    if let Some(version) = &manifest.version {
        own.insert("version".into(), Value::String(version.clone()));
    }
    if let Some(description) = &manifest.description {
        own.insert("description".into(), Value::String(description.clone()));
    }
    std::fs::create_dir_all(root.join(".claude-plugin"))?;
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&Value::Object(own)).expect("a manifest serializes"),
    )?;
    Ok(())
}

/// Unpack a whole .zip or .tar.gz into `to`, refusing any entry that
/// would land outside it and any archive that unpacks past the size limit.
pub(crate) fn unpack(bytes: &[u8], to: &Path) -> Result<(), PluginError> {
    unpack_within(bytes, to, None)
}

/// `unpack`, or - when `inner` names a folder - only that folder of the
/// archive, which becomes the top of `to`; the rest stays behind.
fn unpack_within(bytes: &[u8], to: &Path, inner: Option<&str>) -> Result<(), PluginError> {
    if let Some(inner) = inner {
        if !relative_inside(inner) {
            return Err(PluginError::Invalid(format!(
                "'{inner}' is not a folder inside the archive"
            )));
        }
    }
    let inner = inner.map(Path::new);
    // An entry's place under `to`: the folder `inner` names is the top,
    // and whatever sits outside that folder stays behind.
    let place = |relative: &Path| -> Option<PathBuf> {
        match inner {
            None => Some(relative.to_path_buf()),
            Some(top) => relative
                .strip_prefix(top)
                .ok()
                .filter(|rest| !rest.as_os_str().is_empty())
                .map(Path::to_path_buf),
        }
    };
    std::fs::create_dir_all(to)?;
    let mut total: u64 = 0;
    let mut found = inner.is_none();
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
            let Some(relative) = place(&relative) else {
                continue;
            };
            found = true;
            let out = to.join(relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&out)?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut file = std::fs::File::create(&out)?;
            // Counted as written, not as the entry's header claims: a
            // header can understate what it unpacks to.
            let room = MAX_ARCHIVE_BYTES - total;
            total += std::io::copy(&mut (&mut entry).take(room + 1), &mut file)?;
            if total > MAX_ARCHIVE_BYTES {
                return Err(PluginError::Source("the archive unpacks too large".into()));
            }
            // A script the plugin runs directly needs its executable bit,
            // which only the zip's own record of it carries.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if entry.unix_mode().is_some_and(|mode| mode & 0o111 != 0) {
                    std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o755))?;
                }
            }
        }
    } else if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bytes)));
        let unreadable =
            |e: std::io::Error| PluginError::Source(format!("the archive is unreadable: {e}"));
        for entry in archive.entries().map_err(unreadable)? {
            let mut entry = entry.map_err(unreadable)?;
            let kind = entry.header().entry_type();
            if !(kind.is_file() || kind.is_dir()) {
                continue;
            }
            total += entry.header().size().unwrap_or(0);
            if total > MAX_ARCHIVE_BYTES {
                return Err(PluginError::Source("the archive unpacks too large".into()));
            }
            let escapes = || PluginError::Invalid("the archive reaches outside its folder".into());
            if inner.is_none() {
                // unpack_in refuses a path that climbs out of `to`.
                if !entry.unpack_in(to).map_err(unreadable)? {
                    return Err(escapes());
                }
                continue;
            }
            let path = entry.path().map_err(unreadable)?.into_owned();
            let Some(relative) = plain_relative(&path) else {
                return Err(escapes());
            };
            let Some(relative) = place(&relative) else {
                continue;
            };
            found = true;
            let out = to.join(relative);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            entry.unpack(&out).map_err(unreadable)?;
        }
    } else {
        return Err(PluginError::Invalid(
            "an archive is a .zip or a .tar.gz".into(),
        ));
    }
    if !found {
        return Err(PluginError::Source(format!(
            "the archive has no folder {}",
            inner.map(|p| p.display().to_string()).unwrap_or_default()
        )));
    }
    Ok(())
}

/// A path inside an archive made only of plain names (a leading `./` is
/// fine); None when any part climbs out or is absolute.
fn plain_relative(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::Normal(name) => out.push(name),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    fn plugin_json(dir: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(dir.join(".claude-plugin/plugin.json")).unwrap())
            .unwrap()
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

    #[test]
    fn with_no_plugin_json_the_marketplace_entry_is_the_manifest() {
        let dir = folder(&[("local-ai/SKILL.md", "# local ai")]);
        let entry = json!({
            "name": "amd-skills",
            "description": "AMD's skills",
            "source": {"source": "git-subdir", "url": "x", "path": "skills"},
            "strict": false,
            "category": "development",
            "skills": ["./local-ai"],
        });
        apply_entry(dir.path(), &entry).unwrap();
        let written = plugin_json(dir.path());
        assert_eq!(written["name"], "amd-skills");
        assert_eq!(written["skills"], json!(["./local-ai"]));
        // The catalog's own fields stay in the catalog.
        assert!(written.get("source").is_none());
        assert!(written.get("strict").is_none());
        assert!(written.get("category").is_none());
    }

    #[test]
    fn a_strict_entry_adds_its_components_and_a_loose_one_conflicts() {
        let dir = folder(&[(
            ".claude-plugin/plugin.json",
            r#"{"name": "fmt", "commands": "./commands", "hooks": {"PreToolUse": [1], "Stop": [2]}}"#,
        )]);
        let entry = json!({
            "name": "fmt",
            "commands": ["./extra"],
            "hooks": {"Stop": [3]},
        });
        apply_entry(dir.path(), &entry).unwrap();
        let written = plugin_json(dir.path());
        assert_eq!(written["commands"], json!(["./commands", "./extra"]));
        // hooks replace per event
        assert_eq!(written["hooks"], json!({"PreToolUse": [1], "Stop": [3]}));

        let loose = json!({"name": "fmt", "strict": false, "skills": ["./x"]});
        let err = apply_entry(dir.path(), &loose).unwrap_err().to_string();
        assert!(err.contains("conflicting manifests"), "{err}");
    }

    #[test]
    fn npm_ranges_read_as_npm_writes_them() {
        let v = |s: &str| semver::Version::parse(s).unwrap();
        assert!(npm_range_admits("^2.0.0", &v("2.3.1")));
        assert!(!npm_range_admits("^2.0.0", &v("3.0.0")));
        assert!(npm_range_admits(">= 1.2 < 2", &v("1.9.0")));
        assert!(npm_range_admits("1.x || 3.x", &v("3.4.0")));
        assert!(!npm_range_admits("1.x || 3.x", &v("2.0.0")));
        assert!(npm_range_admits("1.0.0 - 1.4.0", &v("1.4.0")));
        assert!(npm_range_admits("*", &v("9.9.9")));

        let meta = json!({
            "dist-tags": {"latest": "2.1.0", "next": "3.0.0-beta.1"},
            "versions": {"1.0.0": {}, "2.0.0": {}, "2.1.0": {}, "3.0.0-beta.1": {}},
        });
        assert_eq!(npm_pick(&meta, "latest").as_deref(), Some("2.1.0"));
        assert_eq!(npm_pick(&meta, "next").as_deref(), Some("3.0.0-beta.1"));
        assert_eq!(npm_pick(&meta, "1.0.0").as_deref(), Some("1.0.0"));
        assert_eq!(npm_pick(&meta, "^2").as_deref(), Some("2.1.0"));
        assert_eq!(npm_pick(&meta, "^4"), None);
        assert_eq!(split_package("@scope/x@1.2.3"), ("@scope/x", Some("1.2.3")));
        assert_eq!(split_package("@scope/x"), ("@scope/x", None));
    }

    #[test]
    fn paths_inside_a_folder_stay_inside() {
        assert!(relative_inside("plugins/fmt"));
        assert!(!relative_inside("../fmt"));
        assert!(!relative_inside("a/../../b"));
        assert!(!relative_inside("/etc"));
        assert!(!relative_inside("C:/x"));
        assert!(!relative_inside("a\\b"));
    }

    #[test]
    fn a_folder_with_claude_parts_and_no_manifest_gets_a_bare_one() {
        let dir = folder(&[("skills/greet/SKILL.md", "# greet")]);
        // read_manifest needs a name: a direct install of a bare skills
        // folder has none, so it is refused...
        assert!(read_manifest(dir.path(), &builtins()).is_err());
        // ...while one that names itself in openremote.json gets Claude's
        // file written beside it.
        std::fs::write(
            dir.path().join("openremote.json"),
            r#"{"api": 1, "name": "greeter", "version": "1.0.0", "runtime": "content"}"#,
        )
        .unwrap();
        let m = read_manifest(dir.path(), &builtins()).unwrap();
        write_bare_claude_manifest(dir.path(), &m).unwrap();
        assert_eq!(
            plugin_json(dir.path()),
            json!({"name": "greeter", "version": "1.0.0"})
        );
    }

    #[test]
    fn an_archive_unpacks_only_the_folder_it_is_told_to() {
        let mut zip_bytes = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(Cursor::new(&mut zip_bytes));
            let options = zip::write::SimpleFileOptions::default();
            for (path, body) in [
                ("plugin/a.txt", "a"),
                ("plugin/deep/b.txt", "b"),
                ("other/c.txt", "c"),
            ] {
                zip.start_file(path, options).unwrap();
                std::io::Write::write_all(&mut zip, body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        let mut tgz_bytes = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut tgz_bytes, flate2::Compression::default());
            let mut tar = tar::Builder::new(gz);
            for (path, body) in [
                ("plugin/a.txt", "a"),
                ("plugin/deep/b.txt", "b"),
                ("other/c.txt", "c"),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, path, body.as_bytes()).unwrap();
            }
            tar.into_inner().unwrap().finish().unwrap();
        }
        for bytes in [&zip_bytes, &tgz_bytes] {
            let to = tempfile::tempdir().unwrap();
            unpack_within(bytes, to.path(), Some("plugin")).unwrap();
            assert!(to.path().join("a.txt").is_file());
            assert!(to.path().join("deep").join("b.txt").is_file());
            assert!(!to.path().join("c.txt").exists());
            assert!(!to.path().join("other").exists());
            // A folder the archive doesn't have, or one that climbs out of
            // it, is refused.
            let refused = tempfile::tempdir().unwrap();
            let missing = unpack_within(bytes, refused.path(), Some("nope"));
            assert!(missing.unwrap_err().to_string().contains("no folder"));
            assert!(unpack_within(bytes, refused.path(), Some("../plugin")).is_err());
        }
    }

    #[test]
    fn a_plugin_in_the_sibling_layout_is_read_by_its_own_manifest() {
        let dir = folder(&[
            (
                ".zcode-plugin/plugin.json",
                r#"{"name": "layout-plugin", "version": "0.3.0", "skills": "payload/skills",
                    "description": "plain", "description_i18n": {"en": "In English"}}"#,
            ),
            ("payload/skills/x/SKILL.md", "# x"),
            (
                ".mcp.json",
                r#"{"mcpServers": {"data": {"type": "http", "url": "${ZCODE_BASE_URL}/mcp",
                                            "auth": {"type": "zcode_official"}}}}"#,
            ),
        ]);
        let m = read_manifest(dir.path(), &builtins()).unwrap();
        assert_eq!(m.name, "layout-plugin");
        assert_eq!(m.version.as_deref(), Some("0.3.0"));
        assert_eq!(m.description.as_deref(), Some("In English"));
        // Its skills sit in a folder of its own choosing; its only server
        // needs the publisher's account, so it brings no program.
        assert_eq!(m.claude_parts, vec!["skills"]);
        assert_eq!(m.powers, Vec::<PluginPower>::new());
        assert!(m.left_out.iter().any(|n| n.contains("account")));
        assert!(m.nothing_left().is_none());
        // Claude Code's manifest, where there is one, wins over it.
        std::fs::create_dir_all(dir.path().join(".claude-plugin")).unwrap();
        std::fs::write(
            dir.path().join(".claude-plugin").join("plugin.json"),
            r#"{"name": "claude-name"}"#,
        )
        .unwrap();
        let both = read_manifest(dir.path(), &builtins()).unwrap();
        assert_eq!(both.name, "claude-name");
        assert_eq!(both.version.as_deref(), Some("0.3.0"));
    }
}
