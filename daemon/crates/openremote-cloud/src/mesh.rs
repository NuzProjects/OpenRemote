//! The mesh: this device's links to the account's other devices, over the
//! relay. Peers and their public keys come from the registry; the first key
//! seen for each device is pinned, and a device whose key later changes is
//! never linked again. Links come up on demand and drop whenever a frame may
//! have been lost (the peer went offline, the relay reconnected, a message
//! failed to decrypt); the next request simply links again.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use openremote_core::DeviceId;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::link::{self, HS1, HS2, Link, MSG, NUDGE};
use crate::rpc::{self, Request, Response};
use crate::{Cloud, Phase};

/// Who is asking, as far as the mesh can vouch: a device of this account.
#[derive(Clone, Debug)]
pub struct PeerContext {
    pub device_id: DeviceId,
    pub name: String,
    pub kind: String,
}

/// What the daemon does with traffic from the user's other devices.
pub trait CloudHost: Send + Sync + 'static {
    /// Serve one request from a peer (the daemon gates what peers may do).
    fn dispatch(&self, peer: PeerContext, request: Request) -> BoxFuture<'static, Response>;
    /// A one-way message from a peer.
    fn note(&self, peer: PeerContext, note: Value);
    /// A link to `peer` just came up.
    fn linked(&self, peer: DeviceId);
    /// `peer` is online (it just came online, or was when this device
    /// connected).
    fn online(&self, peer: DeviceId);
    /// This device was removed from the account.
    fn revoked(&self);
}

#[derive(Debug, thiserror::Error)]
pub enum MeshError {
    #[error("that device isn't one of yours")]
    Unknown,
    #[error("{0} is offline")]
    Offline(String),
    #[error("{0} doesn't answer")]
    Unreachable(String),
    #[error("{0}'s key changed - remove it and add it again")]
    KeyChanged(String),
    #[error("{0} took too long to answer")]
    Timeout(String),
    #[error("the link to {0} dropped")]
    Reset(String),
    #[error("the request is too large")]
    TooLarge,
    #[error("not connected to OpenRemote Cloud")]
    NotConnected,
}

#[derive(Clone, Debug, Serialize)]
pub struct Peer {
    pub id: DeviceId,
    pub name: String,
    pub platform: String,
    pub kind: String,
    pub online: bool,
    pub app_version: Option<String>,
    pub last_seen_at: Option<f64>,
    pub created_via: Option<String>,
    pub auto_update: bool,
    pub auto_update_override: Option<bool>,
    /// `key_changed` when the registry's key no longer matches the pin.
    pub problem: Option<&'static str>,
    #[serde(skip)]
    pubkey: Vec<u8>,
}

struct Call {
    head: Option<Response>,
    body: Vec<u8>,
    done: Option<oneshot::Sender<Result<Response, MeshError>>>,
}

/// One inbound stream: the request so far, and when its slot in the
/// per-peer window is reclaimed if the END never comes.
struct Inbound {
    request: Request,
    deadline: Instant,
}

#[derive(Default)]
struct State {
    peers: HashMap<DeviceId, Peer>,
    links: HashMap<DeviceId, Link>,
    waiters: HashMap<DeviceId, Vec<oneshot::Sender<()>>>,
    calls: HashMap<(DeviceId, u32), Call>,
    inbound: HashMap<(DeviceId, u32), Inbound>,
    next_stream: u32,
    auto_update: bool,
    online: std::collections::HashSet<DeviceId>,
}

pub struct Mesh {
    me: DeviceId,
    account: String,
    private: Vec<u8>,
    kind: Mutex<String>,
    out: mpsc::UnboundedSender<(DeviceId, Vec<u8>)>,
    state: Mutex<State>,
    host: Arc<dyn CloudHost>,
    pins_file: PathBuf,
    refresh: Notify,
    /// Check the relay link now: reconnect at once if it's down, and probe
    /// it if it looks up (it may have died while the OS froze the app).
    wake: Notify,
}

const MAX_INBOUND_PER_PEER: usize = 32;
const LINK_ATTEMPT: Duration = Duration::from_secs(4);
/// How long an inbound stream may wait for its END before its slot is
/// reclaimed. It must outlast the peer's own request timeout (a harness
/// install may answer slowly) so a live request never loses its slot; the
/// bound exists for the peer that freezes and never ends anything, which
/// nothing else would ever clean up.
const INBOUND_TTL: Duration = Duration::from_secs(960);
/// Relay sessions in a row that never even established before the phase
/// admits the relay is down: one failed handshake is a deploy-window
/// blip; three in a row, seconds apart under backoff, is an outage the
/// user should see instead of a phase that sits at "connecting" with no
/// error.
const HANDSHAKE_FAILURES_TO_ERROR: u32 = 3;
/// Device-list fetches in a row that fail before they surface. At the
/// refresher's five-minute cadence this is ten minutes of a frozen device
/// list, which is an outage, not a blip.
const REFRESH_FAILURES_TO_ERROR: u32 = 2;
/// The two sentences this module puts next to a phase when a connection is
/// the problem. They are the only notices it may replace with one of its own
/// or clear again; anything else on screen (a takeover, a removal, a prompt
/// to sign in) was written by something that knows more and is left alone.
const UNREACHABLE: &str = "can't reach OpenRemote Cloud";
const DROPPED: &str = "the connection to OpenRemote Cloud dropped";

/// Whether the notice on screen is one of this module's own generic
/// connection sentences, and so may be replaced or cleared by it.
fn generic_notice(error: Option<&str>) -> bool {
    matches!(error, None | Some(UNREACHABLE) | Some(DROPPED))
}

/// The refresher's error bookkeeping: how long the device-list fetches have
/// been failing, and the phase it raised its own notice at. Kept apart from
/// the loop so the transitions can be read and tested without a live
/// registry.
#[derive(Default)]
struct Surfacer {
    failures: u32,
    at: Option<Phase>,
}

impl Surfacer {
    /// One failed fetch: the notice to raise, when this is the moment. A run
    /// of failures raises it once, and only into a slot that says nothing
    /// more specific: the generic sentence must never overwrite the one that
    /// explains why (a takeover, a removal, a prompt to sign in), which is
    /// what a plain re-set of the same string did every five minutes.
    fn failed(
        &mut self,
        phase: Phase,
        error: Option<&str>,
    ) -> Option<(Phase, Option<&'static str>)> {
        self.failures = self.failures.saturating_add(1);
        if self.failures < REFRESH_FAILURES_TO_ERROR || self.at.is_some() || !generic_notice(error)
        {
            return None;
        }
        self.at = Some(phase);
        Some((phase, Some(UNREACHABLE)))
    }

    /// One good fetch: the phase whose notice to clear, when the notice still
    /// on screen is exactly the one this loop raised.
    fn recovered(&mut self, phase: Phase, error: Option<&str>) -> Option<Phase> {
        self.failures = 0;
        let at = self.at.take()?;
        (phase == at && error == Some(UNREACHABLE)).then_some(at)
    }
}

/// A device-list entry's noise key, decoded: `None` unless it is exactly
/// the 32 bytes an X25519 public key is, in clean base64url. Anything
/// else must never be pinned or stored as key material; an entry without
/// a usable key is skipped and fetched again.
fn validated_pubkey(raw: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .ok()?;
    (bytes.len() == 32).then_some(bytes)
}

impl Mesh {
    pub fn me(&self) -> DeviceId {
        self.me
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Fetches the device list again (after this device changed it).
    pub fn refresh_now(&self) {
        self.refresh.notify_one();
    }

    pub fn wake(&self) {
        self.wake.notify_one();
    }

    /// This device's own kind, as the registry last said.
    pub fn kind(&self) -> String {
        self.kind.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn auto_update(&self) -> bool {
        self.state().auto_update
    }

    /// The account's devices, this one included, as last fetched.
    pub fn peers(&self) -> Vec<Peer> {
        let st = self.state();
        let mut peers: Vec<Peer> = st
            .peers
            .values()
            .map(|p| Peer {
                online: p.id == self.me || st.online.contains(&p.id),
                ..p.clone()
            })
            .collect();
        peers.sort_by(|a, b| a.name.cmp(&b.name));
        peers
    }

    pub fn peer(&self, id: DeviceId) -> Option<Peer> {
        self.peers().into_iter().find(|p| p.id == id)
    }

    fn hello(&self) -> Vec<u8> {
        json!({"v": 1, "kind": self.kind(), "version": env!("CARGO_PKG_VERSION")})
            .to_string()
            .into_bytes()
    }

    fn context(&self, st: &State, peer: DeviceId) -> PeerContext {
        let info = st.peers.get(&peer);
        PeerContext {
            device_id: peer,
            name: info.map(|p| p.name.clone()).unwrap_or_default(),
            kind: info.map(|p| p.kind.clone()).unwrap_or_default(),
        }
    }

    fn pins(&self) -> HashMap<String, String> {
        std::fs::read(&self.pins_file)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    /// Takes the registry's device list. New keys are pinned; a changed
    /// key marks the device and its key is not used. An entry whose
    /// `noise_pubkey` is absent or malformed is skipped, never pinned:
    /// pinning it would flag the device `key_changed` forever once the
    /// real key shows up. Returns whether every entry was usable; the
    /// refresher treats a skipped entry like a failed fetch.
    pub fn update_devices(&self, body: &Value) -> bool {
        let mut pins = self.pins();
        let mut pinned_new = false;
        let mut peers = HashMap::new();
        let mut unpinnable: Vec<DeviceId> = Vec::new();
        for d in body["devices"].as_array().into_iter().flatten() {
            let Some(id) = d["id"].as_str().and_then(DeviceId::parse) else {
                continue;
            };
            let Some(key) = d["noise_pubkey"].as_str() else {
                unpinnable.push(id);
                continue;
            };
            let Some(pubkey) = validated_pubkey(key) else {
                unpinnable.push(id);
                continue;
            };
            let problem = match pins.get(&id.to_string()) {
                // A pin that isn't valid key material was never a real
                // key: an older daemon pinned an empty one when the
                // registry served this entry without a key, and it
                // poisoned the device. Re-pin the real key instead of
                // flagging the device forever.
                Some(pin) if validated_pubkey(pin).is_none() => {
                    pins.insert(id.to_string(), key.to_string());
                    pinned_new = true;
                    None
                }
                Some(pin) if *pin != key => Some("key_changed"),
                Some(_) => None,
                None => {
                    pins.insert(id.to_string(), key.to_string());
                    pinned_new = true;
                    None
                }
            };
            if id == self.me {
                *self.kind.lock().unwrap_or_else(|e| e.into_inner()) =
                    d["kind"].as_str().unwrap_or("desktop").to_string();
            }
            peers.insert(
                id,
                Peer {
                    id,
                    name: d["name"].as_str().unwrap_or("device").to_string(),
                    platform: d["platform"].as_str().unwrap_or_default().to_string(),
                    kind: d["kind"].as_str().unwrap_or("desktop").to_string(),
                    online: d["online"].as_bool().unwrap_or(false),
                    app_version: d["app_version"].as_str().map(str::to_string),
                    last_seen_at: d["last_seen_at"].as_f64(),
                    created_via: d["created_via"].as_str().map(str::to_string),
                    auto_update: d["auto_update"].as_bool().unwrap_or(true),
                    auto_update_override: d["auto_update_override"].as_bool(),
                    problem,
                    pubkey,
                },
            );
        }
        if pinned_new {
            if let Ok(json) = serde_json::to_vec_pretty(&pins) {
                let _ = openremote_core::fsx::write_private(&self.pins_file, &json);
            }
        }
        let mut st = self.state();
        // A skipped entry keeps its last good self: one glitchy fetch must
        // not drop a working peer, and its link, from the list.
        for id in &unpinnable {
            if let Some(peer) = st.peers.remove(id) {
                peers.insert(*id, peer);
            }
        }
        // Devices that left the account lose their links.
        let gone: Vec<DeviceId> = st
            .links
            .keys()
            .filter(|id| !peers.contains_key(id))
            .copied()
            .collect();
        for id in gone {
            fail_peer(&mut st, id, "removed");
        }
        st.peers = peers;
        st.auto_update = body["prefs"]["auto_update"].as_bool().unwrap_or(true);
        unpinnable.is_empty()
    }

    fn set_online(&self, ids: &[DeviceId]) {
        self.state().online = ids.iter().copied().collect();
    }

    fn presence(&self, id: DeviceId, online: bool) {
        let mut st = self.state();
        if online {
            st.online.insert(id);
        } else {
            st.online.remove(&id);
            fail_peer(&mut st, id, "offline");
        }
    }

    /// Every link is suspect after the relay reconnects: a frame in flight
    /// may be gone, and Noise transport needs every one, in order.
    fn drop_links(&self) {
        let mut st = self.state();
        let ids: Vec<DeviceId> = st.links.keys().copied().collect();
        for id in ids {
            fail_peer(&mut st, id, "relay reconnected");
        }
    }

    fn send_sealed(&self, st: &mut State, peer: DeviceId, plaintext: &[u8]) -> bool {
        let Some(link) = st.links.get_mut(&peer) else {
            return false;
        };
        match link.seal(plaintext) {
            Ok(sealed) => self.out.send((peer, sealed)).is_ok(),
            Err(_) => false,
        }
    }

    async fn ensure_link(&self, peer: DeviceId) -> Result<(), MeshError> {
        for attempt in 0..3 {
            let rx = {
                let mut st = self.state();
                if st.links.get(&peer).is_some_and(Link::is_up) {
                    return Ok(());
                }
                let info = st.peers.get(&peer).cloned().ok_or(MeshError::Unknown)?;
                if info.problem.is_some() {
                    return Err(MeshError::KeyChanged(info.name));
                }
                if !st.online.contains(&peer) {
                    return Err(MeshError::Offline(info.name));
                }
                let (tx, rx) = oneshot::channel();
                st.waiters.entry(peer).or_default().push(tx);
                if link::initiates(self.me, peer) {
                    let restart = attempt > 0 || !st.links.contains_key(&peer);
                    if restart {
                        let prologue = link::prologue(&self.account, self.me, peer);
                        if let Ok((link, hs1)) =
                            link::initiate(&self.private, &info.pubkey, &prologue, &self.hello())
                        {
                            st.links.insert(peer, link);
                            let _ = self.out.send((peer, hs1));
                        }
                    }
                } else {
                    let _ = self.out.send((peer, vec![NUDGE]));
                }
                rx
            };
            if matches!(tokio::time::timeout(LINK_ATTEMPT, rx).await, Ok(Ok(()))) {
                return Ok(());
            }
        }
        let name = self
            .state()
            .peers
            .get(&peer)
            .map(|p| p.name.clone())
            .unwrap_or_default();
        Err(MeshError::Unreachable(name))
    }

    /// One request to a peer's own API, answered in full.
    pub async fn request(
        &self,
        peer: DeviceId,
        request: Request,
        timeout: Duration,
    ) -> Result<Response, MeshError> {
        if request.body.len() > rpc::MAX_REQUEST {
            return Err(MeshError::TooLarge);
        }
        self.ensure_link(peer).await?;
        let (tx, rx) = oneshot::channel();
        let stream = {
            let mut st = self.state();
            st.next_stream = st.next_stream.wrapping_add(1).max(1);
            let stream = st.next_stream;
            st.calls.insert(
                (peer, stream),
                Call {
                    head: None,
                    body: Vec::new(),
                    done: Some(tx),
                },
            );
            let header = serde_json::to_vec(&json!({"op": "http", "method": request.method, "path": request.path, "content_type": request.content_type}))
                .unwrap_or_default();
            for frame in rpc::frames(rpc::OPEN, stream, &header, &request.body) {
                if !self.send_sealed(&mut st, peer, &frame) {
                    st.calls.remove(&(peer, stream));
                    return Err(MeshError::Reset(String::new()));
                }
            }
            stream
        };
        let name = || self.peer(peer).map(|p| p.name).unwrap_or_default();
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result.map_err(|e| match e {
                MeshError::Reset(_) => MeshError::Reset(name()),
                other => other,
            }),
            Ok(Err(_)) => Err(MeshError::Reset(name())),
            Err(_) => {
                let mut st = self.state();
                st.calls.remove(&(peer, stream));
                let reset = rpc::frame(rpc::RESET, stream, b"timeout");
                self.send_sealed(&mut st, peer, &reset);
                Err(MeshError::Timeout(name()))
            }
        }
    }

    /// A one-way message to a peer; dropped if it can't be delivered.
    pub async fn note(&self, peer: DeviceId, note: &Value) -> Result<(), MeshError> {
        self.ensure_link(peer).await?;
        let frame = rpc::frame(rpc::NOTE, 0, note.to_string().as_bytes());
        if frame.len() > link::MAX_PLAINTEXT {
            return Err(MeshError::TooLarge);
        }
        let mut st = self.state();
        if self.send_sealed(&mut st, peer, &frame) {
            Ok(())
        } else {
            Err(MeshError::Reset(String::new()))
        }
    }

    /// Ids of the devices online right now, this one excluded.
    pub fn online(&self) -> Vec<DeviceId> {
        self.state()
            .online
            .iter()
            .copied()
            .filter(|id| *id != self.me)
            .collect()
    }

    fn on_frame(self: &Arc<Self>, from: DeviceId, payload: &[u8]) {
        let Some((&kind, body)) = payload.split_first() else {
            return;
        };
        match kind {
            HS1 => {
                let mut st = self.state();
                let Some(info) = st.peers.get(&from).filter(|p| p.problem.is_none()).cloned()
                else {
                    // A device the list doesn't know yet: fetch it again.
                    self.refresh.notify_one();
                    return;
                };
                let prologue = link::prologue(&self.account, self.me, from);
                let Ok((up, _hello, hs2)) =
                    link::respond(&self.private, &info.pubkey, &prologue, body, &self.hello())
                else {
                    return;
                };
                // A new handshake means the peer started over: the old
                // link's streams are gone.
                fail_peer(&mut st, from, "renewed");
                st.links.insert(from, up);
                let _ = self.out.send((from, hs2));
                for waiter in st.waiters.remove(&from).unwrap_or_default() {
                    let _ = waiter.send(());
                }
                drop(st);
                self.host.linked(from);
            }
            HS2 => {
                let mut st = self.state();
                // Only an initiated link takes an answer; a stray HS2 must
                // not tear down a link that is up.
                if !matches!(st.links.get(&from), Some(Link::Initiating(_))) {
                    return;
                }
                let Some(pending) = st.links.remove(&from) else {
                    return;
                };
                match link::complete(pending, body) {
                    Ok((up, _hello)) => {
                        st.links.insert(from, up);
                        for waiter in st.waiters.remove(&from).unwrap_or_default() {
                            let _ = waiter.send(());
                        }
                        drop(st);
                        self.host.linked(from);
                    }
                    Err(_) => fail_peer(&mut st, from, "handshake failed"),
                }
            }
            MSG => {
                let mut st = self.state();
                let opened = st.links.get_mut(&from).map(|l| l.open(body));
                match opened {
                    Some(Ok(plaintext)) => {
                        drop(st);
                        self.on_rpc(from, &plaintext);
                    }
                    Some(Err(_)) => fail_peer(&mut st, from, "decrypt failed"),
                    None => {}
                }
            }
            NUDGE if link::initiates(self.me, from) => {
                let mesh = Arc::clone(self);
                tokio::spawn(async move {
                    let _ = mesh.ensure_link(from).await;
                });
            }
            _ => {}
        }
    }

    fn on_rpc(self: &Arc<Self>, from: DeviceId, plaintext: &[u8]) {
        let Some((kind, stream, body)) = rpc::parse(plaintext) else {
            return;
        };
        let mut st = self.state();
        match kind {
            rpc::OPEN => {
                let now = Instant::now();
                // Reclaim expired slots first: a peer that OPENed streams
                // and then stalled without ending them must not wedge its
                // whole window to "busy".
                reclaim_expired(&mut st.inbound, now);
                let open = st.inbound.keys().filter(|(p, _)| *p == from).count();
                let request = serde_json::from_slice::<Value>(body).ok().map(|h| Request {
                    method: h["method"].as_str().unwrap_or("GET").to_string(),
                    path: h["path"].as_str().unwrap_or("/").to_string(),
                    content_type: h["content_type"].as_str().map(str::to_string),
                    body: Vec::new(),
                });
                match request {
                    Some(r) if open < MAX_INBOUND_PER_PEER => {
                        st.inbound.insert(
                            (from, stream),
                            Inbound {
                                request: r,
                                deadline: now + INBOUND_TTL,
                            },
                        );
                    }
                    _ => {
                        let reset = rpc::frame(rpc::RESET, stream, b"busy");
                        self.send_sealed(&mut st, from, &reset);
                    }
                }
            }
            rpc::DATA => {
                let too_big = match st.inbound.get_mut(&(from, stream)) {
                    Some(r) => {
                        r.request.body.extend_from_slice(body);
                        r.request.body.len() > rpc::MAX_REQUEST
                    }
                    None => false,
                };
                if too_big {
                    st.inbound.remove(&(from, stream));
                    let reset = rpc::frame(rpc::RESET, stream, b"too large");
                    self.send_sealed(&mut st, from, &reset);
                }
            }
            rpc::END => {
                let Some(inbound) = st.inbound.remove(&(from, stream)) else {
                    return;
                };
                let request = inbound.request;
                let context = self.context(&st, from);
                drop(st);
                let mesh = Arc::clone(self);
                tokio::spawn(async move {
                    let response = mesh.host.dispatch(context, request).await;
                    let header = serde_json::to_vec(
                        &json!({"status": response.status, "content_type": response.content_type}),
                    )
                    .unwrap_or_default();
                    let mut st = mesh.state();
                    for frame in rpc::frames(rpc::HEAD, stream, &header, &response.body) {
                        if !mesh.send_sealed(&mut st, from, &frame) {
                            break;
                        }
                    }
                });
            }
            rpc::HEAD => {
                if let Some(call) = st.calls.get_mut(&(from, stream)) {
                    let h: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
                    call.head = Some(Response {
                        status: h["status"].as_u64().unwrap_or(502) as u16,
                        content_type: h["content_type"].as_str().map(str::to_string),
                        body: Vec::new(),
                    });
                }
            }
            rpc::RDATA => {
                let too_big = match st.calls.get_mut(&(from, stream)) {
                    Some(call) => {
                        call.body.extend_from_slice(body);
                        call.body.len() > rpc::MAX_RESPONSE
                    }
                    None => false,
                };
                if too_big {
                    if let Some(mut call) = st.calls.remove(&(from, stream)) {
                        if let Some(done) = call.done.take() {
                            let _ = done.send(Err(MeshError::TooLarge));
                        }
                    }
                }
            }
            rpc::REND => {
                if let Some(mut call) = st.calls.remove(&(from, stream)) {
                    let mut response = call.head.take().unwrap_or(Response {
                        status: 502,
                        content_type: None,
                        body: Vec::new(),
                    });
                    response.body = std::mem::take(&mut call.body);
                    if let Some(done) = call.done.take() {
                        let _ = done.send(Ok(response));
                    }
                }
            }
            rpc::RESET => {
                st.inbound.remove(&(from, stream));
                if let Some(mut call) = st.calls.remove(&(from, stream)) {
                    if let Some(done) = call.done.take() {
                        let _ = done.send(Err(MeshError::Reset(String::new())));
                    }
                }
            }
            rpc::NOTE => {
                let context = self.context(&st, from);
                drop(st);
                if let Ok(note) = serde_json::from_slice(body) {
                    self.host.note(context, note);
                }
            }
            _ => {}
        }
    }
}

/// Reclaims inbound streams whose END never came: a peer frozen mid
/// request must not hold its slots in the per-peer window forever. The
/// OPEN handler checks before admitting new streams, and the refresher
/// sweeps with this periodically so a silent peer's slots come back even
/// when it sends nothing more. Returns how many slots were reclaimed.
fn reclaim_expired(inbound: &mut HashMap<(DeviceId, u32), Inbound>, now: Instant) -> usize {
    let before = inbound.len();
    inbound.retain(|_, entry| now < entry.deadline);
    before - inbound.len()
}

/// Drops a peer's link and fails everything in flight with it.
fn fail_peer(st: &mut State, peer: DeviceId, _why: &str) {
    st.links.remove(&peer);
    let keys: Vec<(DeviceId, u32)> = st
        .calls
        .keys()
        .filter(|(p, _)| *p == peer)
        .copied()
        .collect();
    for key in keys {
        if let Some(mut call) = st.calls.remove(&key) {
            if let Some(done) = call.done.take() {
                let _ = done.send(Err(MeshError::Reset(String::new())));
            }
        }
    }
    st.inbound.retain(|(p, _), _| *p != peer);
}

/// How a relay session ended.
enum Ended {
    /// Reconnect after a pause.
    Retry,
    /// Stop: the credential is no good, or this device was removed.
    Stop,
}

/// Starts the mesh for a joined device: the relay connection (kept up with
/// backoff) and the device-list refresher. The handles come back named so
/// `Cloud` can tell the run's liveness (the relay loop) from its housekeeping
/// (the refresher, which never ends on its own).
pub fn start(
    cloud: &Arc<Cloud>,
    host: Arc<dyn CloudHost>,
) -> Option<(
    Arc<Mesh>,
    tokio::task::JoinHandle<()>,
    tokio::task::JoinHandle<()>,
)> {
    let identity = cloud.identity()?;
    let account = cloud.view()["account"]["id"].as_str()?.to_string();
    let kind = cloud.view()["device"]["kind"]
        .as_str()
        .unwrap_or("desktop")
        .to_string();
    let (out, out_rx) = mpsc::unbounded_channel();
    let mesh = Arc::new(Mesh {
        me: identity.device_id,
        account,
        private: identity.private_key(),
        kind: Mutex::new(kind),
        out,
        state: Mutex::new(State {
            auto_update: true,
            ..State::default()
        }),
        host,
        pins_file: cloud.data_dir().join("cloud").join("peers.json"),
        refresh: Notify::new(),
        wake: Notify::new(),
    });
    let relay = tokio::spawn(run_relay(Arc::clone(cloud), Arc::clone(&mesh), out_rx));
    let refresher = tokio::spawn(refresh_devices(Arc::clone(cloud), Arc::clone(&mesh)));
    Some((mesh, relay, refresher))
}

/// Keeps the device list current: at start, when the relay says it
/// changed, when an unknown device knocks, and every few minutes. A
/// fetch that keeps failing is surfaced instead of swallowed: after
/// REFRESH_FAILURES_TO_ERROR consecutive failures (a registry that keeps
/// refusing the credential, or entries too broken to pin) the console
/// shows an error next to the phase instead of a silently frozen device
/// list, and the next good fetch clears it. The notice is raised once per run
/// of failures and never over one that says something more specific. The loop
/// also rides the inbound sweep: a stream whose END never arrives gives its
/// slot back here.
async fn refresh_devices(cloud: Arc<Cloud>, mesh: Arc<Mesh>) {
    let mut surfacer = Surfacer::default();
    loop {
        if let Some(credential) = cloud.device_credential() {
            let ok = match cloud.registry().devices(&credential).await {
                Ok(body) => mesh.update_devices(&body),
                Err(crate::registry::RegistryError::Revoked) => {
                    cloud.removed(&*mesh.host);
                    return;
                }
                Err(_) => false,
            };
            let (phase, error) = cloud.phase_and_error();
            let write = if ok {
                surfacer
                    .recovered(phase, error.as_deref())
                    .map(|at| (at, None))
            } else {
                surfacer
                    .failed(phase, error.as_deref())
                    .map(|(at, notice)| (at, notice.map(str::to_string)))
            };
            if let Some((at, notice)) = write {
                cloud.set_phase(at, notice);
            }
        }
        {
            let mut st = mesh.state();
            reclaim_expired(&mut st.inbound, Instant::now());
        }
        tokio::select! {
            _ = mesh.refresh.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(300)) => {}
        }
    }
}

/// The relay loop's wrapper: whatever ended the loop (a credential the relay
/// refuses, this device removed from the account, it connecting from
/// elsewhere, a relay url that can't be used, the credential gone outright),
/// the run it belonged to is released here. Without this the loop's dead
/// handles stayed in `Cloud`'s Running slot and every later start was
/// turned away, so one Relink or removal ended Cloud until a restart.
async fn run_relay(
    cloud: Arc<Cloud>,
    mesh: Arc<Mesh>,
    out_rx: mpsc::UnboundedReceiver<(DeviceId, Vec<u8>)>,
) {
    relay_loop(&cloud, &mesh, out_rx).await;
    cloud.reap(&mesh);
}

async fn relay_loop(
    cloud: &Arc<Cloud>,
    mesh: &Arc<Mesh>,
    mut out_rx: mpsc::UnboundedReceiver<(DeviceId, Vec<u8>)>,
) {
    let mut backoff = Duration::from_secs(1);
    let mut handshake_failures = 0u32;
    loop {
        let Some(credential) = cloud.device_credential() else {
            return;
        };
        let (established, ended) = relay_session(cloud, mesh, &credential, &mut out_rx).await;
        match ended {
            Ended::Stop => return,
            Ended::Retry => {}
        }
        mesh.drop_links();
        if cloud.phase() == Phase::Online {
            // However the session ended, the user must not be left looking
            // at a stale "online".
            cloud.set_phase(
                Phase::Offline,
                Some("the connection to OpenRemote Cloud dropped".into()),
            );
            // The link was up: this is a fresh drop, not a run of failures.
            backoff = Duration::from_secs(1);
        }
        if established {
            handshake_failures = 0;
        } else {
            handshake_failures = handshake_failures.saturating_add(1);
            if handshake_failures >= HANDSHAKE_FAILURES_TO_ERROR {
                // The endpoint answers something, but the session never
                // comes up (a proxy in front of the relay 503ing through a
                // maintenance window). A run of those must reach the user
                // instead of leaving the phase at whatever it was with no
                // error.
                cloud.set_phase(Phase::Offline, Some("can't reach OpenRemote Cloud".into()));
            }
        }
        // Frames queued during the dead session rode links that were just
        // dropped and can't be delivered in order; anything queued during
        // the pause below belongs to a fresh link and must ride the next
        // session. Draining after the pause ate exactly that: the first
        // handshake of every reconnect.
        while out_rx.try_recv().is_ok() {}
        // Jitter, so a relay restart isn't met by every device at once.
        let jitter = Duration::from_millis(u64::from(uuid::Uuid::new_v4().as_bytes()[0]) * 4);
        tokio::select! {
            _ = tokio::time::sleep(backoff + jitter) => {
                backoff = (backoff * 2).min(Duration::from_secs(60));
            }
            _ = mesh.wake.notified() => backoff = Duration::from_secs(1),
        }
    }
}

/// One relay session: the WebSocket handshake and the connected loop.
/// Returns whether the session was ever established (the handshake
/// completed, even if the socket then died at once), so the loop can tell
/// a drop apart from a handshake that keeps failing, and how it ended.
async fn relay_session(
    cloud: &Arc<Cloud>,
    mesh: &Arc<Mesh>,
    credential: &str,
    out_rx: &mut mpsc::UnboundedReceiver<(DeviceId, Vec<u8>)>,
) -> (bool, Ended) {
    let url = cloud.config().relay_url();
    let Ok(uri) = url.parse::<http::Uri>() else {
        return (false, Ended::Stop);
    };
    let Ok(mut request) = url.as_str().into_client_request() else {
        return (false, Ended::Stop);
    };
    let auth = format!("Bearer {credential}");
    if let Ok(value) = auth.parse() {
        request.headers_mut().insert("authorization", value);
    }
    if let Ok(value) = env!("CARGO_PKG_VERSION").parse() {
        request.headers_mut().insert("x-openremote-version", value);
    }
    let Ok(stream) = cloud.http().connect(&uri).await else {
        cloud.set_phase(Phase::Offline, Some("can't reach OpenRemote Cloud".into()));
        return (false, Ended::Retry);
    };
    let ws = match tokio_tungstenite::client_async(request, stream).await {
        Ok((ws, _)) => ws,
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            return match response.status().as_u16() {
                401 => {
                    cloud.set_phase(
                        Phase::Relink,
                        Some("sign in to OpenRemote Cloud again".into()),
                    );
                    (false, Ended::Stop)
                }
                410 => {
                    cloud.removed(&*mesh.host);
                    (false, Ended::Stop)
                }
                _ => (false, Ended::Retry),
            };
        }
        Err(_) => return (false, Ended::Retry),
    };
    let (mut sink, mut stream) = ws.split();
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    ping.tick().await;
    // Set by a wake: the relay must answer the probe ping by then.
    let mut probe: Option<tokio::time::Instant> = None;
    loop {
        let quiet = probe.map_or(Duration::from_secs(60), |by| {
            by.saturating_duration_since(tokio::time::Instant::now())
        });
        tokio::select! {
            incoming = tokio::time::timeout(quiet, stream.next()) => {
                let message = match incoming {
                    Ok(Some(Ok(m))) => m,
                    _ => return (true, Ended::Retry),
                };
                probe = None;
                match message {
                    Message::Binary(data) if data.len() > 16 => {
                        let mut id = [0u8; 16];
                        id.copy_from_slice(&data[..16]);
                        mesh.on_frame(DeviceId::from_bytes(id), &data[16..]);
                    }
                    Message::Text(text) => {
                        let control: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
                        match control["type"].as_str() {
                            Some("hello") => {
                                let online: Vec<DeviceId> = control["online"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(|v| v.as_str().and_then(DeviceId::parse))
                                    .collect();
                                mesh.set_online(&online);
                                cloud.set_phase(Phase::Online, None);
                                mesh.refresh.notify_one();
                                for peer in online {
                                    mesh.host.online(peer);
                                }
                            }
                            Some("presence") => {
                                if let Some(id) = control["device_id"].as_str().and_then(DeviceId::parse) {
                                    let online = control["online"].as_bool().unwrap_or(false);
                                    mesh.presence(id, online);
                                    if online {
                                        mesh.host.online(id);
                                    }
                                }
                            }
                            Some("devices_changed") => mesh.refresh.notify_one(),
                            Some("undeliverable") => {
                                if let Some(id) = control["peer"].as_str().and_then(DeviceId::parse) {
                                    mesh.presence(id, false);
                                }
                            }
                            _ => {}
                        }
                    }
                    Message::Close(frame) => {
                        let code = frame.map(|f| u16::from(f.code));
                        return match code {
                            Some(4003) => {
                                cloud.removed(&*mesh.host);
                                (true, Ended::Stop)
                            }
                            Some(4001) => {
                                cloud.set_phase(Phase::Offline, Some("this device connected from somewhere else".into()));
                                (true, Ended::Stop)
                            }
                            _ => (true, Ended::Retry),
                        };
                    }
                    _ => {}
                }
            }
            outgoing = out_rx.recv() => {
                let Some((to, payload)) = outgoing else { return (true, Ended::Stop) };
                let mut frame = to.to_bytes().to_vec();
                frame.extend_from_slice(&payload);
                if sink.send(Message::Binary(frame.into())).await.is_err() {
                    return (true, Ended::Retry);
                }
            }
            _ = ping.tick() => {
                if sink.send(Message::Ping(Default::default())).await.is_err() {
                    return (true, Ended::Retry);
                }
            }
            _ = mesh.wake.notified() => {
                if sink.send(Message::Ping(Default::default())).await.is_err() {
                    return (true, Ended::Retry);
                }
                probe.get_or_insert(tokio::time::Instant::now() + Duration::from_secs(10));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host that records nothing: the tests here only exercise the
    /// pure bookkeeping, never a live frame.
    struct Nop;
    impl CloudHost for Nop {
        fn dispatch(&self, _: PeerContext, _: Request) -> BoxFuture<'static, Response> {
            Box::pin(std::future::ready(Response {
                status: 200,
                content_type: None,
                body: Vec::new(),
            }))
        }
        fn note(&self, _: PeerContext, _: Value) {}
        fn linked(&self, _: DeviceId) {}
        fn online(&self, _: DeviceId) {}
        fn revoked(&self) {}
    }

    /// A mesh over a throwaway pins file, in the temp dir the way this
    /// workspace's other unit tests do it.
    fn test_mesh() -> (Mesh, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("or-mesh-{}", uuid::Uuid::new_v4()));
        openremote_core::fsx::create_private_dir(&dir).unwrap();
        let (out, _rx) = mpsc::unbounded_channel();
        let mesh = Mesh {
            me: DeviceId::new(),
            account: "test".into(),
            private: Vec::new(),
            kind: Mutex::new("desktop".into()),
            out,
            state: Mutex::new(State::default()),
            host: Arc::new(Nop),
            pins_file: dir.join("peers.json"),
            refresh: Notify::new(),
            wake: Notify::new(),
        };
        (mesh, dir)
    }

    /// A fresh X25519 public key, base64url, exactly as the registry
    /// serves them.
    fn key() -> String {
        use base64::Engine;
        let keys = snow::Builder::new(crate::identity::NOISE_PARAMS.parse().unwrap())
            .generate_keypair()
            .unwrap();
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(keys.public)
    }

    fn decode(raw: &str) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(raw)
            .unwrap()
    }

    fn pins_at(mesh: &Mesh) -> HashMap<String, String> {
        std::fs::read(&mesh.pins_file)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    /// `None`: an unpinnable key is never key material.
    #[test]
    fn keys_without_32_clean_base64_bytes_are_rejected() {
        use base64::Engine;
        let b64 = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        assert!(validated_pubkey(&key()).is_some(), "a real key passes");
        assert!(validated_pubkey("").is_none(), "empty never pins");
        assert!(validated_pubkey("no!").is_none(), "bad base64 never pins");
        assert!(validated_pubkey(&b64(&[0u8; 31])).is_none(), "too short");
        assert!(validated_pubkey(&b64(&[0u8; 33])).is_none(), "too long");
        assert_eq!(
            validated_pubkey(&key()).map(|k| k.len()),
            Some(32),
            "the decoded key is exactly the pin"
        );
    }

    /// An entry without a usable key is skipped and re-fetched, never
    /// pinned: when the real key arrives it pins cleanly with no
    /// `key_changed`, and a glitchy re-fetch never drops a good peer.
    #[test]
    fn an_unpinnable_entry_is_skipped_not_pinned() {
        let (mesh, dir) = test_mesh();
        let good = (DeviceId::new(), key());
        let silent = DeviceId::new(); // no noise_pubkey at all
        let blank = (DeviceId::new(), String::new());
        let malformed = (DeviceId::new(), "not base64!".to_string());
        let short = (DeviceId::new(), {
            use base64::Engine;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0u8; 31])
        });

        let entry = |id: Option<DeviceId>, raw: Option<&str>| {
            let mut d = json!({"name": "d", "kind": "desktop"});
            if let Some(id) = id {
                d["id"] = id.to_string().into();
            }
            if let Some(raw) = raw {
                d["noise_pubkey"] = raw.into();
            }
            d
        };
        let body = json!({"devices": [
            entry(Some(good.0), Some(&good.1)),
            entry(Some(silent), None),
            entry(Some(blank.0), Some(&blank.1)),
            entry(Some(malformed.0), Some(&malformed.1)),
            entry(Some(short.0), Some(&short.1)),
        ]});
        assert!(
            !mesh.update_devices(&body),
            "an unpinnable entry reads as a failed fetch"
        );

        let peers = mesh.peers();
        assert_eq!(peers.len(), 1, "only the pinnable device is listed");
        assert_eq!(peers[0].id, good.0);
        assert_eq!(peers[0].problem, None, "the good device has no problem");
        assert_eq!(peers[0].pubkey, decode(&good.1), "its key decodes");
        let pins = pins_at(&mesh);
        assert_eq!(pins.len(), 1, "nothing unpinnable was stored");
        assert_eq!(pins[&good.0.to_string()], good.1, "the good key is pinned");

        // The registry recovers and serves the real key: no key_changed,
        // because nothing was ever pinned for these devices.
        let recovered = json!({"devices": [
            entry(Some(good.0), Some(&good.1)),
            entry(Some(silent), Some(&key())),
            entry(Some(blank.0), Some(&key())),
            entry(Some(malformed.0), Some(&key())),
            entry(Some(short.0), Some(&key())),
        ]});
        assert!(
            mesh.update_devices(&recovered),
            "the recovered list is clean"
        );
        for id in [&silent, &blank.0, &malformed.0, &short.0] {
            let peer = mesh.peer(*id).expect("recovered into the list");
            assert_eq!(peer.problem, None, "the real key pins without a flag");
        }
        assert_eq!(pins_at(&mesh).len(), 5, "each device ended up pinned once");

        // One glitchy fetch after a good one: the entry keeps its last
        // good self (and its link) instead of being dropped from the list.
        let glitch = json!({"devices": [entry(Some(good.0), None)]});
        assert!(!mesh.update_devices(&glitch));
        let kept = mesh
            .peer(good.0)
            .expect("a skipped entry keeps its last good self");
        assert_eq!(kept.problem, None);
        assert_eq!(kept.pubkey, decode(&good.1), "the last good key survives");
        // A device the list left out entirely is still removed, as before.
        assert!(mesh.peer(silent).is_none(), "absent still means removed");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A pin that isn't valid key material was never a real key, so the
    /// real key later is a re-pin, not a change. A genuine key change is
    /// still flagged.
    #[test]
    fn an_empty_legacy_pin_is_healed_and_a_real_change_is_still_flagged() {
        let (mesh, dir) = test_mesh();
        let id = DeviceId::new();
        assert!(
            !mesh.pins_file.exists(),
            "the throwaway pins file starts clean"
        );

        // An older daemon pinned the empty key a glitchy fetch served.
        openremote_core::fsx::write_private(
            &mesh.pins_file,
            &serde_json::to_vec(&json!({id.to_string(): ""})).unwrap(),
        )
        .unwrap();

        let real = key();
        let body = json!({"devices": [
            {"id": id.to_string(), "noise_pubkey": real, "name": "d", "kind": "desktop"},
        ]});
        assert!(mesh.update_devices(&body), "the list is otherwise clean");
        let peer = mesh.peer(id).unwrap();
        assert_eq!(peer.problem, None, "the empty pin is healed, not flagged");
        assert_eq!(peer.pubkey, decode(&real));
        assert_eq!(
            pins_at(&mesh)[&id.to_string()],
            real,
            "the pin is the real key"
        );

        // The registry's key genuinely changing is still refused.
        let changed = json!({"devices": [
            {"id": id.to_string(), "noise_pubkey": key(), "name": "d", "kind": "desktop"},
        ]});
        assert!(mesh.update_devices(&changed));
        assert_eq!(
            mesh.peer(id).unwrap().problem,
            Some("key_changed"),
            "a real change is still flagged"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Two failed device-list fetches in a row are an outage, not a blip: the
    /// console gets a notice next to the phase. It is raised once per run of
    /// failures (rewriting it every five minutes would only churn the view)
    /// and the next good fetch takes it back down - but only when the notice
    /// on screen is still the one this loop raised.
    #[test]
    fn a_failing_device_list_is_surfaced_once_per_run_and_cleared_once() {
        let mut surfacer = Surfacer::default();
        assert_eq!(
            surfacer.failed(Phase::Online, None),
            None,
            "one failed fetch is a blip"
        );
        assert_eq!(
            surfacer.failed(Phase::Online, None),
            Some((Phase::Online, Some(UNREACHABLE))),
            "two in a row is an outage the user should see"
        );
        assert_eq!(
            surfacer.failed(Phase::Online, Some(UNREACHABLE)),
            None,
            "the notice is raised once, not rewritten on every later failure"
        );
        assert_eq!(
            surfacer.recovered(Phase::Online, Some(UNREACHABLE)),
            Some(Phase::Online),
            "the next good fetch clears it"
        );
        assert_eq!(
            surfacer.failed(Phase::Online, None),
            None,
            "the run of failures restarted with that success"
        );
    }

    /// A notice that came from somewhere that knows more - a takeover, a
    /// removal, a prompt to sign in - is never replaced by the refresher's
    /// generic one, however long the outage runs.
    #[test]
    fn a_failing_device_list_never_overwrites_a_more_specific_notice() {
        let takeover = Some("this device connected from somewhere else");
        let mut surfacer = Surfacer::default();
        for _ in 0..5 {
            assert_eq!(
                surfacer.failed(Phase::Offline, takeover),
                None,
                "a specific notice is left alone"
            );
        }
    }

    /// Clearing is the mirror image: a good fetch may only take down the
    /// notice this loop raised, never one another writer put there.
    #[test]
    fn the_refresher_clears_only_the_notice_it_raised() {
        // The loop raised its own notice at Offline; meanwhile something that
        // knew more replaced it with the reason.
        let mut replaced = Surfacer {
            failures: REFRESH_FAILURES_TO_ERROR,
            at: Some(Phase::Offline),
        };
        assert_eq!(
            replaced.recovered(
                Phase::Offline,
                Some("This device was removed from your account.")
            ),
            None,
            "another writer's notice survives a good fetch"
        );
        // Its own notice still comes down.
        let mut own = Surfacer {
            failures: REFRESH_FAILURES_TO_ERROR,
            at: Some(Phase::Offline),
        };
        assert_eq!(
            own.recovered(Phase::Offline, Some(UNREACHABLE)),
            Some(Phase::Offline),
            "the notice this loop raised is its to clear"
        );
        assert_eq!(
            own.failed(Phase::Offline, None),
            None,
            "and the next outage starts counting from scratch"
        );
    }

    /// An inbound stream whose END never comes gives its slot back at its
    /// deadline; a live one keeps it.
    #[test]
    fn expired_inbound_streams_reclaim_their_slots() {
        let a = DeviceId::new();
        let b = DeviceId::new();
        let live = || Request {
            method: "GET".into(),
            path: "/".into(),
            content_type: None,
            body: Vec::new(),
        };
        let mut inbound = HashMap::new();
        let now = Instant::now();
        inbound.insert(
            (a, 1),
            Inbound {
                request: live(),
                deadline: now - Duration::from_secs(1),
            },
        );
        inbound.insert(
            (a, 2),
            Inbound {
                request: live(),
                deadline: now, // exactly at the deadline: gone
            },
        );
        inbound.insert(
            (a, 3),
            Inbound {
                request: live(),
                deadline: now + Duration::from_secs(60),
            },
        );
        inbound.insert(
            (b, 1),
            Inbound {
                request: live(),
                deadline: now + Duration::from_secs(60),
            },
        );
        assert_eq!(reclaim_expired(&mut inbound, now), 2, "the stale pair goes");
        assert_eq!(inbound.len(), 2, "the live ones stay");
        assert!(inbound.contains_key(&(a, 3)));
        assert!(inbound.contains_key(&(b, 1)));
        assert_eq!(
            reclaim_expired(&mut inbound, now + Duration::from_secs(61)),
            2,
            "the next sweep takes what has aged out since"
        );
        assert!(inbound.is_empty());
    }
}
