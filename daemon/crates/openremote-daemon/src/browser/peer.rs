//! What the user's other devices may ask of this device's browser: its
//! tabs, their agents' calls, and live views. Behind the peer gate's
//! browser tier, which lets in any of the account's devices while a
//! browser runs here. A private tab never answers (the same 404 as no tab
//! at all), and nothing about saved passwords is on any of these routes.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use openremote_browser::Call;
use serde::Deserialize;
use serde_json::json;

use super::{live, remote};
use crate::app::App;

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/browser/tabs", get(tabs))
        .route("/browser/rpc", post(rpc))
        .route("/browser/views", post(live::start_view))
        .route("/browser/views/{id}", delete(live::stop_view))
        .route("/browser/views/{id}/control", post(live::control_view))
}

/// The answer when no browser runs here (a machine's service, or the app
/// closed): the caller falls back to another device.
pub fn no_browser() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"error": "there's no browser open on this device", "code": "no_browser"})),
    )
        .into_response()
}

fn bad(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

/// This device's tabs, as another device may see them.
async fn tabs(State(app): State<Arc<App>>) -> Response {
    let browser = &app.browser;
    if !browser.connected() {
        return no_browser();
    }
    Json(json!({"status": browser.status(), "tabs": browser.peer_tabs()})).into_response()
}

#[derive(Deserialize)]
struct RemoteChat {
    id: String,
    #[serde(default)]
    title: String,
}

#[derive(Deserialize)]
struct RpcBody {
    chat: RemoteChat,
    call: Call,
}

/// Whether another device's agent may make this call here: reading and
/// acting on pages, opening and closing tabs. Never putting this device's
/// own files into a page, marking tabs, moving the user's view, or a live
/// view's own calls.
fn allowed(call: &Call) -> bool {
    !matches!(
        call,
        Call::Upload { .. }
            | Call::Mark { .. }
            | Call::Select { .. }
            | Call::Tabs
            | Call::Screencast { .. }
            | Call::FrameAck { .. }
            | Call::Input { .. }
    )
}

/// Whether an address is a web page another device's agent may open here:
/// never this device's own servers or files (a chat's localhost opens on
/// the computer that runs it).
fn web_page(url: &str) -> bool {
    let url = remote::normalize(url);
    let lower = url.to_ascii_lowercase();
    lower == "about:blank"
        || ((lower.starts_with("https://") || lower.starts_with("http://"))
            && !remote::is_local(&url))
}

/// A browser call from an agent on another of the user's devices. The
/// answer is the browser's (`ok`), or why not (`error`): the agent reads
/// it either way.
async fn rpc(State(app): State<Arc<App>>, Json(body): Json<RpcBody>) -> Response {
    let browser = &app.browser;
    if !browser.connected() {
        return no_browser();
    }
    if !allowed(&body.call) {
        return bad(
            StatusCode::FORBIDDEN,
            "another device can't ask that of this browser",
        );
    }
    if let Call::Open { url, .. } | Call::Navigate { url, .. } = &body.call {
        if !web_page(url) {
            return Json(json!({
                "error": "Another device's agent can only open web pages here, not this device's own addresses or files.",
            }))
            .into_response();
        }
    }
    if let Some(tab) = body.call.tab() {
        if !browser.shared_with_peers(tab) {
            return bad(StatusCode::NOT_FOUND, "there's no such tab on that device");
        }
    }
    let chat = if body.chat.title.trim().is_empty() {
        "A chat".to_string()
    } else {
        body.chat.title.clone()
    };
    match browser.run_for_peer(&body.chat.id, &chat, body.call).await {
        Ok(ok) => Json(json!({"ok": ok})).into_response(),
        Err(error) => Json(json!({"error": error})).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn another_devices_agent_gets_web_pages_only() {
        assert!(web_page("https://example.com/"));
        assert!(web_page("example.com"));
        assert!(web_page("about:blank"));
        assert!(!web_page("http://localhost:3000/"));
        assert!(!web_page("file:///C:/Users/me/secrets.txt"));
        assert!(!web_page("data:text/html,hi"));
        assert!(!allowed(&Call::Upload {
            tab: "tab-1".into(),
            target: "e1".into(),
            paths: vec![],
        }));
        assert!(allowed(&Call::Snapshot {
            tab: "tab-1".into()
        }));
    }
}
