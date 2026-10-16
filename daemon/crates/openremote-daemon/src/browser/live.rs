//! Live views: a tab on one of the user's devices shown on another, as
//! pictures that follow the page, with taps, swipes and typing going back.
//!
//! The device with the tab (the source) has its browser cast the tab
//! (`Call::Screencast`) and sends each picture to the viewing device as a
//! binary mesh note. The viewer's daemon keeps only the latest picture and
//! hands it to its console, which asks for the next one once it has drawn
//! this one; each picture the console takes is acknowledged back to the
//! source. The source keeps at most two pictures in flight per view (the
//! latest wins: one not yet sent is replaced by a newer one), and lets its
//! browser paint the next only when a viewer has room, at the view's rate:
//! about 12 pictures a second on Wi-Fi, 5 on mobile data, and about 1 MB
//! a second per view, so the chats syncing over the same link aren't
//! starved.
//!
//! A view starts and stops by request (`POST /browser/views`, `DELETE
//! /browser/views/{id}` on the source), streams only while the viewer's
//! console keeps asking for pictures (it stops when the view is hidden),
//! and a viewer that goes quiet is let go after half a minute. Only the
//! viewer holding control sends input, and taking control pauses an agent
//! using the tab (letting go hands the tab back to it).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use openremote_browser::{Call, Input};
use openremote_cloud::rpc::Request;
use openremote_cloud::{MeshError, PeerContext};
use openremote_core::DeviceId;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::{BrowserService, remote};
use crate::app::App;
use crate::host::PeerOrigin;

/// Pictures in flight to one viewer at most.
const WINDOW: u64 = 2;
/// Bytes a second one view may take.
const BUDGET: usize = 1_000_000;
/// A view whose viewer hasn't been heard from for this long is ended.
const VIEW_IDLE: Duration = Duration::from_secs(30);
/// A picture not acknowledged by now counts as lost, so the view keeps
/// room for the next one.
const LOST_AFTER: Duration = Duration::from_secs(5);
/// A view this device shows whose console stopped asking for pictures for
/// this long is ended.
const POLL_IDLE: Duration = Duration::from_secs(30);
/// While no new picture comes, the viewer tells the source it's still
/// there this often.
const KEEPALIVE: Duration = Duration::from_secs(5);
/// How long the console's request for the next picture waits for one.
const FRAME_WAIT: Duration = Duration::from_secs(8);
/// Input waiting to reach the browser, per tab, at most.
const INPUT_QUEUE: usize = 200;

/// The live views this device takes part in.
#[derive(Default)]
pub struct Live {
    source: Mutex<Source>,
    /// Other devices' tabs shown here, by view id.
    watching: Mutex<HashMap<String, Watching>>,
    /// Input on its way to this device's browser, per tab, in order.
    inputs: Mutex<HashMap<String, Inputs>>,
}

/// This device's tabs shown elsewhere.
#[derive(Default)]
struct Source {
    views: HashMap<String, View>,
    casts: HashMap<String, Cast>,
}

/// One viewer of one of this device's tabs.
struct View {
    tab: String,
    viewer: DeviceId,
    viewer_name: String,
    fps: u32,
    /// Pictures sent to the viewer, and the last one it took.
    sent: u64,
    acked: u64,
    /// The number of the cast's picture last sent here.
    shown: u64,
    sent_at: Option<Instant>,
    /// What went out in the last second, for the budget.
    bytes: VecDeque<(Instant, usize)>,
    heard: Instant,
    /// A wake-up is already waiting to send this view a picture it's owed.
    waking: bool,
}

/// One tab being cast.
struct Cast {
    latest: Option<Arc<Picture>>,
    /// Pictures the browser has sent so far.
    count: u64,
    /// The browser was asked to cast (and with what).
    started: bool,
    quality: u8,
    max_width: u32,
    /// The browser holds its latest picture unacknowledged, and paints no
    /// other until it is.
    held: bool,
    /// The acknowledgement is on its way.
    acking: bool,
    frame_at: Option<Instant>,
    /// The view whose viewer holds control.
    control: Option<String>,
    /// Taking control paused an agent using the tab: letting go hands it
    /// back (a pause the user made on this device stays theirs).
    paused: bool,
}

impl Cast {
    fn new() -> Self {
        Self {
            latest: None,
            count: 0,
            started: false,
            quality: 0,
            max_width: 0,
            held: false,
            acking: false,
            frame_at: None,
            control: None,
            paused: false,
        }
    }
}

struct Picture {
    number: u64,
    jpeg: Vec<u8>,
    width: f64,
    height: f64,
}

/// Another device's tab shown here.
struct Watching {
    device: DeviceId,
    device_name: String,
    tab: String,
    latest: Option<Received>,
    /// The last picture handed to the console.
    delivered: u64,
    ended: Option<String>,
    control: bool,
    controller: Option<String>,
    polled: Instant,
    kept: Instant,
    /// Bumped on every change, for the console's waiting request.
    changes: watch::Sender<u64>,
}

struct Received {
    seq: u64,
    jpeg: Vec<u8>,
    header: Value,
}

#[derive(Default)]
struct Inputs {
    queue: VecDeque<Input>,
    running: bool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn bad(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

fn interval(fps: u32) -> Duration {
    Duration::from_millis(1000 / u64::from(fps.max(1)))
}

/// What a viewer asks for on its network: a phone on mobile data gets
/// fewer, smaller and lighter pictures.
fn preset(network: Option<&str>) -> (u32, u8, u32) {
    match network {
        Some("cellular") => (5, 55, 960),
        _ => (12, 65, 1280),
    }
}

/// A picture as a binary note: its header's length (u32 big-endian), the
/// header as JSON, then the JPEG.
fn encode(header: &Value, jpeg: &[u8]) -> Vec<u8> {
    let header = header.to_string().into_bytes();
    let mut out = Vec::with_capacity(4 + header.len() + jpeg.len());
    out.extend_from_slice(&(header.len() as u32).to_be_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(jpeg);
    out
}

fn decode(payload: &[u8]) -> Option<(Value, &[u8])> {
    let len = u32::from_be_bytes(payload.get(..4)?.try_into().ok()?) as usize;
    let header = payload.get(4..4 + len)?;
    let header = serde_json::from_slice(header).ok()?;
    Some((header, &payload[4 + len..]))
}

// ---- the source: this device's tabs shown elsewhere ----

#[derive(Deserialize)]
pub struct StartBody {
    tab: String,
    #[serde(default)]
    fps: Option<u32>,
    #[serde(default)]
    quality: Option<u8>,
    #[serde(default)]
    max_width: Option<u32>,
}

/// Another device starts showing one of this device's tabs.
pub async fn start_view(
    State(app): State<Arc<App>>,
    peer: Option<Extension<PeerOrigin>>,
    Json(body): Json<StartBody>,
) -> Response {
    let Some(Extension(PeerOrigin(peer))) = peer else {
        return bad(StatusCode::FORBIDDEN, "only another of your devices can ask");
    };
    let browser = &app.browser;
    if !browser.connected() {
        return super::peer::no_browser();
    }
    if !browser.shared_with_peers(&body.tab) {
        return bad(StatusCode::NOT_FOUND, "there's no such tab here");
    }
    let fps = body.fps.unwrap_or(12).clamp(1, 15);
    let quality = body.quality.unwrap_or(65).clamp(40, 70);
    let max_width = body.max_width.unwrap_or(1280).clamp(320, 1280);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let restart = {
        let mut source = lock(&browser.live.source);
        source.views.insert(
            id.clone(),
            View {
                tab: body.tab.clone(),
                viewer: peer.device_id,
                viewer_name: peer.name.clone(),
                fps,
                sent: 0,
                acked: 0,
                shown: 0,
                sent_at: None,
                bytes: VecDeque::new(),
                heard: Instant::now(),
                waking: false,
            },
        );
        // One cast per tab, at the most any of its viewers asks for.
        let cast = source.casts.entry(body.tab.clone()).or_insert_with(Cast::new);
        let (quality, max_width) = (cast.quality.max(quality), cast.max_width.max(max_width));
        let restart = !cast.started || quality != cast.quality || max_width != cast.max_width;
        cast.started = true;
        cast.quality = quality;
        cast.max_width = max_width;
        restart.then_some((quality, max_width))
    };
    if let Some((quality, max_width)) = restart {
        let cast = Call::Screencast {
            tab: body.tab.clone(),
            on: true,
            quality: Some(quality),
            max_width: Some(max_width),
        };
        if let Err(error) = browser.call(cast, Duration::from_secs(10)).await {
            end_view(browser, &id, None);
            return bad(StatusCode::BAD_GATEWAY, &error);
        }
    }
    // A tab already cast hands its latest picture to the newcomer at once.
    pump(browser, &body.tab);
    let controller = controller_name(browser, &body.tab);
    Json(json!({
        "id": id,
        "tab": browser.tab_info(&body.tab),
        "fps": fps,
        "quality": quality,
        "max_width": max_width,
        "controller": controller,
    }))
    .into_response()
}

/// The viewer stops showing the tab.
pub async fn stop_view(
    State(app): State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    peer: Option<Extension<PeerOrigin>>,
) -> Response {
    let Some(Extension(PeerOrigin(peer))) = peer else {
        return bad(StatusCode::FORBIDDEN, "only another of your devices can ask");
    };
    if !viewer_of(&app.browser, &id, peer.device_id) {
        return bad(StatusCode::NOT_FOUND, "no such live view");
    }
    end_view(&app.browser, &id, None);
    Json(json!({"ok": true})).into_response()
}

#[derive(Deserialize)]
pub struct ControlBody {
    take: bool,
}

/// The viewer takes control of the tab (its taps and typing reach the
/// page), or lets go. One viewer holds it at a time, and taking it pauses
/// an agent using the tab.
pub async fn control_view(
    State(app): State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    peer: Option<Extension<PeerOrigin>>,
    Json(body): Json<ControlBody>,
) -> Response {
    let Some(Extension(PeerOrigin(peer))) = peer else {
        return bad(StatusCode::FORBIDDEN, "only another of your devices can ask");
    };
    let browser = &app.browser;
    let (tab, hand_back) = {
        let mut source = lock(&browser.live.source);
        let Some(view) = source.views.get(&id).filter(|v| v.viewer == peer.device_id) else {
            return bad(StatusCode::NOT_FOUND, "no such live view");
        };
        let tab = view.tab.clone();
        let mut hand_back = false;
        if let Some(cast) = source.casts.get_mut(&tab) {
            if body.take {
                cast.control = Some(id.clone());
            } else if cast.control.as_deref() == Some(id.as_str()) {
                cast.control = None;
                hand_back = std::mem::take(&mut cast.paused);
            }
        }
        (tab, hand_back)
    };
    if body.take {
        if browser.viewer_control(&tab, true) {
            if let Some(cast) = lock(&browser.live.source).casts.get_mut(&tab) {
                cast.paused = true;
            }
        }
    } else if hand_back {
        browser.viewer_control(&tab, false);
    }
    tell_control(browser, &tab);
    Json(json!({
        "control": body.take,
        "controller": controller_name(browser, &tab),
    }))
    .into_response()
}

/// Whether `device` is the viewer of view `id`.
fn viewer_of(browser: &BrowserService, id: &str, device: DeviceId) -> bool {
    lock(&browser.live.source)
        .views
        .get(id)
        .is_some_and(|v| v.viewer == device)
}

/// The name of the device holding a tab's control, if any.
fn controller_name(browser: &BrowserService, tab: &str) -> Option<String> {
    let source = lock(&browser.live.source);
    let id = source.casts.get(tab)?.control.as_ref()?;
    source.views.get(id).map(|v| v.viewer_name.clone())
}

/// Tells a tab's viewers who has control now (a still page sends no
/// pictures that would say so).
fn tell_control(browser: &BrowserService, tab: &str) {
    let notes: Vec<(DeviceId, Value)> = {
        let source = lock(&browser.live.source);
        let control = source.casts.get(tab).and_then(|c| c.control.clone());
        let controller = control
            .as_ref()
            .and_then(|id| source.views.get(id))
            .map(|v| v.viewer_name.clone());
        source
            .views
            .iter()
            .filter(|(_, v)| v.tab == tab)
            .map(|(id, v)| {
                (
                    v.viewer,
                    json!({
                        "type": "browser.view.control",
                        "view": id,
                        "control": control.as_deref() == Some(id.as_str()),
                        "controller": controller,
                    }),
                )
            })
            .collect()
    };
    send_notes(browser, notes);
}

/// Sends JSON notes to devices, without waiting.
fn send_notes(browser: &BrowserService, notes: Vec<(DeviceId, Value)>) {
    if notes.is_empty() {
        return;
    }
    let Some(mesh) = browser.app().and_then(|app| app.cloud.mesh()) else {
        return;
    };
    tokio::spawn(async move {
        for (device, note) in notes {
            let _ = mesh.note(device, &note).await;
        }
    });
}

/// Ends a view. `why` tells its viewer (none when the viewer asked).
fn end_view(browser: &BrowserService, id: &str, why: Option<&str>) {
    let (view, last, had_control, hand_back) = {
        let mut source = lock(&browser.live.source);
        let Some(view) = source.views.remove(id) else {
            return;
        };
        let last = !source.views.values().any(|v| v.tab == view.tab);
        let (mut had_control, mut hand_back) = (false, false);
        if let Some(cast) = source.casts.get_mut(&view.tab) {
            if cast.control.as_deref() == Some(id) {
                cast.control = None;
                had_control = true;
                hand_back = std::mem::take(&mut cast.paused);
            }
        }
        if last {
            source.casts.remove(&view.tab);
        }
        (view, last, had_control, hand_back)
    };
    if hand_back {
        browser.viewer_control(&view.tab, false);
    }
    if had_control && !last {
        tell_control(browser, &view.tab);
    }
    if last {
        browser.tell(Call::Screencast {
            tab: view.tab.clone(),
            on: false,
            quality: None,
            max_width: None,
        });
    }
    if let Some(why) = why {
        send_notes(
            browser,
            vec![(
                view.viewer,
                json!({"type": "browser.view.ended", "view": id, "why": why}),
            )],
        );
    }
}

/// A tab closed: its viewers are told.
pub fn tab_closed(browser: &BrowserService, tab: &str) {
    let ids: Vec<String> = lock(&browser.live.source)
        .views
        .iter()
        .filter(|(_, v)| v.tab == tab)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        end_view(browser, &id, Some("the tab was closed"));
    }
    lock(&browser.live.inputs).remove(tab);
}

/// The browser went away or restarted: every view of its tabs ends.
pub fn host_gone(browser: &BrowserService, why: &str) {
    let ids: Vec<String> = lock(&browser.live.source).views.keys().cloned().collect();
    for id in ids {
        end_view(browser, &id, Some(why));
    }
    let mut source = lock(&browser.live.source);
    source.casts.clear();
    drop(source);
    lock(&browser.live.inputs).clear();
}

/// A picture from the browser of a tab being cast.
pub fn frame(browser: &BrowserService, tab: &str, data: &str, width: f64, height: f64) {
    let Ok(jpeg) = BASE64.decode(data) else {
        // A picture that can't be read: let the browser go on to the next.
        browser.tell(Call::FrameAck { tab: tab.into() });
        return;
    };
    {
        let mut source = lock(&browser.live.source);
        let Some(cast) = source.casts.get_mut(tab) else {
            // Nobody watches any more (the cast is being stopped).
            drop(source);
            browser.tell(Call::FrameAck { tab: tab.into() });
            return;
        };
        cast.count += 1;
        cast.latest = Some(Arc::new(Picture {
            number: cast.count,
            jpeg,
            width,
            height,
        }));
        cast.held = true;
        cast.frame_at = Some(Instant::now());
    }
    pump(browser, tab);
    ack_when_ready(browser, tab);
}

/// Sends a tab's latest picture to each of its viewers that has room for
/// it and is owed it, now or, past its rate or budget, as soon as it may.
fn pump(browser: &BrowserService, tab: &str) {
    let Some(app) = browser.app() else {
        return;
    };
    let Some(mesh) = app.cloud.mesh() else {
        return;
    };
    let me = mesh.me();
    let info = browser.tab_info(tab);
    let now = Instant::now();
    let mut sends: Vec<(DeviceId, Vec<u8>, String, u64)> = Vec::new();
    let mut wakes: Vec<(String, Duration)> = Vec::new();
    {
        let mut source = lock(&browser.live.source);
        let Source { views, casts } = &mut *source;
        let Some(cast) = casts.get(tab) else {
            return;
        };
        let Some(picture) = cast.latest.clone() else {
            return;
        };
        let control = cast.control.clone();
        let (control_device, controller) = control
            .as_ref()
            .and_then(|id| views.get(id))
            .map(|v| (Some(v.viewer.to_string()), Some(v.viewer_name.clone())))
            .unwrap_or((None, None));
        for (id, view) in views.iter_mut().filter(|(_, v)| v.tab == tab) {
            if view.shown >= picture.number || view.sent - view.acked >= WINDOW {
                continue;
            }
            let mut wait = view
                .sent_at
                .map(|at| interval(view.fps).saturating_sub(now - at))
                .unwrap_or_default();
            while view
                .bytes
                .front()
                .is_some_and(|(at, _)| now - *at >= Duration::from_secs(1))
            {
                view.bytes.pop_front();
            }
            let used: usize = view.bytes.iter().map(|(_, n)| n).sum();
            if used > 0 && used + picture.jpeg.len() > BUDGET {
                if let Some((oldest, _)) = view.bytes.front() {
                    wait = wait.max((*oldest + Duration::from_secs(1)).saturating_duration_since(now));
                }
            }
            if !wait.is_zero() {
                if !view.waking {
                    view.waking = true;
                    wakes.push((id.clone(), wait));
                }
                continue;
            }
            view.sent += 1;
            view.shown = picture.number;
            view.sent_at = Some(now);
            view.bytes.push_back((now, picture.jpeg.len()));
            let header = json!({
                "t": "browser.frame",
                "from": me,
                "view": id,
                "seq": view.sent,
                "width": picture.width,
                "height": picture.height,
                "url": info.as_ref().map(|t| t.url.clone()),
                "title": info.as_ref().map(|t| t.title.clone()),
                "loading": info.as_ref().is_some_and(|t| t.loading),
                "control": control_device,
                "controller": controller,
            });
            sends.push((
                view.viewer,
                encode(&header, &picture.jpeg),
                id.clone(),
                view.sent,
            ));
        }
    }
    for (viewer, payload, id, seq) in sends {
        let (mesh, app) = (Arc::clone(&mesh), Arc::clone(&app));
        tokio::spawn(async move {
            if mesh.note_bin(viewer, &payload).await.is_err() {
                // A picture that never left counts as taken, so the view
                // keeps room for the next one.
                if let Some(view) = lock(&app.browser.live.source).views.get_mut(&id) {
                    view.acked = view.acked.max(seq);
                }
            }
        });
    }
    for (id, wait) in wakes {
        let (app, tab) = (Arc::clone(&app), tab.to_string());
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            if let Some(view) = lock(&app.browser.live.source).views.get_mut(&id) {
                view.waking = false;
            }
            pump(&app.browser, &tab);
            ack_when_ready(&app.browser, &tab);
        });
    }
}

/// Lets the browser paint a tab's next picture once a viewer has room
/// for it, no sooner than the fastest viewer's rate allows.
fn ack_when_ready(browser: &BrowserService, tab: &str) {
    let wait = {
        let mut source = lock(&browser.live.source);
        let Source { views, casts } = &mut *source;
        let Some(cast) = casts.get_mut(tab) else {
            return;
        };
        if !cast.held || cast.acking {
            return;
        }
        let Some(fastest) = views
            .values()
            .filter(|v| v.tab == tab && v.sent - v.acked < WINDOW)
            .map(|v| interval(v.fps))
            .min()
        else {
            return;
        };
        cast.acking = true;
        cast.frame_at
            .map(|at| fastest.saturating_sub(at.elapsed()))
            .unwrap_or_default()
    };
    let Some(app) = browser.app() else {
        return;
    };
    let tab = tab.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(wait).await;
        {
            let mut source = lock(&app.browser.live.source);
            let Some(cast) = source.casts.get_mut(&tab) else {
                return;
            };
            cast.acking = false;
            cast.held = false;
        }
        app.browser.tell(Call::FrameAck { tab });
    });
}

/// A viewer took a picture (or is still there): it has room again.
fn acked(browser: &BrowserService, from: DeviceId, id: &str, seq: u64) {
    let tab = {
        let mut source = lock(&browser.live.source);
        let Some(view) = source.views.get_mut(id).filter(|v| v.viewer == from) else {
            return;
        };
        view.acked = view.acked.max(seq.min(view.sent));
        view.heard = Instant::now();
        view.tab.clone()
    };
    pump(browser, &tab);
    ack_when_ready(browser, &tab);
}

/// Input from a viewer: only the one holding control reaches the page,
/// in the order it was given.
fn input(app: &Arc<App>, from: DeviceId, id: &str, input: Input) {
    let tab = {
        let mut source = lock(&app.browser.live.source);
        let Source { views, casts } = &mut *source;
        let Some(view) = views.get_mut(id).filter(|v| v.viewer == from) else {
            return;
        };
        view.heard = Instant::now();
        let tab = view.tab.clone();
        if casts.get(&tab).and_then(|c| c.control.as_deref()) != Some(id) {
            return;
        }
        tab
    };
    let start = {
        let mut inputs = lock(&app.browser.live.inputs);
        let waiting = inputs.entry(tab.clone()).or_default();
        // A newer pointer position replaces one still waiting, and wheel
        // turns add up, so a slow page never falls behind the finger.
        match (waiting.queue.back_mut(), &input) {
            (Some(Input::Move { x, y }), Input::Move { x: nx, y: ny }) => {
                (*x, *y) = (*nx, *ny);
            }
            (
                Some(Input::Wheel { x, y, dx, dy }),
                Input::Wheel {
                    x: nx,
                    y: ny,
                    dx: ndx,
                    dy: ndy,
                },
            ) => {
                (*x, *y) = (*nx, *ny);
                *dx += ndx;
                *dy += ndy;
            }
            _ => waiting.queue.push_back(input),
        }
        while waiting.queue.len() > INPUT_QUEUE {
            waiting.queue.pop_front();
        }
        !std::mem::replace(&mut waiting.running, true)
    };
    if start {
        let app = Arc::clone(app);
        tokio::spawn(async move { feed(app, tab).await });
    }
}

/// Hands a tab's waiting input to the browser one at a time, each after
/// the one before has landed.
async fn feed(app: Arc<App>, tab: String) {
    loop {
        let next = {
            let mut inputs = lock(&app.browser.live.inputs);
            let Some(waiting) = inputs.get_mut(&tab) else {
                return;
            };
            match waiting.queue.pop_front() {
                Some(next) => next,
                None => {
                    inputs.remove(&tab);
                    return;
                }
            }
        };
        let call = Call::Input {
            tab: tab.clone(),
            input: next,
        };
        let _ = app.browser.call(call, Duration::from_secs(5)).await;
    }
}

// ---- the viewer: other devices' tabs shown here ----

#[derive(Deserialize)]
pub struct WatchBody {
    /// The device with the tab: its id, or its name.
    device: String,
    tab: String,
    /// `cellular` on mobile data; anything else counts as Wi-Fi.
    #[serde(default)]
    network: Option<String>,
    /// The viewer's width in pixels: wider pictures would be wasted.
    #[serde(default)]
    width: Option<u32>,
}

/// The console starts showing another device's tab.
async fn watch_tab(State(app): State<Arc<App>>, Json(body): Json<WatchBody>) -> Response {
    let Some(mesh) = app.cloud.mesh() else {
        return bad(
            StatusCode::SERVICE_UNAVAILABLE,
            "sign in to OpenRemote Cloud to see your other devices' tabs",
        );
    };
    let devices = remote::devices(&app);
    let Some(device) = remote::find(&devices, &body.device).cloned() else {
        return bad(StatusCode::NOT_FOUND, "that device isn't one of yours");
    };
    if device.this {
        return bad(StatusCode::BAD_REQUEST, "that tab is on this device");
    }
    let (fps, quality, max_width) = preset(body.network.as_deref());
    let max_width = body.width.map_or(max_width, |w| w.clamp(320, max_width));
    let request = Request {
        method: "POST".into(),
        path: "/browser/views".into(),
        content_type: Some("application/json".into()),
        body: json!({"tab": body.tab, "fps": fps, "quality": quality, "max_width": max_width})
            .to_string()
            .into_bytes(),
    };
    let response = match mesh
        .request(device.id, request, Duration::from_secs(15))
        .await
    {
        Ok(response) => response,
        Err(e @ MeshError::Offline(_)) => {
            return bad(StatusCode::SERVICE_UNAVAILABLE, &e.to_string());
        }
        Err(e) => return bad(StatusCode::BAD_GATEWAY, &e.to_string()),
    };
    let answer: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    match response.status {
        200 => {}
        409 => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": format!("{} has no browser open right now", device.name),
                    "code": "no_browser",
                })),
            )
                .into_response();
        }
        404 => return bad(StatusCode::NOT_FOUND, "that tab was closed"),
        403 => {
            return bad(
                StatusCode::CONFLICT,
                &format!("{} needs a newer OpenRemote to share its tabs", device.name),
            );
        }
        _ => {
            return bad(
                StatusCode::BAD_GATEWAY,
                answer["error"].as_str().unwrap_or("the other device answered oddly"),
            );
        }
    }
    let Some(id) = answer["id"].as_str().map(str::to_string) else {
        return bad(StatusCode::BAD_GATEWAY, "the other device answered oddly");
    };
    let controller = answer["controller"].as_str().map(str::to_string);
    lock(&app.browser.live.watching).insert(
        id.clone(),
        Watching {
            device: device.id,
            device_name: device.name.clone(),
            tab: body.tab.clone(),
            latest: None,
            delivered: 0,
            ended: None,
            control: false,
            controller: controller.clone(),
            polled: Instant::now(),
            kept: Instant::now(),
            changes: watch::channel(0).0,
        },
    );
    Json(json!({
        "id": id,
        "device": {"id": device.id, "name": device.name},
        "tab": answer["tab"],
        "fps": fps,
        "controller": controller,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct FrameQuery {
    #[serde(default)]
    after: u64,
}

/// The console's next picture of a tab it shows: the latest one newer than
/// `after`, waiting a few seconds for one. 204 when none came (ask again),
/// 410 once the view has ended (the answer says why).
async fn next_frame(
    State(app): State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<FrameQuery>,
) -> Response {
    let deadline = tokio::time::Instant::now() + FRAME_WAIT;
    let mut changes = {
        let mut watching = lock(&app.browser.live.watching);
        let Some(view) = watching.get_mut(&id) else {
            return bad(StatusCode::GONE, "this live view has ended");
        };
        view.polled = Instant::now();
        view.changes.subscribe()
    };
    loop {
        let found = {
            let mut watching = lock(&app.browser.live.watching);
            let Some(view) = watching.get_mut(&id) else {
                return bad(StatusCode::GONE, "this live view has ended");
            };
            view.polled = Instant::now();
            if let Some(why) = view.ended.clone() {
                watching.remove(&id);
                return bad(StatusCode::GONE, &why);
            }
            match &view.latest {
                Some(latest) if latest.seq > query.after => {
                    view.delivered = latest.seq;
                    view.kept = Instant::now();
                    Some((
                        view.device,
                        latest.seq,
                        BASE64.encode(&latest.jpeg),
                        latest.header.clone(),
                        view.control,
                        view.controller.clone(),
                    ))
                }
                _ => None,
            }
        };
        if let Some((device, seq, data, header, control, controller)) = found {
            tell_source(&app, device, &id, seq).await;
            return Json(json!({
                "seq": seq,
                "data": data,
                "width": header["width"],
                "height": header["height"],
                "url": header["url"],
                "title": header["title"],
                "loading": header["loading"],
                "control": control,
                "controller": controller,
            }))
            .into_response();
        }
        if tokio::time::timeout_at(deadline, changes.changed())
            .await
            .is_err()
        {
            break;
        }
    }
    // Nothing new: tell the source this viewer is still here.
    let keep = {
        let mut watching = lock(&app.browser.live.watching);
        watching.get_mut(&id).and_then(|view| {
            (view.kept.elapsed() >= KEEPALIVE).then(|| {
                view.kept = Instant::now();
                (view.device, view.delivered)
            })
        })
    };
    if let Some((device, seq)) = keep {
        tell_source(&app, device, &id, seq).await;
    }
    StatusCode::NO_CONTENT.into_response()
}

/// Acknowledges the pictures up to `seq` to the source (and says this
/// viewer is still there).
async fn tell_source(app: &App, device: DeviceId, id: &str, seq: u64) {
    if let Some(mesh) = app.cloud.mesh() {
        let note = json!({"type": "browser.view.ack", "view": id, "seq": seq});
        let _ = mesh.note(device, &note).await;
    }
}

/// The console's tap, swipe or typing on a tab it shows, once it holds
/// control. Sent in order, without waiting for the page.
async fn send_input(
    State(app): State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<Input>,
) -> Response {
    let (device, control) = {
        let watching = lock(&app.browser.live.watching);
        let Some(view) = watching.get(&id) else {
            return bad(StatusCode::GONE, "this live view has ended");
        };
        (view.device, view.control)
    };
    if !control {
        return bad(
            StatusCode::CONFLICT,
            "Take control first: only the device holding control can use the page",
        );
    }
    let Some(mesh) = app.cloud.mesh() else {
        return bad(
            StatusCode::SERVICE_UNAVAILABLE,
            "not connected to OpenRemote Cloud",
        );
    };
    let note = json!({"type": "browser.view.input", "view": id, "input": input});
    match mesh.note(device, &note).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => bad(StatusCode::BAD_GATEWAY, &e.to_string()),
    }
}

/// The console takes control of a tab it shows, or lets go.
async fn take_control(
    State(app): State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ControlBody>,
) -> Response {
    let Some(device) = lock(&app.browser.live.watching).get(&id).map(|v| v.device) else {
        return bad(StatusCode::GONE, "this live view has ended");
    };
    let Some(mesh) = app.cloud.mesh() else {
        return bad(
            StatusCode::SERVICE_UNAVAILABLE,
            "not connected to OpenRemote Cloud",
        );
    };
    let request = Request {
        method: "POST".into(),
        path: format!("/browser/views/{id}/control"),
        content_type: Some("application/json".into()),
        body: json!({"take": body.take}).to_string().into_bytes(),
    };
    match mesh.request(device, request, Duration::from_secs(10)).await {
        Ok(response) if response.status == 200 => {
            let answer: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
            let control = answer["control"].as_bool().unwrap_or(false);
            let controller = answer["controller"].as_str().map(str::to_string);
            if let Some(view) = lock(&app.browser.live.watching).get_mut(&id) {
                view.control = control;
                view.controller = controller.clone();
                view.changes.send_modify(|n| *n += 1);
            }
            Json(json!({"control": control, "controller": controller})).into_response()
        }
        Ok(response) => {
            let answer: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
            bad(
                StatusCode::from_u16(response.status).unwrap_or(StatusCode::BAD_GATEWAY),
                answer["error"].as_str().unwrap_or("the other device said no"),
            )
        }
        Err(e) => bad(StatusCode::BAD_GATEWAY, &e.to_string()),
    }
}

/// The console stops showing a tab (it was closed, or hidden).
async fn unwatch(State(app): State<Arc<App>>, AxumPath(id): AxumPath<String>) -> Response {
    let removed = lock(&app.browser.live.watching).remove(&id);
    if let Some(view) = removed {
        stop_remote(&app, view.device, id);
    }
    Json(json!({"ok": true})).into_response()
}

/// Asks the source to stop a view, without waiting.
fn stop_remote(app: &App, device: DeviceId, id: String) {
    let Some(mesh) = app.cloud.mesh() else {
        return;
    };
    tokio::spawn(async move {
        let request = Request {
            method: "DELETE".into(),
            path: format!("/browser/views/{id}"),
            content_type: None,
            body: Vec::new(),
        };
        let _ = mesh.request(device, request, Duration::from_secs(5)).await;
    });
}

/// The live views this device takes part in, for its console: its tabs
/// shown elsewhere ("Viewed from <device>"), and the ones it shows.
async fn list_views(State(app): State<Arc<App>>) -> Response {
    let viewed: Vec<Value> = {
        let source = lock(&app.browser.live.source);
        source
            .views
            .iter()
            .map(|(id, v)| {
                let control = source
                    .casts
                    .get(&v.tab)
                    .and_then(|c| c.control.as_deref())
                    == Some(id.as_str());
                json!({
                    "id": id,
                    "tab": v.tab,
                    "viewer": v.viewer_name,
                    "viewer_id": v.viewer,
                    "control": control,
                })
            })
            .collect()
    };
    let watching: Vec<Value> = lock(&app.browser.live.watching)
        .iter()
        .map(|(id, w)| {
            json!({
                "id": id,
                "device": w.device_name,
                "device_id": w.device,
                "tab": w.tab,
                "control": w.control,
            })
        })
        .collect();
    Json(json!({"viewed": viewed, "watching": watching})).into_response()
}

/// This device's user stops another device from showing one of its tabs.
async fn end_here(State(app): State<Arc<App>>, AxumPath(id): AxumPath<String>) -> Response {
    let me = remote::devices(&app)
        .into_iter()
        .find(|d| d.this)
        .map_or("the other device".to_string(), |d| d.name);
    end_view(
        &app.browser,
        &id,
        Some(&format!("{me} stopped showing this tab")),
    );
    Json(json!({"ok": true})).into_response()
}

/// The console's live view routes.
pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/browser/live", post(watch_tab))
        .route("/browser/live/{id}", axum::routing::delete(unwatch))
        .route("/browser/live/{id}/frame", get(next_frame))
        .route("/browser/live/{id}/input", post(send_input))
        .route("/browser/live/{id}/control", post(take_control))
        .route("/browser/views", get(list_views))
        .route("/browser/views/{id}/end", post(end_here))
}

// ---- the mesh's side ----

/// A live view's one-way messages from a peer: a viewer's acknowledgement
/// or input (here as the source), a source's word that a view ended or
/// its control moved (here as the viewer).
pub fn on_note(app: &Arc<App>, peer: PeerContext, note: Value) {
    let Some(id) = note["view"].as_str() else {
        return;
    };
    match note["type"].as_str() {
        Some("browser.view.ack") => {
            let seq = note["seq"].as_u64().unwrap_or(0);
            acked(&app.browser, peer.device_id, id, seq);
        }
        Some("browser.view.input") => {
            if let Ok(given) = serde_json::from_value::<Input>(note["input"].clone()) {
                input(app, peer.device_id, id, given);
            }
        }
        Some("browser.view.ended") => {
            if let Some(view) = lock(&app.browser.live.watching)
                .get_mut(id)
                .filter(|v| v.device == peer.device_id)
            {
                view.ended = Some(
                    note["why"]
                        .as_str()
                        .unwrap_or("the live view ended")
                        .to_string(),
                );
                view.changes.send_modify(|n| *n += 1);
            }
        }
        Some("browser.view.control") => {
            if let Some(view) = lock(&app.browser.live.watching)
                .get_mut(id)
                .filter(|v| v.device == peer.device_id)
            {
                view.control = note["control"].as_bool().unwrap_or(false);
                view.controller = note["controller"].as_str().map(str::to_string);
                view.changes.send_modify(|n| *n += 1);
            }
        }
        _ => {}
    }
}

/// A picture from a source, for a tab this device shows: only the latest
/// one is kept.
pub fn on_bin(app: &Arc<App>, peer: PeerContext, payload: Vec<u8>) {
    let Some((header, jpeg)) = decode(&payload) else {
        return;
    };
    if header["t"] != "browser.frame" {
        return;
    }
    let (Some(id), Some(seq)) = (header["view"].as_str(), header["seq"].as_u64()) else {
        return;
    };
    let me = app.cloud.device_id().map(|d| d.to_string());
    let mut watching = lock(&app.browser.live.watching);
    let Some(view) = watching
        .get_mut(id)
        .filter(|v| v.device == peer.device_id)
    else {
        return;
    };
    if view.latest.as_ref().is_some_and(|l| l.seq >= seq) {
        return;
    }
    view.control = me.is_some() && header["control"].as_str() == me.as_deref();
    view.controller = header["controller"].as_str().map(str::to_string);
    view.latest = Some(Received {
        seq,
        jpeg: jpeg.to_vec(),
        header,
    });
    view.changes.send_modify(|n| *n += 1);
}

/// Every few seconds: views whose other side went quiet end, and pictures
/// lost on the way stop holding a viewer's room.
pub fn sweep(app: &Arc<App>) {
    let browser = &app.browser;
    let (quiet, stalled): (Vec<String>, Vec<String>) = {
        let mut source = lock(&browser.live.source);
        let quiet = source
            .views
            .iter()
            .filter(|(_, v)| v.heard.elapsed() > VIEW_IDLE)
            .map(|(id, _)| id.clone())
            .collect();
        let mut stalled = Vec::new();
        for view in source.views.values_mut() {
            if view.sent > view.acked && view.sent_at.is_some_and(|at| at.elapsed() > LOST_AFTER)
            {
                view.acked = view.sent;
                stalled.push(view.tab.clone());
            }
        }
        (quiet, stalled)
    };
    for id in quiet {
        end_view(browser, &id, Some("the view went quiet"));
    }
    for tab in stalled {
        pump(browser, &tab);
        ack_when_ready(browser, &tab);
    }
    let gone: Vec<(String, DeviceId)> = {
        let mut watching = lock(&browser.live.watching);
        let gone: Vec<(String, DeviceId)> = watching
            .iter()
            .filter(|(_, w)| w.polled.elapsed() > POLL_IDLE)
            .map(|(id, w)| (id.clone(), w.device))
            .collect();
        for (id, _) in &gone {
            watching.remove(id);
        }
        gone
    };
    for (id, device) in gone {
        stop_remote(app, device, id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_note_carries_its_header_then_the_jpeg() {
        let header = json!({"t": "browser.frame", "view": "v1", "seq": 3});
        let payload = encode(&header, b"\xff\xd8jpeg");
        let (back, jpeg) = decode(&payload).unwrap();
        assert_eq!(back, header);
        assert_eq!(jpeg, b"\xff\xd8jpeg");
        assert!(decode(&[0, 0, 0, 9, b'{']).is_none());
    }
}
