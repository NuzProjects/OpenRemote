//! The browser across the user's devices, for agents: which devices they
//! can reach and the names those devices' tabs go by (`pixel-8:tab-2`),
//! where a chat's new tabs open (the device its user last messaged from;
//! this computer's own addresses, like localhost, always here), and the
//! calls that cross the mesh to another device's browser, where that
//! device's own holds and take-over rule apply.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use openremote_browser::{Call, TabInfo};
use openremote_cloud::rpc::Request;
use openremote_core::DeviceId;
use serde_json::{Value, json};

use super::Chat;
use crate::app::App;

/// How long another device gets to list its tabs before it is left out.
const LIST_WAIT: Duration = Duration::from_secs(4);

/// One of the user's devices, as agents name it.
#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub id: DeviceId,
    pub name: String,
    /// What its tabs are prefixed with: its name made plain (`pixel-8`).
    pub key: String,
    pub platform: String,
    pub online: bool,
    /// This device.
    pub this: bool,
}

/// A name made plain for a tab id: lowercase letters, digits and dashes.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "device".into()
    } else {
        out.to_string()
    }
}

/// The account's devices, this one included, each with a key no other
/// shares (two "laptop"s become `laptop` and `laptop-2`, in the order of
/// their ids, so the names stay put). None outside Cloud.
pub fn devices(app: &App) -> Vec<Device> {
    let Some(mesh) = app.cloud.mesh() else {
        return Vec::new();
    };
    let me = mesh.me();
    let mut peers = mesh.peers();
    peers.sort_by_key(|p| p.id.to_string());
    let mut taken: Vec<String> = Vec::new();
    peers
        .into_iter()
        .map(|peer| {
            let base = slug(&peer.name);
            let mut key = base.clone();
            let mut n = 2;
            while taken.contains(&key) {
                key = format!("{base}-{n}");
                n += 1;
            }
            taken.push(key.clone());
            Device {
                id: peer.id,
                this: peer.id == me,
                name: peer.name,
                key,
                platform: peer.platform,
                online: peer.online,
            }
        })
        .collect()
}

/// A device by any of the names an agent might use: its key, its name, or
/// its id.
pub fn find<'a>(devices: &'a [Device], named: &str) -> Option<&'a Device> {
    let named = named.trim();
    devices.iter().find(|d| {
        d.key.eq_ignore_ascii_case(named)
            || d.name.eq_ignore_ascii_case(named)
            || d.id.to_string() == named
    })
}

/// A tab's id as the other device knows it: "3" and "tab 3" both mean
/// `tab-3`, the way this device reads them.
pub fn tab_id(named: &str) -> String {
    let named = named.trim();
    let bare = named
        .strip_prefix("tab")
        .map(|rest| rest.trim_start_matches(['-', ' ']))
        .unwrap_or(named);
    if !bare.is_empty() && bare.chars().all(|c| c.is_ascii_digit()) {
        format!("tab-{bare}")
    } else {
        named.to_string()
    }
}

/// The host of an address that has a scheme.
fn host_of(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    Some(host.trim_end_matches('.').to_ascii_lowercase())
}

/// Whether a host is this computer itself.
fn is_loopback(host: &str) -> bool {
    let numbers: Vec<&str> = host.split('.').collect();
    host == "localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || host == "0.0.0.0"
        || (numbers.len() == 4
            && numbers[0] == "127"
            && numbers
                .iter()
                .all(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())))
}

/// Schemes an address keeps as it is written.
const OWN_SCHEMES: &[&str] = &["about:", "data:", "file:", "blob:"];

/// An address as agents write it, made whole: one without a scheme gets
/// `http://` when it names this computer (a dev server rarely speaks TLS)
/// and `https://` otherwise.
pub fn normalize(url: &str) -> String {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if url.contains("://") || OWN_SCHEMES.iter().any(|s| lower.starts_with(s)) {
        return url.to_string();
    }
    let probe = format!("http://{url}");
    match host_of(&probe) {
        Some(host) if is_loopback(&host) => probe,
        _ => format!("https://{url}"),
    }
}

/// Whether an address only works on this computer: its own servers
/// (localhost, 127.0.0.1, ::1) and its files. Such a tab opens here,
/// whoever the user is talking from, and they can watch it live.
pub fn is_local(url: &str) -> bool {
    let url = normalize(url);
    if url.to_ascii_lowercase().starts_with("file:") {
        return true;
    }
    host_of(&url).is_some_and(|host| is_loopback(&host))
}

/// Why a call to another device's browser didn't run there.
#[derive(Debug, PartialEq)]
pub enum Failure {
    /// The device can't be reached or has no browser open now: a new tab
    /// opens on this computer instead.
    Unavailable(String),
    /// The browser there said no (the tab is gone, the user took it over,
    /// the page refused): the agent reads why.
    Refused(String),
}

impl Failure {
    pub fn message(self) -> String {
        match self {
            Failure::Unavailable(why) | Failure::Refused(why) => why,
        }
    }
}

/// A browser call on another device, for a chat here: answered with the
/// browser's own answer, or why not.
pub async fn call(
    app: &App,
    device: &Device,
    chat: &Chat,
    call: Call,
    wait: Duration,
) -> Result<Value, Failure> {
    let Some(mesh) = app.cloud.mesh() else {
        return Err(Failure::Unavailable(
            "this computer isn't signed in to OpenRemote Cloud".into(),
        ));
    };
    let body = json!({"chat": {"id": chat.id, "title": chat.title}, "call": call});
    let request = Request {
        method: "POST".into(),
        path: "/browser/rpc".into(),
        content_type: Some("application/json".into()),
        body: body.to_string().into_bytes(),
    };
    let response = mesh
        .request(device.id, request, wait + Duration::from_secs(5))
        .await
        .map_err(|e| Failure::Unavailable(e.to_string()))?;
    let answer: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    let said = answer
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string);
    match response.status {
        200 => match said {
            Some(error) => Err(Failure::Refused(error)),
            None => Ok(answer.get("ok").cloned().unwrap_or(Value::Null)),
        },
        404 => Err(Failure::Refused(said.unwrap_or_else(|| {
            format!(
                "there's no such tab on {}; browser_tabs lists them",
                device.name
            )
        }))),
        409 => Err(Failure::Unavailable(format!(
            "{} has no browser open (OpenRemote's app isn't running there)",
            device.name
        ))),
        // A device on an OpenRemote from before browsers crossed devices.
        403 => Err(Failure::Unavailable(format!(
            "{} needs a newer OpenRemote to share its browser",
            device.name
        ))),
        _ => {
            Err(Failure::Unavailable(said.unwrap_or_else(|| {
                format!("{} answered oddly", device.name)
            })))
        }
    }
}

/// One other device's open tabs.
pub struct Elsewhere {
    pub device: Device,
    pub tabs: Vec<TabInfo>,
}

/// The tabs open on the user's other devices that have a browser open
/// now, asked of every online one at once; a device that doesn't answer in
/// a few seconds is left out.
pub async fn tabs_elsewhere(app: &App) -> Vec<Elsewhere> {
    let Some(mesh) = app.cloud.mesh() else {
        return Vec::new();
    };
    let asks = devices(app)
        .into_iter()
        .filter(|d| !d.this && d.online)
        .map(|device| {
            let mesh = Arc::clone(&mesh);
            async move {
                let request = Request {
                    method: "GET".into(),
                    path: "/browser/tabs".into(),
                    content_type: None,
                    body: Vec::new(),
                };
                let response = mesh.request(device.id, request, LIST_WAIT).await.ok()?;
                if response.status != 200 {
                    return None;
                }
                let body: Value = serde_json::from_slice(&response.body).ok()?;
                let tabs = serde_json::from_value(body.get("tabs")?.clone()).ok()?;
                Some(Elsewhere { device, tabs })
            }
        });
    futures_util::future::join_all(asks)
        .await
        .into_iter()
        .flatten()
        .collect()
}

/// The tabs on the user's other devices, for the console's lists ("Tabs on
/// <device>"): each device with a browser open now, and its tabs.
pub async fn remote_tabs(State(app): State<Arc<App>>) -> Response {
    let found = tabs_elsewhere(&app).await;
    let devices: Vec<Value> = found
        .into_iter()
        .map(|e| {
            json!({
                "device": {
                    "id": e.device.id,
                    "name": e.device.name,
                    "key": e.device.key,
                    "platform": e.device.platform,
                },
                "tabs": e.tabs,
            })
        })
        .collect();
    Json(json!({"devices": devices})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_on_this_computer_stay_here() {
        for local in [
            "localhost:3000",
            "http://localhost:5173/app",
            "127.0.0.1:8080",
            "http://[::1]:4000/",
            "https://app.localhost/",
            "file:///C:/site/index.html",
            "http://0.0.0.0:3000",
        ] {
            assert!(is_local(local), "{local}");
        }
        for web in [
            "example.com",
            "https://127.example.com/",
            "https://localhost.example.com/",
            "about:blank",
        ] {
            assert!(!is_local(web), "{web}");
        }
        assert_eq!(normalize("localhost:3000"), "http://localhost:3000");
        assert_eq!(normalize("example.com/a"), "https://example.com/a");
        assert_eq!(normalize("about:blank"), "about:blank");
    }

    #[test]
    fn tabs_elsewhere_go_by_their_devices_plain_names() {
        assert_eq!(slug("Google Pixel 8"), "google-pixel-8");
        assert_eq!(slug("  --  "), "device");
        assert_eq!(tab_id("3"), "tab-3");
        assert_eq!(tab_id("tab 3"), "tab-3");
        assert_eq!(tab_id("tab-12"), "tab-12");
        assert_eq!(tab_id("t9"), "t9");
    }
}
