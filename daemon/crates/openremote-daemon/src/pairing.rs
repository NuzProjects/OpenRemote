//! Pairing a phone over the local network with a QR code, no account.
//!
//! Two surfaces live here and they never share a credential.
//!
//! - The **LAN listener** serves the phone page, the one-time code exchange,
//!   the projection a paired phone reads, and an empty favicon. It is bound
//!   only while a code is live or a phone is paired.
//! - The **control routes** under `/pairing/` are merged into the daemon's
//!   own router in `main.rs`, on the loopback listener the console already
//!   knows. They take the owner token like every other console call, and a
//!   socket bound to 127.0.0.1 decides who can reach them.
//!
//! The owner token never appears in the QR payload, in the page, in an
//! exchange answer, or in a log line. A phone's token is kept here only as a
//! SHA-256 digest, in an owner-only file, and exactly one route accepts it.
//!
//! The threat model and the wire shapes are written up in
//! `docs/superpowers/specs/2026-10-26-qr-pairing-design.md`.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};

use axum::extract::{DefaultBodyLimit, Path as AxumPath, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::app::App;

/// How long a pairing code lives. Minutes, so a QR left on a screen in a
/// shared room stops working while the room is still there.
pub const CODE_TTL_MS: i64 = 5 * 60 * 1000;

/// Wrong codes a single live code survives. A device on the same network
/// gets five guesses at 40 bits, then the code is gone and the person at the
/// machine shows a new one.
pub const MAX_FAILED_ATTEMPTS: u32 = 5;

/// The ports the LAN listener tries, in order. A fixed port keeps the
/// phone's origin (`http://<lan-ip>:<port>`) stable across daemon restarts,
/// so a paired phone's stored token keeps working without a second scan.
const PORT_CANDIDATES: [u16; 6] = [47823, 47824, 47825, 47826, 47827, 47828];

/// This computer's name, its harnesses, and up to this many recent chats is
/// the whole of what a phone may learn.
const CHAT_LIMIT: usize = 25;

/// The pairing host: one live code, the paired phones, and the LAN listener.
pub struct PairingHost {
    app: Arc<App>,
    /// Serialises turning the LAN listener on or off. Binding is an await,
    /// and a second mint racing the first must not bind a second socket.
    listener_lock: tokio::sync::Mutex<()>,
    inner: StdMutex<Inner>,
    /// `<data>/paired-phones.json`: digests and names, never a token.
    phones_path: PathBuf,
    bind: Bind,
    code_ttl_ms: i64,
}

struct Inner {
    code: Option<LiveCode>,
    failures: u32,
    phones: Vec<Phone>,
    listener: Option<Running>,
    /// A sentence for the console about the listener itself, when the daemon
    /// failed to open it at boot with a phone already paired. The console has
    /// no other way to know: the phones are still listed and the page simply
    /// does not answer.
    notice: Option<String>,
}

struct LiveCode {
    value: String,
    expires_at: i64,
}

struct Running {
    /// Where the socket actually bound. Kept beside the task so a later mint
    /// can tell that the address this computer advertises has moved and
    /// rebind, instead of pointing a fresh QR at a stale interface.
    addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

/// A paired phone, in memory. `digest` is the SHA-256 of the token it was
/// given; the token itself exists only on the phone.
#[derive(Clone, Debug)]
pub struct Phone {
    pub id: String,
    pub name: String,
    digest: String,
    pub paired_at: i64,
}

/// How the LAN listener binds: the machine's network in production, an exact
/// address in tests (where a real phone is a second HTTP client on loopback).
enum Bind {
    Network,
    Fixed(SocketAddr),
}

/// What the desktop shows for a phone: never the digest.
#[derive(Serialize)]
pub struct PhoneView {
    pub id: String,
    pub name: String,
    pub paired_at: i64,
}

/// The answer to a mint: everything the console needs to draw a QR.
pub struct Mint {
    pub code: String,
    pub url: String,
    pub expires_at: i64,
    pub computer: String,
    pub phones: Vec<PhoneView>,
}

/// Why a mint failed. The console turns each arm into its own sentence.
#[derive(Debug, PartialEq)]
pub enum MintError {
    /// No address on a network: a laptop with the network off.
    NoNetwork,
    /// Every candidate port is taken by something else.
    NoPort(String),
}

/// Why an exchange failed. The phone page turns each arm into its own
/// sentence.
#[derive(Debug, PartialEq)]
pub enum ExchangeError {
    /// Unknown, already used, or the failed-attempt limit was reached.
    Invalid,
    Expired,
    /// A code or name the page should never have sent.
    Malformed,
    /// The code was right and the phone could not be written down. No token
    /// is handed out: a pairing this computer forgets on the next start is
    /// worse than one that never happened.
    NotSaved,
}

/// Why a revoke failed. `Unknown` lets the console stop redrawing a phone the
/// user already removed; `NotSaved` is the one case that must fail closed.
#[derive(Debug, PartialEq)]
pub enum RevokeError {
    /// No phone here has that id.
    Unknown,
    /// The file could not be written, so the phone stays paired.
    NotSaved,
}

#[derive(Deserialize)]
pub struct ExchangeBody {
    pub code: String,
    #[serde(default)]
    pub name: Option<String>,
}

impl PairingHost {
    /// Opens the host over `app`'s data folder. Paired phones are read from
    /// disk here; nothing is listening yet.
    pub fn open(app: Arc<App>) -> Arc<Self> {
        Self::build(app, Bind::Network, CODE_TTL_MS)
    }

    /// A host that binds an exact address, advertised as given: the e2e
    /// suites pair a second HTTP client on loopback, then check the LAN
    /// narrowing at the socket level.
    pub fn open_on(app: Arc<App>, addr: SocketAddr, code_ttl_ms: i64) -> Arc<Self> {
        Self::build(app, Bind::Fixed(addr), code_ttl_ms)
    }

    fn build(app: Arc<App>, bind: Bind, code_ttl_ms: i64) -> Arc<Self> {
        let phones_path = app.data_dir.join("paired-phones.json");
        let phones = read_phones(&phones_path);
        Arc::new(Self {
            app,
            listener_lock: tokio::sync::Mutex::new(()),
            inner: StdMutex::new(Inner {
                code: None,
                failures: 0,
                phones,
                listener: None,
                notice: None,
            }),
            phones_path,
            bind,
            code_ttl_ms,
        })
    }

    /// Brings the LAN listener up when a phone is already paired: after a
    /// daemon restart the phone keeps working without the desktop having to
    /// open the pairing panel first.
    pub async fn restore(self: &Arc<Self>) {
        if self.inner().phones.is_empty() {
            return;
        }
        // Not fatal: a paired phone keeps its record and the panel says what
        // went wrong, so the person can show a code again to retry the bind.
        if let Err(err) = self.ensure_listener().await {
            eprintln!("openremote-daemon: pairing listener is not up ({err:?})");
            self.inner().notice = Some(
                "This computer could not open the pairing port, so a paired phone cannot reach it right now. Showing a code tries again.".to_string(),
            );
        }
    }

    /// The sentence the console should show about the listener, if any.
    pub fn notice(&self) -> Option<String> {
        self.inner().notice.clone()
    }

    /// The data folder this host keeps its digests in.
    pub fn phones_path(&self) -> &Path {
        &self.phones_path
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        // The lock guards plain data and no code panics while holding it, so
        // a poisoned lock means an earlier request's panic: the data is
        // still consistent, and refusing to serve would be worse.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Mints a code, replacing any code that was live (which is also how a
    /// stale QR is cancelled), and makes sure the listener is up.
    pub async fn mint(self: &Arc<Self>) -> Result<Mint, MintError> {
        // The socket comes first. A machine with no network, or with every
        // candidate port taken, must not leave the previous code redeemable
        // behind an error the user is looking at: a code nobody can see is a
        // credential nobody is watching, so a failed mint takes the old one
        // down with it.
        let addr = match self.ensure_listener().await {
            Ok(addr) => addr,
            Err(err) => {
                self.cancel().await;
                return Err(err);
            }
        };
        let code = new_code();
        let expires_at = openremote_core::now_ms() + self.code_ttl_ms;
        {
            let mut inner = self.inner();
            inner.code = Some(LiveCode {
                value: code.clone(),
                expires_at,
            });
            inner.failures = 0;
            // The listener answered this time, so the boot-time complaint is
            // no longer true.
            inner.notice = None;
        }
        // The code rides in the fragment: it is never sent to the server in
        // a request line, so no log and no proxy ever holds it.
        let url = format!("http://{addr}/#{code}");
        // A code left on screen is the only reason this socket is up on a
        // machine with no paired phone, so the socket goes down with the
        // code. Expiry is otherwise only noticed by the next exchange, which
        // is exactly the case where nobody is there to make one.
        let this = Arc::clone(self);
        let wait = u64::try_from(self.code_ttl_ms).unwrap_or(0);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(wait + 250)).await;
            this.expire_code().await;
        });
        Ok(Mint {
            code,
            url,
            expires_at,
            computer: openremote_core::hostname(),
            phones: self.phones(),
        })
    }

    /// Drops the code if it has run out, and with it the listener when no
    /// phone is paired. A newer code minted while we slept stays: its own
    /// timer closes the socket when its time comes.
    async fn expire_code(self: &Arc<Self>) {
        let idle = {
            let mut inner = self.inner();
            let expired = inner
                .code
                .as_ref()
                .is_some_and(|live| openremote_core::now_ms() >= live.expires_at);
            if !expired {
                return;
            }
            inner.code = None;
            inner.failures = 0;
            inner.phones.is_empty()
        };
        if idle {
            self.stop_listener().await;
        }
    }

    /// Stops pairing: the live code dies and, if no phone is paired, so does
    /// the listener.
    pub async fn cancel(self: &Arc<Self>) {
        let idle = {
            let mut inner = self.inner();
            inner.code = None;
            inner.failures = 0;
            inner.phones.is_empty()
        };
        if idle {
            self.stop_listener().await;
        }
    }

    pub fn phones(&self) -> Vec<PhoneView> {
        self.inner()
            .phones
            .iter()
            .map(|p| PhoneView {
                id: p.id.clone(),
                name: p.name.clone(),
                paired_at: p.paired_at,
            })
            .collect()
    }

    /// Removes a paired phone. `Unknown` when no phone has that id, so the
    /// console can say something true instead of redrawing the same list.
    ///
    /// Fails closed: the record comes off disk before it comes out of memory,
    /// and a write that failed puts it back and reports `NotSaved`. Revoking
    /// is the one path where telling the user it worked when it did not
    /// leaves a phone that comes back after the next restart.
    pub fn revoke(&self, id: &str) -> Result<Vec<PhoneView>, RevokeError> {
        let idle = {
            let mut inner = self.inner();
            let Some(index) = inner.phones.iter().position(|phone| phone.id == id) else {
                return Err(RevokeError::Unknown);
            };
            let removed = inner.phones.remove(index);
            let stored = StoredFile {
                version: 1,
                phones: inner.phones.iter().map(StoredPhone::from).collect(),
            };
            if let Err(err) = write_phones(&self.phones_path, &stored) {
                eprintln!(
                    "openremote-daemon: can't write {}: {err}",
                    self.phones_path.display()
                );
                inner.phones.insert(index, removed);
                return Err(RevokeError::NotSaved);
            }
            inner.phones.is_empty() && inner.code.is_none()
        };
        if idle {
            // Dropping the task closes the socket. Not awaited: revoke is a
            // plain console call, and the next mint brings it back.
            if let Some(running) = self.inner().listener.take() {
                running.task.abort();
            }
        }
        Ok(self.phones())
    }

    /// The pairing code answers a phone at most once, inside its TTL, and
    /// only until the owner cancels it or the attempt limit is hit.
    pub fn exchange(&self, body: &ExchangeBody) -> Result<(String, Phone), ExchangeError> {
        if body.code.is_empty() || body.code.len() > 64 {
            return Err(ExchangeError::Malformed);
        }
        let name = clean_name(body.name.as_deref());
        let now = openremote_core::now_ms();
        let mut inner = self.inner();
        let Some(live) = inner.code.as_ref() else {
            return Err(ExchangeError::Invalid);
        };
        if now > live.expires_at {
            inner.code = None;
            inner.failures = 0;
            // A code that ran out is the same situation as a cancel: with no
            // phone paired, nothing has a reason to keep listening.
            let idle = inner.phones.is_empty();
            if idle {
                if let Some(running) = inner.listener.take() {
                    running.task.abort();
                }
            }
            return Err(ExchangeError::Expired);
        }
        if !openremote_core::same_secret(&body.code, &live.value) {
            inner.failures += 1;
            if inner.failures >= MAX_FAILED_ATTEMPTS {
                // The guesses are the attack: burn the code rather than let
                // the same one keep answering. The socket goes with it when
                // no phone is paired, so burning a code cannot leave the
                // listener up with nothing behind it for the rest of the TTL.
                inner.code = None;
                inner.failures = 0;
                let idle = inner.phones.is_empty();
                if idle {
                    if let Some(running) = inner.listener.take() {
                        running.task.abort();
                    }
                }
            }
            return Err(ExchangeError::Invalid);
        }
        let token = new_token();
        let phone = Phone {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            digest: digest(&token),
            paired_at: now,
        };
        inner.code = None;
        inner.failures = 0;
        inner.phones.push(phone.clone());
        let stored = StoredFile {
            version: 1,
            phones: inner.phones.iter().map(StoredPhone::from).collect(),
        };
        // Written under the lock: it is a few hundred bytes, and the
        // alternative is two exchanges interleaving into one file.
        if let Err(err) = write_phones(&self.phones_path, &stored) {
            // Fail closed: a phone this computer cannot remember would come
            // back gone after a restart, and the token would be fiction.
            eprintln!(
                "openremote-daemon: can't write {}: {err}",
                self.phones_path.display()
            );
            inner.phones.pop();
            let idle = inner.phones.is_empty();
            if idle {
                if let Some(running) = inner.listener.take() {
                    running.task.abort();
                }
            }
            return Err(ExchangeError::NotSaved);
        }
        Ok((token, phone))
    }

    /// The phone a token belongs to, for the one route a phone may call.
    pub fn phone_for(&self, token: &str) -> Option<Phone> {
        let presented = digest(token);
        let inner = self.inner();
        inner
            .phones
            .iter()
            .find(|p| openremote_core::same_secret(&presented, &p.digest))
            .cloned()
    }

    /// Where the LAN listener is bound, if it is still there. A serve task
    /// that answered its last request is not a listener, and keeping its
    /// record would let a later mint hand out a QR for a socket that is
    /// gone.
    fn live_addr(&self) -> Option<SocketAddr> {
        let mut inner = self.inner();
        if inner
            .listener
            .as_ref()
            .is_some_and(|running| running.task.is_finished())
        {
            inner.listener = None;
            return None;
        }
        inner.listener.as_ref().map(|running| running.addr)
    }

    /// Makes sure the listener is up on the address this computer advertises
    /// right now, and answers with where it actually bound.
    ///
    /// A listener left on an address this machine no longer has (a DHCP
    /// lease moved it, Wi-Fi was swapped for Ethernet, a VPN came up) is
    /// closed and rebound here: that is what makes the next code repair a
    /// stale QR instead of repeating it.
    async fn ensure_listener(self: &Arc<Self>) -> Result<SocketAddr, MintError> {
        let Some(want) = self.advertised_ip() else {
            return Err(MintError::NoNetwork);
        };
        let _guard = self.listener_lock.lock().await;
        if let Some(addr) = self.live_addr() {
            if addr.ip() == IpAddr::V4(want) {
                return Ok(addr);
            }
            // Same machine, different address: the socket is on an interface
            // the QR no longer names.
            if let Some(running) = self.inner().listener.take() {
                running.task.abort();
            }
        }
        let listener = match self.bind {
            Bind::Fixed(addr) => tokio::net::TcpListener::bind(addr)
                .await
                .map_err(|e| MintError::NoPort(format!("{addr}: {e}")))?,
            Bind::Network => {
                // The machine's own network address, not 0.0.0.0: the
                // socket then exists on exactly the interface the QR points
                // at, and on no other - not loopback aliases, not a VPN, not
                // a second adapter the person did not mean to expose.
                let mut bound = None;
                for port in PORT_CANDIDATES {
                    if let Ok(listener) = tokio::net::TcpListener::bind((want, port)).await {
                        bound = Some(listener);
                        break;
                    }
                }
                bound.ok_or_else(|| {
                    MintError::NoPort(format!(
                        "none of the pairing ports {PORT_CANDIDATES:?} on {want} is free"
                    ))
                })?
            }
        };
        let addr = listener
            .local_addr()
            .map_err(|e| MintError::NoPort(e.to_string()))?;
        let router = Arc::clone(self).routes();
        let task = tokio::spawn(async move {
            // Runs until the socket is dropped (abort on revoke or cancel)
            // or the daemon exits. One connection's error never kills it.
            let _ = axum::serve(listener, router).await;
        });
        self.inner().listener = Some(Running { addr, task });
        Ok(addr)
    }

    async fn stop_listener(&self) {
        let _guard = self.listener_lock.lock().await;
        if let Some(running) = self.inner().listener.take() {
            running.task.abort();
        }
    }

    fn advertised_ip(&self) -> Option<Ipv4Addr> {
        match self.bind {
            Bind::Fixed(addr) => match addr.ip() {
                IpAddr::V4(ip) => Some(ip),
                // An IPv6 test address has no IPv4 form to advertise; the
                // suites that use this bind loopback and never see this arm.
                IpAddr::V6(_) => None,
            },
            Bind::Network => lan_address(),
        }
    }

    /// The control routes, for the loopback router: mint, cancel, list,
    /// revoke. Owner token, as every console call.
    pub fn control_router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/pairing/code", post(mint))
            .route("/pairing/cancel", post(cancel))
            .route("/pairing/phones", get(phones))
            .route("/pairing/phones/{id}/revoke", post(revoke))
            .layer(middleware::from_fn_with_state(
                Arc::clone(&self.app),
                owner_gate,
            ))
            .layer(console_cors())
            .with_state(Arc::clone(self))
    }

    /// The LAN listener's own router: the page, the exchange, and the one
    /// read-only route a paired phone may call. No other route exists here,
    /// so a phone token cannot reach the owner API however it is presented.
    /// There is no CORS layer: the page is same-origin, and a page from
    /// anywhere else must not be able to read an answer even with a token.
    fn routes(self: Arc<Self>) -> Router {
        Router::new()
            .route("/", get(page))
            .route("/pair", post(pair).layer(DefaultBodyLimit::max(1024)))
            .route("/api/home", get(home))
            .route("/favicon.ico", get(|| async { StatusCode::NO_CONTENT }))
            .with_state(self)
    }
}

/// The console's own origins, as in the daemon's API: these routes are
/// merged into the loopback router after its CORS layer, so they carry their
/// own. A phone's origin never appears here.
fn console_cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| {
            let Ok(s) = origin.to_str() else {
                return false;
            };
            let rest = s
                .strip_prefix("http://")
                .or_else(|| s.strip_prefix("https://"))
                .or_else(|| s.strip_prefix("tauri://"))
                .or_else(|| s.strip_prefix("ios://"))
                .unwrap_or("");
            let host = rest.split([':', '/']).next().unwrap_or("");
            matches!(
                host,
                "localhost" | "127.0.0.1" | "[::1]" | "tauri.localhost"
            )
        }))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

async fn owner_gate(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let presented = bearer(&request);
    if openremote_core::same_secret(presented, &app.token) {
        return next.run(request).await;
    }
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

fn bearer(request: &Request) -> &str {
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default()
}

// ---- control routes (loopback, owner token) ----

async fn mint(State(host): State<Arc<PairingHost>>) -> Response {
    match host.mint().await {
        Ok(mint) => Json(json!({
            "code": mint.code,
            "url": mint.url,
            "expires_at": mint.expires_at,
            "computer": { "name": mint.computer },
            "phones": mint.phones,
        }))
        .into_response(),
        Err(MintError::NoNetwork) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "This computer is not on a network, so a phone cannot reach it."
            })),
        )
            .into_response(),
        Err(MintError::NoPort(why)) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("No free pairing port: {why}") })),
        )
            .into_response(),
    }
}

async fn cancel(State(host): State<Arc<PairingHost>>) -> Response {
    host.cancel().await;
    Json(json!({ "phones": host.phones(), "notice": host.notice() })).into_response()
}

async fn phones(State(host): State<Arc<PairingHost>>) -> Response {
    Json(json!({ "phones": host.phones(), "notice": host.notice() })).into_response()
}

async fn revoke(State(host): State<Arc<PairingHost>>, AxumPath(id): AxumPath<String>) -> Response {
    match host.revoke(&id) {
        Ok(phones) => Json(json!({ "phones": phones, "notice": host.notice() })).into_response(),
        Err(RevokeError::Unknown) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "That phone is not paired with this computer." })),
        )
            .into_response(),
        Err(RevokeError::NotSaved) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": "This computer could not remove that phone. It is still paired, so try again."
            })),
        )
            .into_response(),
    }
}

// ---- LAN routes (the phone) ----

async fn page() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            // Everything the page needs is inline and same-origin: it loads
            // no font, no image, no script and no frame from anywhere.
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; script-src 'unsafe-inline'; \
                 style-src 'unsafe-inline'; connect-src 'self'; \
                 base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ),
        ],
        crate::pairing_page::PAGE,
    )
        .into_response()
}

async fn pair(State(host): State<Arc<PairingHost>>, Json(body): Json<ExchangeBody>) -> Response {
    match host.exchange(&body) {
        Ok((token, phone)) => Json(json!({
            "token": token,
            "phone": { "id": phone.id, "name": phone.name },
            "computer": { "name": openremote_core::hostname() },
        }))
        .into_response(),
        Err(ExchangeError::Malformed | ExchangeError::Invalid) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "That pairing code is not valid." })),
        )
            .into_response(),
        Err(ExchangeError::Expired) => (
            StatusCode::GONE,
            Json(json!({ "error": "That pairing code expired." })),
        )
            .into_response(),
        Err(ExchangeError::NotSaved) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": "This computer could not save the pairing, so nothing was paired. Try again."
            })),
        )
            .into_response(),
    }
}

/// What a paired phone sees: this computer's name, its harnesses, and the
/// recent chats, projected field by field. A chat's workspace path is host
/// filesystem detail and stays here; so does everything a phone cannot do.
async fn home(State(host): State<Arc<PairingHost>>, request: Request) -> Response {
    let Some(phone) = host.phone_for(bearer(&request)) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "This computer removed this phone." })),
        )
            .into_response();
    };
    let mut chats = host.app.supervisor.sessions();
    // Newest first: a phone shows the chats someone would resume, not the
    // oldest ones in the store.
    chats.sort_by_key(|chat| std::cmp::Reverse(chat.updated_at));
    chats.truncate(CHAT_LIMIT);
    let chats: Vec<Value> = chats
        .iter()
        .map(|s| {
            json!({
                "id": s.id.to_string(),
                "title": s.title.clone().unwrap_or_else(|| "New chat".to_string()),
                "harness": &s.harness,
                "status": s.status,
                "updated_at": s.updated_at,
            })
        })
        .collect();
    let harnesses: Vec<Value> = host
        .app
        .supervisor
        .harnesses()
        .iter()
        .filter(|h| h.enabled)
        .map(|h| json!(h.id))
        .collect();
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Json(json!({
            "computer": {
                "name": openremote_core::hostname(),
                "harnesses": harnesses,
            },
            "phone": { "id": phone.id, "name": phone.name },
            "chats": chats,
        })),
    )
        .into_response()
}

// ---- pieces ----

/// The file's shape. Deliberately its own type: the in-memory `Phone` is not
/// `Serialize`, so the digest cannot reach a response by accident.
#[derive(Serialize, Deserialize)]
struct StoredFile {
    version: u32,
    phones: Vec<StoredPhone>,
}

#[derive(Serialize, Deserialize)]
struct StoredPhone {
    id: String,
    name: String,
    digest: String,
    paired_at: i64,
}

impl From<&Phone> for StoredPhone {
    fn from(phone: &Phone) -> Self {
        Self {
            id: phone.id.clone(),
            name: phone.name.clone(),
            digest: phone.digest.clone(),
            paired_at: phone.paired_at,
        }
    }
}

impl From<StoredPhone> for Phone {
    fn from(stored: StoredPhone) -> Self {
        Self {
            id: stored.id,
            name: stored.name,
            digest: stored.digest,
            paired_at: stored.paired_at,
        }
    }
}

/// The phones file, read once at start. A file this process wrote and cannot
/// read is a damaged file, not a reason to refuse to serve: start empty and
/// say so on stderr. Re-pairing is one scan.
fn read_phones(path: &Path) -> Vec<Phone> {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(err) => {
            eprintln!("openremote-daemon: can't read {}: {err}", path.display());
            return Vec::new();
        }
    };
    match serde_json::from_slice::<StoredFile>(&raw) {
        Ok(file) => file.phones.into_iter().map(Phone::from).collect(),
        Err(err) => {
            eprintln!(
                "openremote-daemon: {} is not a phones file ({err}); starting with no paired phones",
                path.display()
            );
            Vec::new()
        }
    }
}

/// Writes the phones file. A failure is the caller's to handle: the two
/// callers that change the list both fail closed on it.
fn write_phones(path: &Path, file: &StoredFile) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(file).map_err(std::io::Error::other)?;
    openremote_core::fsx::write_private(path, &bytes)
}

/// An 8 character code from an alphabet with no look-alikes, so a person
/// reading it off a screen cannot confuse it.
///
/// 40 bits: eight bytes of UUID randomness, each reduced modulo 32. A v4 UUID
/// is not 16 random bytes (byte 6 pins the version nibble and byte 8 pins the
/// variant), so those two are skipped rather than folded into the code - the
/// alternative is a seventh character that can only ever be one of 16, and a
/// code that is one bit weaker than it says. Five guesses against 2^40, inside
/// five minutes, is nothing.
fn new_code() -> String {
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let bytes = uuid::Uuid::new_v4().into_bytes();
    // The alphabet is 32 characters, so the byte's remainder divides evenly
    // and no character is favoured.
    bytes
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != 6 && *index != 8)
        .take(8)
        .map(|(_, b)| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

/// 64 hex characters from two v4 UUIDs: 244 bits, and only its digest is
/// ever written down.
fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn digest(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The phone's own name for itself, bounded and stripped of control
/// characters: it comes from a device we do not control and is drawn on the
/// desktop.
fn clean_name(raw: Option<&str>) -> String {
    let name: String = raw
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "Phone".to_string()
    } else {
        name.to_string()
    }
}

/// This machine's address on its network. `std` cannot enumerate interfaces,
/// and connecting a UDP socket sends no packet: it only asks the routing
/// table which local address this machine would source from. The probe
/// targets walk the gateways home and office networks use.
fn lan_address() -> Option<Ipv4Addr> {
    use std::net::UdpSocket;
    for target in [
        "192.168.1.1:9",
        "192.168.0.1:9",
        "10.0.0.1:9",
        "172.16.0.1:9",
        "192.168.1.254:9",
    ] {
        let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        let Ok(SocketAddr::V4(local)) = socket.local_addr() else {
            continue;
        };
        let ip = *local.ip();
        if !ip.is_unspecified() && !ip.is_loopback() && !ip.is_broadcast() {
            return Some(ip);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_avoid_lookalike_characters_and_are_eight_long() {
        for _ in 0..64 {
            let code = new_code();
            assert_eq!(code.len(), 8);
            assert!(
                code.bytes()
                    .all(|b| b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ".contains(&b)),
                "{code}"
            );
        }
    }

    /// A v4 UUID pins byte 6's high nibble and byte 8's top two bits, so
    /// drawing from all 16 bytes would make the seventh character weaker than
    /// the rest. This pins the property the comment claims: every position is
    /// free to be any of the 32 characters, which is 40 bits over eight. It
    /// fails on the old draw (which took byte 6 as it was), and it fails on
    /// the per-end count rather than a combined one, because position 7 there
    /// still reached the bottom of the alphabet while never reaching the top.
    #[test]
    fn no_position_of_a_code_is_limited_to_a_slice_of_the_alphabet() {
        const ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
        const LOW: u8 = ALPHABET[0];
        const HIGH: u8 = ALPHABET[ALPHABET.len() - 1];
        // One counter per end, never one total. A position drawing from only
        // the low half still reaches ALPHABET[0] about once in eight codes,
        // so a combined count stays comfortably green while half the alphabet
        // is out of reach: that is the shape of this test's first version,
        // and why it now counts each end on its own.
        let mut low = [0u32; 8];
        let mut high = [0u32; 8];
        for _ in 0..4000 {
            for (index, byte) in new_code().bytes().enumerate() {
                if byte == LOW {
                    low[index] += 1;
                } else if byte == HIGH {
                    high[index] += 1;
                }
            }
        }
        for index in 0..8 {
            assert!(
                low[index] > 20,
                "position {index} never drew the first character: low={low:?} high={high:?}"
            );
            assert!(
                high[index] > 20,
                "position {index} never drew the last character: low={low:?} high={high:?}"
            );
        }
    }

    #[test]
    fn tokens_are_long_and_only_their_digest_is_recorded() {
        let token = new_token();
        assert_eq!(token.len(), 64);
        assert_ne!(token, new_token());
        let hashed = digest(&token);
        assert_eq!(hashed.len(), 64);
        assert_ne!(hashed, token);
        assert_ne!(hashed, digest(&new_token()));
        assert_eq!(hashed, digest(&token), "the same token hashes once");
    }

    #[test]
    fn a_phone_name_is_bounded_and_never_empty() {
        assert_eq!(clean_name(None), "Phone");
        assert_eq!(clean_name(Some("   ")), "Phone");
        assert_eq!(clean_name(Some("iPhone\n")), "iPhone");
        assert_eq!(clean_name(Some("Pi\u{7}xel")), "Pixel");
        assert_eq!(clean_name(Some(&"x".repeat(200))).len(), 40);
    }
}
