//! Running the plugins the user installed. Fetching, staging and the
//! install itself live in `plugins.rs`; this is everything after: the
//! OpenRemote part of a manifest (`manifest`), the process runtime and its
//! protocol (`process`, `harness`), WASM agent tools (`wasm`), install
//! scopes (`scope`, `global`), the user's settings (`settings`) and the
//! routes that reach them (`routes`).
//!
//! Nothing runs that the user didn't approve: a plugin's program or module
//! starts only for an approved, enabled plugin, only when a chat or a view
//! needs it, and only with the powers approved at install.

pub mod global;
pub mod harness;
pub mod install;
pub mod manifest;
pub mod process;
pub mod routes;
pub mod scope;
pub mod settings;
pub mod wasm;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use openremote_core::{
    Harness, InstalledPlugin, PluginPower, PluginRuntime as Runtime, PluginScope, SessionId, Store,
};
use serde_json::{Map, Value, json};

use crate::supervisor::{Supervisor, lock_recovering};
pub use install::check_staged;
use process::{RpcError, StartSpec};

/// A tool call waits this long by default; a tool may name its own.
const TOOL_TIME: Duration = Duration::from_secs(120);
/// A call from a plugin's view to its program.
const REQUEST_TIME: Duration = Duration::from_secs(60);
/// A Global plugin's archive stays built this long for the slices after
/// the first.
const ARCHIVE_KEEP: Duration = Duration::from_secs(600);

/// The chat a tool call comes from, as a plugin is told it.
#[derive(Clone, Debug)]
pub struct ChatInfo {
    pub id: SessionId,
    pub workspace: Option<PathBuf>,
}

pub struct PluginRuntime {
    data_dir: PathBuf,
    store: Arc<StdMutex<Store>>,
    supervisor: Weak<Supervisor>,
    pub processes: process::ProcessHost,
    pub wasm: wasm::WasmHost,
    pub settings: settings::SettingsStore,
    /// Why a Global plugin isn't on this device yet, by id.
    global_errors: StdMutex<HashMap<String, String>>,
    /// Built archives of Global plugins being copied to another device.
    archives: StdMutex<HashMap<String, BuiltArchive>>,
}

/// A Global plugin's folder packed for a copy: the content hash it was
/// built from, the bytes, when it was built.
type BuiltArchive = (String, Arc<Vec<u8>>, Instant);

impl PluginRuntime {
    pub fn new(
        data_dir: &Path,
        store: Arc<StdMutex<Store>>,
        supervisor: Weak<Supervisor>,
    ) -> Arc<Self> {
        let runtime = Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            store,
            supervisor,
            processes: process::ProcessHost::default(),
            wasm: wasm::WasmHost::default(),
            settings: settings::SettingsStore::new(data_dir),
            global_errors: StdMutex::new(HashMap::new()),
            archives: StdMutex::new(HashMap::new()),
        });
        let weak = Arc::downgrade(&runtime);
        runtime
            .processes
            .set_requests(Arc::new(move |plugin, method, params| {
                let weak = weak.clone();
                Box::pin(async move {
                    match weak.upgrade() {
                        Some(runtime) => runtime.answer(&plugin, &method, params).await,
                        None => Err(RpcError::new(-32000, "OpenRemote is stopping")),
                    }
                })
            }));
        runtime
    }

    /// One installed plugin by id.
    pub fn plugin(&self, id: &str) -> Option<InstalledPlugin> {
        lock_recovering(&self.store)
            .installed_plugin(id)
            .ok()
            .cloned()
    }

    /// Where an installed plugin's files are.
    pub fn folder(&self, plugin: &InstalledPlugin) -> Option<PathBuf> {
        let store = lock_recovering(&self.store);
        scope::folder(&self.data_dir, &store, plugin)
    }

    /// The plugins a chat in `workspace` gets.
    pub fn for_chat(&self, workspace: Option<&Path>) -> Vec<scope::Active> {
        let store = lock_recovering(&self.store);
        scope::active(&store, &self.data_dir, workspace)
    }

    /// A plugin's own folder for what it keeps.
    pub fn data_folder(&self, id: &str) -> PathBuf {
        self.data_dir.join("plugin-data").join(id)
    }

    /// The plugin's settings as it is handed them: declared values, set or
    /// default, secrets included.
    pub fn effective_settings(&self, plugin: &InstalledPlugin) -> Map<String, Value> {
        settings::effective(
            &plugin.contributes.settings,
            &self.settings.load(&plugin.id()),
        )
    }

    /// Refuse to run a plugin whose required settings are unset, saying
    /// which ones.
    fn ready(&self, plugin: &InstalledPlugin) -> Result<(), String> {
        let missing = settings::missing_required(
            &plugin.contributes.settings,
            &self.settings.load(&plugin.id()),
        );
        if missing.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "the plugin {} needs {} set first (Settings > Plugins > {})",
                plugin.name,
                missing.join(", "),
                plugin.name
            ))
        }
    }

    /// What starts a process plugin's program.
    fn spec(&self, id: &str) -> Result<StartSpec, String> {
        let plugin = self
            .plugin(id)
            .ok_or_else(|| format!("{id} is not installed"))?;
        if !plugin.enabled {
            return Err(format!("{} is turned off", plugin.name));
        }
        if plugin.runtime != Runtime::Process {
            return Err(format!("{} does not run a program", plugin.name));
        }
        self.ready(&plugin)?;
        let root = self
            .folder(&plugin)
            .ok_or_else(|| format!("{}'s project is gone", plugin.name))?;
        if plugin.scope == PluginScope::Project
            && !scope::unchanged(&root, plugin.resolved.as_deref())
        {
            return Err(format!(
                "{}'s files changed in the repo since you approved them: review it again on the Plugins page",
                plugin.name
            ));
        }
        let raw: Value = std::fs::read(root.join("openremote.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or_else(|| format!("{}'s openremote.json is unreadable", plugin.name))?;
        let section = manifest::read_section(&raw, &root, &plugin.name, plugin.runtime, &[])
            .map_err(|e| e.to_string())?;
        let entry = section
            .entry
            .ok_or_else(|| format!("{} names no program", plugin.name))?;
        let (program, args) = entry.resolve(&root);
        Ok(StartSpec {
            id: id.to_string(),
            name: plugin.name.clone(),
            version: plugin.version.clone(),
            data: self.data_folder(id),
            root,
            program,
            args,
            settings: self.effective_settings(&plugin),
            powers: plugin.powers.clone(),
            scope: plugin.scope,
        })
    }

    /// A process plugin's running program, started if it isn't.
    pub async fn process(&self, id: &str) -> Result<Arc<process::Conn>, String> {
        self.processes.connection(id, || self.spec(id)).await
    }

    /// The agent tools a chat in `workspace` lists, as MCP shapes them.
    /// Two enabled plugins of one name would give two tools one name: the
    /// first (by id) keeps it, and the clash is noted on stderr - the
    /// Plugins page already asks the user to turn one off.
    pub fn tool_listing(&self, workspace: Option<&Path>) -> Vec<Value> {
        let mut seen = std::collections::BTreeSet::new();
        let mut out = Vec::new();
        for active in self.for_chat(workspace) {
            let plugin = &active.plugin;
            if !plugin.powers.contains(&PluginPower::AgentTools) {
                continue;
            }
            for tool in &plugin.contributes.tools {
                let name = manifest::agent_tool_name(&plugin.name, &tool.name);
                if !seen.insert(name.clone()) {
                    eprintln!(
                        "plugin {}: its tool {name} is hidden behind another plugin's of the same name",
                        plugin.id()
                    );
                    continue;
                }
                out.push(json!({
                    "name": name,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                    "annotations": {
                        "title": format!("{} ({})", tool.name, plugin.name),
                        "readOnlyHint": tool.read_only,
                    },
                }));
            }
        }
        out
    }

    /// Run one of a chat's plugin tools. Always answers an MCP tool
    /// result: a refusal is an error the agent reads.
    pub async fn call_tool(
        self: &Arc<Self>,
        chat: &ChatInfo,
        name: &str,
        arguments: Value,
    ) -> Value {
        let Some((plugin_name, tool_name)) = name.split_once("__") else {
            return error_result(&format!("there is no tool named {name}"));
        };
        let found = self
            .for_chat(chat.workspace.as_deref())
            .into_iter()
            .find(|a| {
                a.plugin.name == plugin_name
                    && a.plugin
                        .contributes
                        .tools
                        .iter()
                        .any(|t| t.name == tool_name)
            });
        let Some(active) = found else {
            return error_result(&format!(
                "no plugin this chat has offers {name} (it may be off, removed, or for another project)"
            ));
        };
        let plugin = active.plugin;
        if !plugin.powers.contains(&PluginPower::AgentTools) {
            return error_result(&format!(
                "{} was not given the power to offer agents tools",
                plugin.name
            ));
        }
        if let Err(why) = self.ready(&plugin) {
            return error_result(&why);
        }
        let tool = plugin
            .contributes
            .tools
            .iter()
            .find(|t| t.name == tool_name)
            .cloned()
            .expect("found above");
        let chat_json = json!({"id": chat.id, "workspace": chat.workspace});
        match plugin.runtime {
            Runtime::Process => {
                let conn = match self.process(&plugin.id()).await {
                    Ok(conn) => conn,
                    Err(e) => {
                        return error_result(&format!("{} could not start: {e}", plugin.name));
                    }
                };
                let timeout = tool
                    .timeout_secs
                    .map(Duration::from_secs)
                    .unwrap_or(TOOL_TIME);
                match conn
                    .call(
                        "tools/call",
                        json!({"name": tool.name, "arguments": arguments, "chat": chat_json}),
                        timeout,
                    )
                    .await
                {
                    Ok(result) => tool_result(result),
                    Err(e) => error_result(&format!("{}: {e}", plugin.name)),
                }
            }
            Runtime::Wasm => {
                let Some(path) = self.wasm_entry(&plugin, &active.dir) else {
                    return error_result(&format!("{}'s module is missing", plugin.name));
                };
                let input = json!({
                    "tool": tool.name,
                    "arguments": arguments,
                    "settings": self.effective_settings(&plugin),
                    "chat": chat_json,
                });
                let network = plugin.powers.contains(&PluginPower::Network);
                self.wasm.call(&plugin.id(), &path, network, input).await
            }
            _ => error_result(&format!("{} can't run tools", plugin.name)),
        }
    }

    fn wasm_entry(&self, plugin: &InstalledPlugin, dir: &Path) -> Option<PathBuf> {
        let raw: Value =
            serde_json::from_slice(&std::fs::read(dir.join("openremote.json")).ok()?).ok()?;
        let path = raw.get("entry")?.as_str()?.trim_start_matches("./");
        crate::plugins::relative_inside(path)
            .then(|| dir.join(path))
            .filter(|p| p.is_file() && plugin.runtime == Runtime::Wasm)
    }

    /// A call from one of a plugin's views (through the console) to its
    /// own program: the view's way to ask the plugin for its data.
    pub async fn request(&self, id: &str, name: &str, params: Value) -> Result<Value, String> {
        let plugin = self
            .plugin(id)
            .ok_or_else(|| format!("{id} is not installed"))?;
        if plugin.runtime != Runtime::Process {
            return Err(format!("{} has no program to ask", plugin.name));
        }
        let conn = self.process(id).await?;
        conn.call(
            "ui/request",
            json!({"name": name, "params": params}),
            REQUEST_TIME,
        )
        .await
        .map_err(|e| e.message)
    }

    /// The plugin harnesses this machine offers: one per harness an
    /// installed Global or Machine plugin contributes. A plugin that is
    /// off keeps its harnesses listed (so its chats keep their name) but
    /// unavailable.
    pub fn harness_entries(self: &Arc<Self>) -> Vec<(Harness, Option<crate::registry::Backend>)> {
        let plugins: Vec<InstalledPlugin> = lock_recovering(&self.store)
            .installed_plugins()
            .into_iter()
            .filter(|p| matches!(p.scope, PluginScope::Global | PluginScope::Machine))
            .filter(|p| p.runtime == Runtime::Process)
            .cloned()
            .collect();
        let mut taken = std::collections::BTreeSet::new();
        let mut out = Vec::new();
        for plugin in plugins {
            for spec in &plugin.contributes.harnesses {
                if !taken.insert(spec.id.clone()) {
                    continue;
                }
                let harness = Harness {
                    id: spec.id.clone(),
                    name: spec.name.clone(),
                    path: None,
                    version: plugin.version.clone(),
                    available: plugin.enabled,
                    enabled: plugin.enabled,
                    fast_supported: spec.fast,
                    signed_in: None,
                    default_model: spec
                        .models
                        .iter()
                        .find(|m| m.default)
                        .map(|m| m.model.clone()),
                    default_effort: None,
                    permission_modes: spec.permission_modes.clone(),
                    default_permission: spec.default_permission.clone(),
                    plugin: Some(plugin.id()),
                };
                let backend = plugin.enabled.then(|| {
                    crate::registry::Backend::Plugin(harness::PluginBackend {
                        runtime: Arc::downgrade(self),
                        plugin: plugin.id(),
                        spec: spec.clone(),
                    })
                });
                out.push((harness, backend));
            }
        }
        out
    }

    /// Something about a plugin changed - installed, updated, turned on or
    /// off, removed: its program stops (the next need starts the new
    /// one) and the pickers learn its harnesses.
    pub async fn changed(self: &Arc<Self>, id: &str) {
        self.processes.stop(id).await;
        self.refresh_harnesses();
    }

    /// Hand the registry this machine's plugin harnesses.
    pub fn refresh_harnesses(self: &Arc<Self>) {
        if let Some(supervisor) = self.supervisor.upgrade() {
            supervisor.set_plugin_harnesses(self.harness_entries());
        }
    }

    /// New settings reach a running program at once; a stopped one gets
    /// them when it starts.
    pub async fn settings_changed(&self, plugin: &InstalledPlugin) {
        if let Some(conn) = self.processes.running(&plugin.id()).await {
            let _ = conn
                .notify(
                    "settings/changed",
                    json!({"settings": self.effective_settings(plugin)}),
                )
                .await;
        }
    }

    pub fn set_global_error(&self, id: &str, error: Option<String>) {
        let mut errors = lock_recovering(&self.global_errors);
        match error {
            Some(e) => {
                errors.insert(id.to_string(), e);
            }
            None => {
                errors.remove(id);
            }
        }
    }

    /// The account's Global plugins not on this device yet, and why.
    pub fn global_pending(&self) -> Vec<Value> {
        let errors = lock_recovering(&self.global_errors).clone();
        let store = lock_recovering(&self.store);
        store
            .global_plugins()
            .into_iter()
            .filter(|r| !r.removed)
            .filter(|r| {
                !store.installed_plugin(&r.id()).is_ok_and(|p| {
                    p.scope == PluginScope::Global
                        && scope::unchanged(
                            &crate::plugins::plugin_dir(&self.data_dir, &p.marketplace, &p.name),
                            Some(&r.resolved),
                        )
                })
            })
            .map(|r| {
                json!({
                    "id": r.id(),
                    "name": r.name,
                    "version": r.version,
                    "error": errors.get(&r.id()),
                })
            })
            .collect()
    }

    /// A Global plugin's folder as one archive, built once per copy and
    /// kept a while for the slices that follow.
    pub async fn archive(
        &self,
        id: &str,
        resolved: &str,
        dir: &Path,
    ) -> Result<Arc<Vec<u8>>, String> {
        {
            let mut archives = lock_recovering(&self.archives);
            archives.retain(|_, (_, _, at)| at.elapsed() < ARCHIVE_KEEP);
            if let Some((hash, bytes, _)) = archives.get(id) {
                if hash == resolved {
                    return Ok(Arc::clone(bytes));
                }
            }
        }
        let dir = dir.to_path_buf();
        let bytes = tokio::task::spawn_blocking(move || global::pack(&dir))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let bytes = Arc::new(bytes);
        lock_recovering(&self.archives).insert(
            id.to_string(),
            (resolved.to_string(), Arc::clone(&bytes), Instant::now()),
        );
        Ok(bytes)
    }

    /// The daemon is exiting: plugin programs go with it.
    pub async fn shutdown(&self) {
        self.processes.stop_all().await;
    }

    /// A plugin's own call to OpenRemote. Each method needs a power the
    /// user approved at install.
    async fn answer(&self, id: &str, method: &str, params: Value) -> Result<Value, RpcError> {
        let plugin = self
            .plugin(id)
            .ok_or_else(|| RpcError::new(-32000, "the plugin is not installed"))?;
        let needs = |power: PluginPower, what: &str| {
            if plugin.powers.contains(&power) {
                Ok(())
            } else {
                Err(RpcError::new(
                    -32003,
                    format!("{what} needs a power this plugin wasn't given"),
                ))
            }
        };
        let supervisor = self
            .supervisor
            .upgrade()
            .ok_or_else(|| RpcError::new(-32000, "OpenRemote is stopping"))?;
        let chat_id = |params: &Value| {
            params
                .get("chat")
                .and_then(Value::as_str)
                .and_then(SessionId::parse)
                .ok_or_else(|| RpcError::new(-32602, "name the chat by its id"))
        };
        let failed = |e: crate::supervisor::SupervisorError| RpcError::new(-32000, e.to_string());
        match method {
            "chats/list" => {
                needs(PluginPower::ReadChats, "reading chats")?;
                let chats: Vec<Value> = supervisor
                    .sessions()
                    .into_iter()
                    .map(|s| {
                        json!({
                            "id": s.id,
                            "title": s.title,
                            "harness": s.harness,
                            "model": s.model,
                            "status": s.status,
                            "workspace": s.workspace,
                            "updated_at": s.updated_at,
                        })
                    })
                    .collect();
                Ok(json!({"chats": chats}))
            }
            "chats/read" => {
                needs(PluginPower::ReadChats, "reading chats")?;
                let id = chat_id(&params)?;
                let text = supervisor.condensed_chat(&id).map_err(failed)?;
                Ok(json!({"text": text}))
            }
            "chats/start" => {
                needs(PluginPower::AgentTools, "starting chats")?;
                let harness = params
                    .get("harness")
                    .and_then(Value::as_str)
                    .ok_or_else(|| RpcError::new(-32602, "name the harness"))?;
                let workspace = params
                    .get("workspace")
                    .and_then(Value::as_str)
                    .map(PathBuf::from);
                if let Some(w) = &workspace {
                    if !w.is_absolute() || !w.is_dir() {
                        return Err(RpcError::new(
                            -32602,
                            "the workspace must be a folder on this machine",
                        ));
                    }
                }
                let text = |key: &str| params.get(key).and_then(Value::as_str).map(String::from);
                // A chat a plugin starts runs with the harness's own
                // default permissions - the plugin can't grant itself
                // more than a chat the user starts gets.
                let session = supervisor
                    .create_session(
                        harness,
                        workspace,
                        text("model"),
                        text("effort"),
                        None,
                        false,
                        None,
                    )
                    .await
                    .map_err(failed)?;
                if let Some(prompt) = text("prompt") {
                    supervisor
                        .prompt(&session.id, &prompt)
                        .await
                        .map_err(failed)?;
                }
                Ok(json!({"chat": session.id}))
            }
            "chats/prompt" => {
                needs(PluginPower::AgentTools, "steering chats")?;
                let id = chat_id(&params)?;
                let text = params
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| RpcError::new(-32602, "send some text"))?;
                supervisor.queue_add(&id, text).await.map_err(failed)?;
                Ok(json!({"queued": true}))
            }
            "chats/stop" => {
                needs(PluginPower::AgentTools, "stopping chats")?;
                let id = chat_id(&params)?;
                supervisor.stop(&id).await.map_err(failed)?;
                Ok(json!({"stopped": true}))
            }
            other => Err(RpcError::new(
                -32601,
                format!("OpenRemote offers no method {other}"),
            )),
        }
    }
}

/// A tool's answer as MCP shapes it: an MCP result passes as it is; a
/// bare string becomes its text.
pub fn tool_result(answer: Value) -> Value {
    match answer {
        Value::Object(ref fields) if fields.get("content").is_some_and(Value::is_array) => answer,
        Value::String(text) => json!({"content": [{"type": "text", "text": text}]}),
        other => json!({"content": [{"type": "text", "text": other.to_string()}]}),
    }
}

pub fn error_result(text: &str) -> Value {
    json!({"content": [{"type": "text", "text": text}], "isError": true})
}
