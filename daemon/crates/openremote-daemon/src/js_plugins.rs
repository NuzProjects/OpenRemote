//! What a JavaScript plugin reaches through the console that hosts it. The
//! console loads a plugin's page from the plugin's own files into a
//! sandboxed frame and answers the frame's calls; whatever needs this
//! machine - the plugin's settings, the network, the chats - comes here,
//! and each route checks the power the user approved at install.
//!
//! A plugin's secrets never leave this daemon. The settings route says only
//! whether one is set, and a secret reaches the outside world only inside
//! the plugin's own request, written into the header that names it - and,
//! when the plugin declares it so, only toward the address the user typed
//! in another of its settings.
//!
//! Console-only, like the browser's routes: none of these answers the
//! user's other devices.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use openremote_cloud::https::HttpError;
use openremote_core::{EventPayload, InstalledPlugin, MessageRole, PluginPower, SessionId};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::app::App;

/// A plugin file is refused past this size: pages, scripts and pictures,
/// not media libraries.
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// A plugin's request arrives as base64 inside JSON: room for about 32 MB
/// of bytes, past the 25 MB the common transcription services accept.
const MAX_FETCH_BODY: usize = 48 * 1024 * 1024;

const DEFAULT_FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_FETCH_TIMEOUT: Duration = Duration::from_secs(300);

/// How a header names one of the plugin's secrets: `{{secret:api_key}}`.
const SECRET_OPEN: &str = "{{secret:";
const SECRET_CLOSE: &str = "}}";

/// Headers a plugin's request may not set: the connection's own, and the
/// ones the client writes itself.
const FORBIDDEN_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "user-agent",
    "cookie",
];

const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/// A chat read for a plugin carries at most its last this many entries.
const MAX_READ_ENTRIES: usize = 2000;

/// One save at a time: a save reads the file, changes it and writes it back.
static SETTINGS_WRITE: StdMutex<()> = StdMutex::new(());

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/plugins/{id}/files/{*path}", get(file))
        .route("/plugins/{id}/settings", get(settings).post(save_settings))
        .route(
            "/plugins/{id}/fetch",
            post(fetch).layer(DefaultBodyLimit::max(MAX_FETCH_BODY)),
        )
        .route("/plugins/{id}/chats/{chat}", get(read_chat))
}

fn bad(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

/// A refused request: the status it answers with, and its words.
type Refusal = (StatusCode, String);

fn refused((status, why): Refusal) -> Response {
    bad(status, &why)
}

/// The installed plugin an id (`name@marketplace`) names.
fn installed(app: &App, id: &str) -> Result<InstalledPlugin, Refusal> {
    let store = crate::supervisor::lock_recovering(&app.store);
    store
        .installed_plugin(id)
        .cloned()
        .map_err(|_| (StatusCode::NOT_FOUND, format!("{id} is not installed")))
}

fn power_words(power: PluginPower) -> &'static str {
    match power {
        PluginPower::RunPrograms => "run programs",
        PluginPower::ReadChats => "read chats",
        PluginPower::AgentTools => "start, steer and stop chats",
        PluginPower::Network => "reach the internet",
        PluginPower::Microphone => "use the microphone",
    }
}

/// A plugin that is on, and was given `power` when it was installed.
fn granted(plugin: &InstalledPlugin, power: PluginPower) -> Result<(), Refusal> {
    if !plugin.enabled {
        return Err((
            StatusCode::FORBIDDEN,
            format!("{} is turned off", plugin.name),
        ));
    }
    if !plugin.powers.contains(&power) {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "{} may not {}: that power was not approved when it was installed",
                plugin.name,
                power_words(power)
            ),
        ));
    }
    Ok(())
}

// ---- files: the plugin's page, scripts and pictures ----

/// A file of an installed plugin, for the console that builds the plugin's
/// page from it. Only what sits inside the plugin's own folder: no `..`,
/// and no link that points out of it.
async fn file(
    State(app): State<Arc<App>>,
    AxumPath((id, path)): AxumPath<(String, String)>,
) -> Response {
    let plugin = match installed(&app, &id) {
        Ok(plugin) => plugin,
        Err(refusal) => return refused(refusal),
    };
    if !crate::plugins::relative_inside(&path) {
        return bad(
            StatusCode::BAD_REQUEST,
            "that path leaves the plugin's folder",
        );
    }
    let missing = || {
        bad(
            StatusCode::NOT_FOUND,
            &format!("{} has no file {path}", plugin.name),
        )
    };
    let folder = app.plugins.dir_of(&plugin.marketplace, &plugin.name);
    let (Ok(root), Ok(target)) = (
        std::fs::canonicalize(&folder),
        std::fs::canonicalize(folder.join(&path)),
    ) else {
        return missing();
    };
    if !target.starts_with(&root) {
        return missing();
    }
    match std::fs::metadata(&target) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => {}
        Ok(meta) if meta.is_file() => {
            return bad(StatusCode::PAYLOAD_TOO_LARGE, "that file is too large");
        }
        _ => return missing(),
    }
    match tokio::fs::read(&target).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, content_type(&target)),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => missing(),
    }
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "webm" => "audio/webm",
        "mp4" => "video/mp4",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// ---- settings: the form the console draws, the values the plugin reads ----

/// One setting a plugin's openremote.json declares. The console draws the
/// form from the same list (with its label and help); here only what a
/// value must be matters.
#[derive(Deserialize, Clone, Debug)]
struct Setting {
    key: String,
    #[serde(rename = "type")]
    kind: SettingKind,
    #[serde(default)]
    default: Option<Value>,
    /// An enum's choices: plain strings, or `{value, label}`.
    #[serde(default)]
    options: Vec<Value>,
    #[serde(default)]
    min: Option<f64>,
    #[serde(default)]
    max: Option<f64>,
    /// A secret's guard: it is written into a request only when the request
    /// goes to the address this other (string) setting holds.
    #[serde(default, rename = "sendTo")]
    send_to: Option<String>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum SettingKind {
    String,
    Secret,
    Boolean,
    Number,
    Enum,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn option_value(option: &Value) -> Option<&str> {
    option
        .as_str()
        .or_else(|| option.get("value").and_then(Value::as_str))
}

/// The settings a plugin folder's openremote.json declares, in its order.
/// A plugin without the file, or without settings, has none.
fn schema(dir: &Path) -> Result<Vec<Setting>, String> {
    #[derive(Deserialize)]
    struct Declared {
        #[serde(default)]
        settings: Vec<Setting>,
    }
    let raw = match std::fs::read(dir.join("openremote.json")) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("openremote.json could not be read: {e}")),
    };
    let declared: Declared = serde_json::from_slice(&raw)
        .map_err(|e| format!("openremote.json's settings are not valid: {e}"))?;
    let mut seen = HashSet::new();
    for setting in &declared.settings {
        if !valid_key(&setting.key) {
            return Err(format!(
                "'{}' is not a setting name: lowercase letters, digits and underscores",
                setting.key
            ));
        }
        if !seen.insert(setting.key.as_str()) {
            return Err(format!("the setting {} is declared twice", setting.key));
        }
        if setting.kind == SettingKind::Enum && setting.options.is_empty() {
            return Err(format!("the setting {} offers no options", setting.key));
        }
        if let Some(to) = &setting.send_to {
            let target = declared.settings.iter().find(|s| &s.key == to);
            if setting.kind != SettingKind::Secret
                || target.is_none_or(|s| s.kind != SettingKind::String)
            {
                return Err(format!(
                    "the setting {}'s sendTo must name a text setting, and only a secret has one",
                    setting.key
                ));
            }
        }
    }
    Ok(declared.settings)
}

/// A plugin's settings on disk: the values it may read back, and its
/// secrets. One private file per plugin, like the token.
#[derive(Serialize, Deserialize, Default)]
struct Stored {
    #[serde(default)]
    values: Map<String, Value>,
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

fn settings_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("plugin-settings")
}

fn settings_file(data_dir: &Path, marketplace: &str, name: &str) -> PathBuf {
    settings_dir(data_dir)
        .join(marketplace)
        .join(format!("{name}.json"))
}

fn load(path: &Path) -> Stored {
    std::fs::read(path)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn store(data_dir: &Path, path: &Path, stored: &Stored) -> std::io::Result<()> {
    openremote_core::fsx::create_private_dir(&settings_dir(data_dir))?;
    if let Some(parent) = path.parent() {
        openremote_core::fsx::create_private_dir(parent)?;
    }
    openremote_core::fsx::write_private(
        path,
        &serde_json::to_vec_pretty(stored).expect("settings serialize"),
    )
}

/// A removed plugin's settings go with it, its secrets included.
pub fn forget_settings(data_dir: &Path, marketplace: &str, name: &str) {
    let _ = std::fs::remove_file(settings_file(data_dir, marketplace, name));
}

/// The settings as the console and the plugin read them: every value (the
/// plugin's default where none was saved) and, for each secret, only
/// whether it is set.
fn view(schema: &[Setting], stored: &Stored) -> Value {
    let mut values = Map::new();
    let mut secrets = Map::new();
    for setting in schema {
        if setting.kind == SettingKind::Secret {
            let set = stored
                .secrets
                .get(&setting.key)
                .is_some_and(|v| !v.is_empty());
            secrets.insert(
                setting.key.clone(),
                Value::String(if set { "set" } else { "unset" }.into()),
            );
        } else {
            let value = stored
                .values
                .get(&setting.key)
                .cloned()
                .or_else(|| setting.default.clone())
                .unwrap_or(Value::Null);
            values.insert(setting.key.clone(), value);
        }
    }
    json!({"values": values, "secrets": secrets})
}

/// A value as its setting takes it, or what is wrong with it in plain words.
fn checked(setting: &Setting, value: &Value) -> Result<Value, String> {
    let key = &setting.key;
    match setting.kind {
        SettingKind::String => value
            .as_str()
            .map(|s| Value::String(s.to_string()))
            .ok_or_else(|| format!("{key} takes text")),
        SettingKind::Boolean => value
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| format!("{key} is on or off")),
        SettingKind::Number => {
            let n = value
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| format!("{key} takes a number"))?;
            let low = setting.min.is_some_and(|min| n < min);
            let high = setting.max.is_some_and(|max| n > max);
            if low || high {
                return Err(match (setting.min, setting.max) {
                    (Some(min), Some(max)) => format!("{key} takes a number from {min} to {max}"),
                    (Some(min), None) => format!("{key} takes a number of at least {min}"),
                    _ => format!(
                        "{key} takes a number of at most {}",
                        setting.max.unwrap_or_default()
                    ),
                });
            }
            Ok(value.clone())
        }
        SettingKind::Enum => {
            let chosen = value
                .as_str()
                .ok_or_else(|| format!("{key} takes one of its options"))?;
            if setting
                .options
                .iter()
                .any(|o| option_value(o) == Some(chosen))
            {
                Ok(Value::String(chosen.to_string()))
            } else {
                Err(format!("{chosen} is not one of {key}'s options"))
            }
        }
        SettingKind::Secret => Err(format!("{key} is a secret")),
    }
}

async fn settings(State(app): State<Arc<App>>, AxumPath(id): AxumPath<String>) -> Response {
    let plugin = match installed(&app, &id) {
        Ok(plugin) => plugin,
        Err(refusal) => return refused(refusal),
    };
    let declared = match schema(&app.plugins.dir_of(&plugin.marketplace, &plugin.name)) {
        Ok(declared) => declared,
        Err(why) => return bad(StatusCode::BAD_REQUEST, &why),
    };
    let stored = load(&settings_file(
        &app.data_dir,
        &plugin.marketplace,
        &plugin.name,
    ));
    Json(view(&declared, &stored)).into_response()
}

/// The console's save. A setting not named keeps its value; a value of
/// null goes back to the plugin's default. A secret is replaced only when
/// the save names it - with text it is replaced, with null or nothing it
/// is cleared. Nothing is written unless every value is right. Keyed by
/// setting name, so a retried save lands the same way twice.
#[derive(Deserialize)]
struct SaveBody {
    #[serde(default)]
    values: Map<String, Value>,
}

async fn save_settings(
    State(app): State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<SaveBody>,
) -> Response {
    let plugin = match installed(&app, &id) {
        Ok(plugin) => plugin,
        Err(refusal) => return refused(refusal),
    };
    let declared = match schema(&app.plugins.dir_of(&plugin.marketplace, &plugin.name)) {
        Ok(declared) => declared,
        Err(why) => return bad(StatusCode::BAD_REQUEST, &why),
    };
    let path = settings_file(&app.data_dir, &plugin.marketplace, &plugin.name);
    let _one_at_a_time = crate::supervisor::lock_recovering(&SETTINGS_WRITE);
    let mut stored = load(&path);
    for (key, value) in &body.values {
        let Some(setting) = declared.iter().find(|s| &s.key == key) else {
            return bad(
                StatusCode::BAD_REQUEST,
                &format!("{} has no setting {key}", plugin.name),
            );
        };
        if setting.kind == SettingKind::Secret {
            match value {
                Value::String(secret) if !secret.is_empty() => {
                    stored.secrets.insert(key.clone(), secret.clone());
                }
                Value::Null | Value::String(_) => {
                    stored.secrets.remove(key);
                }
                _ => return bad(StatusCode::BAD_REQUEST, &format!("{key} takes text")),
            }
        } else if value.is_null() {
            stored.values.remove(key);
        } else {
            match checked(setting, value) {
                Ok(value) => {
                    stored.values.insert(key.clone(), value);
                }
                Err(why) => return bad(StatusCode::BAD_REQUEST, &why),
            }
        }
    }
    if let Err(e) = store(&app.data_dir, &path, &stored) {
        return bad(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("the settings could not be saved: {e}"),
        );
    }
    Json(view(&declared, &stored)).into_response()
}

// ---- fetch: the network, for a plugin given it ----

/// A plugin's request, as its frame made it: the console carries it here
/// unchanged, the body as base64.
#[derive(Deserialize)]
struct FetchBody {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

/// Whether `url` is at or under `base`: the same scheme, host and port, and
/// a path that continues the base's at a segment boundary - so
/// `https://api.example.com/v1` admits `/v1/audio` but neither `/v1x` nor
/// another host that merely starts the same way.
fn goes_to(url: &str, base: &str) -> bool {
    let (Ok(url), Ok(base)) = (url.parse::<Uri>(), base.trim().parse::<Uri>()) else {
        return false;
    };
    let scheme = |u: &Uri| u.scheme_str().map(str::to_ascii_lowercase);
    let host = |u: &Uri| u.host().map(str::to_ascii_lowercase);
    let port = |u: &Uri| {
        u.port_u16().or(
            match u.scheme_str().map(str::to_ascii_lowercase).as_deref() {
                Some("https") => Some(443),
                Some("http") => Some(80),
                _ => None,
            },
        )
    };
    if scheme(&url).is_none()
        || scheme(&url) != scheme(&base)
        || host(&url).is_none()
        || host(&url) != host(&base)
        || port(&url) != port(&base)
    {
        return false;
    }
    let prefix = base.path().trim_end_matches('/');
    let path = url.path();
    prefix.is_empty() || path == prefix || path.starts_with(&format!("{prefix}/"))
}

/// Write the plugin's secrets into a header value where it names them.
/// Answers None when a named secret is not set: the header is then left
/// out, so a service that needs no key gets none.
fn fill_secrets(
    value: &str,
    declared: &[Setting],
    stored: &Stored,
    url: &str,
) -> Result<Option<String>, (StatusCode, String)> {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find(SECRET_OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + SECRET_OPEN.len()..];
        let Some(end) = after.find(SECRET_CLOSE) else {
            return Err((
                StatusCode::BAD_REQUEST,
                "a secret named in a header is not closed".into(),
            ));
        };
        let name = after[..end].trim();
        let Some(setting) = declared
            .iter()
            .find(|s| s.key == name && s.kind == SettingKind::Secret)
        else {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("{name} is not one of the plugin's secrets"),
            ));
        };
        let Some(secret) = stored.secrets.get(name).filter(|s| !s.is_empty()) else {
            return Ok(None);
        };
        if let Some(guard) = &setting.send_to {
            let address = stored
                .values
                .get(guard)
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    declared
                        .iter()
                        .find(|s| &s.key == guard)
                        .and_then(|s| s.default.as_ref())
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            if address.trim().is_empty() || !goes_to(url, &address) {
                return Err((
                    StatusCode::FORBIDDEN,
                    format!("the {name} setting is sent only to the address in {guard}"),
                ));
            }
        }
        out.push_str(secret);
        rest = &after[end + SECRET_CLOSE.len()..];
    }
    out.push_str(rest);
    Ok(Some(out))
}

/// Make a plugin's request, if it was given the network. The answer comes
/// back whole - status, headers and body (base64) - redirects included as
/// they are: nothing is followed for the plugin.
async fn fetch(
    State(app): State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<FetchBody>,
) -> Response {
    let plugin = match installed(&app, &id) {
        Ok(plugin) => plugin,
        Err(refusal) => return refused(refusal),
    };
    if let Err(refusal) = granted(&plugin, PluginPower::Network) {
        return refused(refusal);
    }
    let url = body.url.trim().to_string();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return bad(
            StatusCode::BAD_REQUEST,
            "a plugin reaches http and https addresses only",
        );
    }
    let method = body
        .method
        .as_deref()
        .unwrap_or("GET")
        .trim()
        .to_ascii_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return bad(
            StatusCode::BAD_REQUEST,
            &format!("{method} is not a request a plugin may make"),
        );
    }
    let bytes = match body.body.as_deref().filter(|b| !b.is_empty()) {
        None => None,
        Some(encoded) => match base64::engine::general_purpose::STANDARD.decode(encoded) {
            Ok(bytes) => Some(bytes),
            Err(_) => return bad(StatusCode::BAD_REQUEST, "the request body is not base64"),
        },
    };
    // The secrets are read only when a header names one.
    let names_secret = body.headers.iter().any(|(_, v)| v.contains(SECRET_OPEN));
    let (declared, stored) = if names_secret {
        match schema(&app.plugins.dir_of(&plugin.marketplace, &plugin.name)) {
            Ok(declared) => (
                declared,
                load(&settings_file(
                    &app.data_dir,
                    &plugin.marketplace,
                    &plugin.name,
                )),
            ),
            Err(why) => return bad(StatusCode::BAD_REQUEST, &why),
        }
    } else {
        (Vec::new(), Stored::default())
    };
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_type = None;
    for (name, value) in &body.headers {
        let name = name.trim().to_ascii_lowercase();
        if FORBIDDEN_HEADERS.contains(&name.as_str())
            || name.starts_with("proxy-")
            || name.starts_with("sec-")
        {
            continue;
        }
        let value = match fill_secrets(value, &declared, &stored, &url) {
            Ok(Some(value)) => value,
            Ok(None) => continue,
            Err((status, why)) => return bad(status, &why),
        };
        if name == "content-type" {
            content_type = Some(value);
        } else {
            headers.push((name, value));
        }
    }
    let limit = body
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_FETCH_TIMEOUT)
        .min(MAX_FETCH_TIMEOUT);
    let pairs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(n, v)| (n.as_str(), v.as_str()))
        .collect();
    let payload = bytes.map(|b| {
        (
            content_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
            b,
        )
    });
    let http = openremote_cloud::https::Http::new();
    match http
        .request_within(limit, &method, &url, &pairs, payload)
        .await
    {
        Ok(response) => {
            let headers: Vec<(String, String)> = response
                .headers
                .iter()
                .filter_map(|(n, v)| {
                    v.to_str()
                        .ok()
                        .map(|v| (n.as_str().to_string(), v.to_string()))
                })
                .collect();
            Json(json!({
                "status": response.status,
                "headers": headers,
                "body": base64::engine::general_purpose::STANDARD.encode(&response.body),
            }))
            .into_response()
        }
        Err(HttpError::Timeout) => bad(
            StatusCode::GATEWAY_TIMEOUT,
            &format!("{url} did not answer in time"),
        ),
        Err(HttpError::Url(_)) => bad(StatusCode::BAD_REQUEST, &format!("{url} is not an address")),
        Err(HttpError::Connect(host)) => {
            bad(StatusCode::BAD_GATEWAY, &format!("couldn't reach {host}"))
        }
        Err(HttpError::Protocol(why)) => bad(StatusCode::BAD_GATEWAY, &why),
    }
}

// ---- chats: reading one, for a plugin given it ----

/// One chat for a plugin that may read chats: its facts, then its messages
/// in order, each tool call a one-line entry.
async fn read_chat(
    State(app): State<Arc<App>>,
    AxumPath((id, chat)): AxumPath<(String, String)>,
) -> Response {
    let plugin = match installed(&app, &id) {
        Ok(plugin) => plugin,
        Err(refusal) => return refused(refusal),
    };
    if let Err(refusal) = granted(&plugin, PluginPower::ReadChats) {
        return refused(refusal);
    }
    let Some(chat_id) = SessionId::parse(&chat) else {
        return bad(StatusCode::NOT_FOUND, "no such chat");
    };
    let (session, events) = {
        let store = crate::supervisor::lock_recovering(&app.store);
        let Ok(session) = store.session(&chat_id).cloned() else {
            return bad(StatusCode::NOT_FOUND, "no such chat");
        };
        let Ok(events) = store.events_after(&chat_id, None) else {
            return bad(StatusCode::NOT_FOUND, "no such chat");
        };
        (session, events)
    };
    let mut messages: Vec<Value> = Vec::new();
    for event in events {
        match event.payload {
            EventPayload::MessageAdded { message } => {
                let role = match message.role {
                    MessageRole::User => "user",
                    MessageRole::Assistant => "assistant",
                };
                messages.push(json!({"role": role, "text": message.text}));
            }
            EventPayload::ToolStarted { name, .. } => {
                messages.push(json!({"role": "tool", "name": name}));
            }
            _ => {}
        }
    }
    let cut = messages.len().saturating_sub(MAX_READ_ENTRIES);
    Json(json!({
        "id": session.id,
        "title": session.title,
        "harness": session.harness,
        "model": session.model,
        "status": session.status,
        "workspace": session.workspace,
        "updated_at": session.updated_at,
        "synced": session.executor.is_some(),
        "cut": cut > 0,
        "messages": &messages[cut..],
    }))
    .into_response()
}
