//! What a JavaScript plugin reaches through the console that hosts it. The
//! console loads a plugin's page from the plugin's own files (the plugin
//! runtime's files route) into a sandboxed frame and answers the frame's
//! calls; whatever needs this machine - the network, the chats - comes
//! here, and each route checks the power the user approved at install.
//!
//! A plugin's secrets never leave this daemon. The plugin runtime's
//! settings route says only whether one is set, and a secret reaches the
//! outside world only inside the plugin's own request, written into the
//! header that names it - and, when the plugin declares it so, only toward
//! the address the user typed in another of its settings.
//!
//! Console-only, like the browser's routes: none of these answers the
//! user's other devices.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use openremote_cloud::https::HttpError;
use openremote_core::{
    EventPayload, InstalledPlugin, MessageRole, PluginPower, SessionId, SettingField, SettingKind,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::app::App;

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

pub fn routes() -> Router<Arc<App>> {
    Router::new()
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
    declared: &[SettingField],
    stored: &Map<String, Value>,
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
        let Some(secret) = stored
            .get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return Ok(None);
        };
        if let Some(guard) = &setting.send_to {
            let address = stored
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
        (
            plugin.contributes.settings.clone(),
            app.plugin_runtime.settings.load(&plugin.id()),
        )
    } else {
        (Vec::new(), Map::new())
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
