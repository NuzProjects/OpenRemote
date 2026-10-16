//! Global plugins: approved once for the account, installed on every
//! device. Each device keeps the account's records (`GlobalPluginRecord`)
//! and trades them over Cloud, keeping the latest write: when two devices
//! meet they swap the whole list, and a change goes straight to every
//! device online. A device that learns of a plugin it lacks fetches the
//! files from a device that has them - over the same end-to-end encrypted
//! mesh - and installs them only if they are exactly the approved bytes
//! (by content hash) asking for no more than the approved powers. A record
//! marked removed uninstalls it everywhere. Turning a Global plugin off
//! stays on the device that did it, and so do its settings: secrets never
//! leave the device they were typed on.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use openremote_cloud::PeerContext;
use openremote_cloud::rpc::Request;
use openremote_core::{DeviceId, GlobalPluginRecord, InstalledPlugin, PluginScope};
use serde_json::{Value, json};

use crate::app::App;
use crate::supervisor::lock_recovering;

/// Archive bytes per slice: base64 of this stays well inside the mesh's
/// largest answer.
const SLICE: usize = 4 * 1024 * 1024;
/// A Global plugin's archive is refused past this size.
const MAX_ARCHIVE: usize = 256 * 1024 * 1024;

/// The record for a Global install, kept here and told to every device
/// online now.
pub async fn publish(app: &Arc<App>, plugin: &InstalledPlugin, resolved: String, removed: bool) {
    let record = {
        let mut store = lock_recovering(&app.store);
        let record = GlobalPluginRecord {
            name: plugin.name.clone(),
            marketplace: plugin.marketplace.clone(),
            version: plugin.version.clone(),
            description: plugin.description.clone(),
            runtime: plugin.runtime,
            powers: plugin.powers.clone(),
            contributes: plugin.contributes.clone(),
            source: plugin.source.clone(),
            resolved,
            fetched: plugin.resolved.clone(),
            at: openremote_core::now_ms(),
            by: store.this_device(),
            removed,
        };
        let _ = store.merge_global_plugin(record.clone());
        record
    };
    if let Some(mesh) = app.cloud.mesh() {
        let note = json!({"type": "plugins.global", "record": record});
        for peer in mesh.online() {
            let _ = mesh.note(peer, &note).await;
        }
    }
}

/// Every record this device holds, for a peer.
pub fn records(app: &App) -> Value {
    let store = lock_recovering(&app.store);
    json!({"v": 1, "plugins": store.global_plugins()})
}

/// A peer's note: one record changed.
pub fn on_note(app: &Arc<App>, peer: PeerContext, note: Value) {
    if note["type"].as_str() != Some("plugins.global") {
        return;
    }
    let Ok(record) = serde_json::from_value::<GlobalPluginRecord>(note["record"].clone()) else {
        return;
    };
    let app = Arc::clone(app);
    tokio::spawn(async move {
        let kept = lock_recovering(&app.store).merge_global_plugin(record.clone());
        if matches!(kept, Ok(true)) {
            follow(&app, record, Some(peer.device_id)).await;
        }
    });
}

async fn get(mesh: &openremote_cloud::Mesh, peer: DeviceId, path: String) -> Option<Value> {
    let response = mesh
        .request(
            peer,
            Request {
                method: "GET".into(),
                path,
                content_type: None,
                body: Vec::new(),
            },
            Duration::from_secs(120),
        )
        .await
        .ok()?;
    (response.status == 200)
        .then(|| serde_json::from_slice(&response.body).ok())
        .flatten()
}

/// Two devices met: take the peer's records, keep what is newer, and
/// bring this device in line - including records it already held but
/// couldn't follow before (the files weren't reachable then).
pub async fn sync_with(app: &Arc<App>, peer: DeviceId) {
    let Some(mesh) = app.cloud.mesh() else {
        return;
    };
    if let Some(theirs) = get(&mesh, peer, "/sync/plugins".into()).await {
        for raw in theirs["plugins"].as_array().into_iter().flatten() {
            if let Ok(record) = serde_json::from_value::<GlobalPluginRecord>(raw.clone()) {
                let _ = lock_recovering(&app.store).merge_global_plugin(record);
            }
        }
    }
    let records: Vec<GlobalPluginRecord> = lock_recovering(&app.store)
        .global_plugins()
        .into_iter()
        .cloned()
        .collect();
    for record in records {
        if !in_line(app, &record) {
            follow(app, record, Some(peer)).await;
        }
    }
}

/// Whether this device already matches a record: for a live one, its
/// Global copy holds exactly the approved bytes.
fn in_line(app: &App, record: &GlobalPluginRecord) -> bool {
    let here = lock_recovering(&app.store)
        .installed_plugin(&record.id())
        .ok()
        .cloned();
    if record.removed {
        return !here.is_some_and(|p| p.scope == PluginScope::Global);
    }
    here.is_some_and(|p| {
        p.scope == PluginScope::Global
            && super::scope::unchanged(
                &crate::plugins::plugin_dir(&app.data_dir, &p.marketplace, &p.name),
                Some(&record.resolved),
            )
    })
}

/// Bring this device in line with one record: uninstall a removed plugin,
/// or fetch and install the approved copy.
async fn follow(app: &Arc<App>, record: GlobalPluginRecord, from: Option<DeviceId>) {
    let id = record.id();
    if in_line(app, &record) {
        app.plugin_runtime.set_global_error(&id, None);
        return;
    }
    if record.removed {
        let plugin = lock_recovering(&app.store)
            .installed_plugin(&id)
            .ok()
            .cloned();
        if let Some(plugin) = plugin.filter(|p| p.scope == PluginScope::Global) {
            let _ = app.plugins.uninstall(&plugin.marketplace, &plugin.name);
            let _ = lock_recovering(&app.store).remove_installed_plugin(&id);
            app.plugin_runtime.settings.forget(&id);
            app.plugin_runtime.changed(&id).await;
            eprintln!("plugin {id}: removed, as another of your devices did");
        }
        return;
    }
    match fetch_and_install(app, &record, from).await {
        Ok(()) => {
            app.plugin_runtime.set_global_error(&id, None);
            eprintln!("plugin {id}: installed from your account");
        }
        Err(e) => {
            eprintln!("plugin {id}: can't install it from your account yet: {e}");
            app.plugin_runtime.set_global_error(&id, Some(e));
        }
    }
}

async fn fetch_and_install(
    app: &Arc<App>,
    record: &GlobalPluginRecord,
    from: Option<DeviceId>,
) -> Result<(), String> {
    let mesh = app
        .cloud
        .mesh()
        .ok_or("this device is not signed in to Cloud")?;
    let id = record.id();
    // The device that told us first, then anyone online.
    let mut peers: Vec<DeviceId> = from.into_iter().collect();
    peers.extend(mesh.online().into_iter().filter(|p| Some(*p) != from));
    let mut last = "no device that has it is online".to_string();
    let mut bytes = None;
    for peer in peers {
        match fetch_archive(&mesh, peer, &id, &record.resolved).await {
            Ok(got) => {
                bytes = Some(got);
                break;
            }
            Err(e) => last = e,
        }
    }
    let bytes = bytes.ok_or(last)?;
    let data_dir = app.data_dir.clone();
    let staging = data_dir
        .join("plugins")
        .join(".staging")
        .join(uuid::Uuid::new_v4().to_string());
    let builtin: Vec<String> = app
        .supervisor
        .harnesses()
        .into_iter()
        .filter(|h| h.plugin.is_none())
        .map(|h| h.id)
        .collect();
    let checked = {
        let staging = staging.clone();
        let record = record.clone();
        tokio::task::spawn_blocking(move || -> Result<crate::plugins::Manifest, String> {
            crate::plugins::unpack(&bytes, &staging).map_err(|e| e.to_string())?;
            let hash = crate::plugins::content_hash(&staging).map_err(|e| e.to_string())?;
            if hash != record.resolved {
                return Err("the copy that arrived is not the one you approved".into());
            }
            let manifest =
                crate::plugins::read_manifest(&staging, &builtin).map_err(|e| e.to_string())?;
            if let Some(extra) = manifest.powers.iter().find(|p| !record.powers.contains(p)) {
                return Err(format!(
                    "the copy asks for a power you didn't approve ({extra:?})"
                ));
            }
            Ok(manifest)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    let manifest = match checked {
        Ok(manifest) => manifest,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    let target = crate::plugins::plugin_dir(&data_dir, &record.marketplace, &record.name);
    let placed = crate::plugins::swap_in(&data_dir.join("plugins"), &staging, &target);
    let _ = std::fs::remove_dir_all(&staging);
    placed.map_err(|e| e.to_string())?;
    let now = openremote_core::now_ms();
    {
        let mut store = lock_recovering(&app.store);
        let before = store.installed_plugin(&id).ok().cloned();
        let plugin = InstalledPlugin {
            name: record.name.clone(),
            marketplace: record.marketplace.clone(),
            resolved: record.fetched.clone().or(Some(record.resolved.clone())),
            command: None,
            version: manifest.version.clone(),
            description: manifest.description.clone(),
            runtime: manifest.runtime,
            powers: manifest.powers.clone(),
            source: record.source.clone(),
            scope: PluginScope::Global,
            project: None,
            contributes: manifest.contributes.clone(),
            // A device that turned it off keeps it off.
            enabled: before.as_ref().is_none_or(|p| p.enabled),
            installed_at: before.as_ref().map_or(now, |p| p.installed_at),
            updated_at: now,
        };
        store
            .put_installed_plugin(plugin)
            .map_err(|e| e.to_string())?;
    }
    app.plugin_runtime.changed(&id).await;
    Ok(())
}

async fn fetch_archive(
    mesh: &openremote_cloud::Mesh,
    peer: DeviceId,
    id: &str,
    resolved: &str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    loop {
        let path = format!(
            "/sync/plugins/{}/archive?resolved={resolved}&offset={}",
            encode(id),
            bytes.len()
        );
        let slice = get(mesh, peer, path)
            .await
            .ok_or("the device that has it didn't send it")?;
        let total = slice["total"].as_u64().unwrap_or(0) as usize;
        if total > MAX_ARCHIVE {
            return Err("the plugin is too large to copy".into());
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(slice["data"].as_str().unwrap_or_default())
            .map_err(|_| "the copy arrived damaged".to_string())?;
        if data.is_empty() && bytes.len() < total {
            return Err("the copy stopped short".into());
        }
        bytes.extend_from_slice(&data);
        if bytes.len() >= total {
            return Ok(bytes);
        }
    }
}

fn encode(raw: &str) -> String {
    raw.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// A slice of this device's copy of a Global plugin, for a peer that
/// lacks it - only when the copy here is the approved one.
pub async fn archive_slice(
    app: &Arc<App>,
    id: &str,
    resolved: &str,
    offset: usize,
) -> Result<Value, (u16, String)> {
    let dir = {
        let store = lock_recovering(&app.store);
        let plugin = store
            .installed_plugin(id)
            .ok()
            .filter(|p| p.scope == PluginScope::Global)
            .ok_or((404, "no such Global plugin here".to_string()))?;
        crate::plugins::plugin_dir(&app.data_dir, &plugin.marketplace, &plugin.name)
    };
    if !super::scope::unchanged(&dir, Some(resolved)) {
        return Err((409, "this device has another copy".into()));
    }
    let archive = app
        .plugin_runtime
        .archive(id, resolved, &dir)
        .await
        .map_err(|e| (500, e))?;
    let end = (offset + SLICE).min(archive.len());
    let start = offset.min(end);
    Ok(json!({
        "total": archive.len(),
        "offset": start,
        "data": base64::engine::general_purpose::STANDARD.encode(&archive[start..end]),
    }))
}

/// A folder as a tar.gz that comes out byte for byte the same every time
/// (sorted, no owners or times), so slices built on different requests fit
/// together.
pub fn pack(dir: &Path) -> std::io::Result<Vec<u8>> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if entry.file_name() == ".git" {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_dir() {
                walk(&entry.path(), out)?;
            } else if kind.is_file() {
                out.push(entry.path());
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(dir, &mut files)?;
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut builder = tar::Builder::new(gz);
    builder.mode(tar::HeaderMode::Deterministic);
    for file in files {
        let relative = file.strip_prefix(dir).unwrap_or(&file);
        builder.append_path_with_name(&file, relative)?;
    }
    builder.into_inner()?.finish()
}
