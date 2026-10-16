//! Ad and tracker blocking, from the daemon's side. The blocking itself
//! happens in the app's browser, which holds the filter engine and answers
//! blocked requests on the spot; the daemon keeps what outlives it: the
//! setting (the store's `adblock`, off unless the user turns it on), the
//! sites the user allows ads on, and the filter lists.
//!
//! The lists are EasyList and EasyPrivacy, downloaded from their
//! publishers the first time blocking is turned on (never bundled with the
//! app, so a feature that is off costs no download and no installer
//! space), refreshed weekly, and kept in `<data_dir>/browser/filters/`.
//! Whenever any of it changes, and whenever the browser says hello, the
//! browser hears it all in one [`Call::Adblock`]. Off means the browser
//! intercepts nothing at all.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use openremote_browser::{Call, ToHost};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::store::BrowserStore;
use super::{BrowserService, lock};
use crate::app::App;

/// One filter list, from its publisher.
pub struct FilterList {
    pub id: &'static str,
    pub title: &'static str,
    pub url: &'static str,
}

/// EasyList (ads) and EasyPrivacy (trackers), as their authors publish
/// them. Both are dual licensed GPL-3.0-or-later / CC BY-SA 3.0 or later,
/// and are fetched by the user's own app, not redistributed by us.
pub const LISTS: &[FilterList] = &[
    FilterList {
        id: "easylist",
        title: "EasyList",
        url: "https://easylist.to/easylist/easylist.txt",
    },
    FilterList {
        id: "easyprivacy",
        title: "EasyPrivacy",
        url: "https://easylist.to/easylist/easyprivacy.txt",
    },
];

/// Lists older than this are fetched again.
const REFRESH_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);
/// A failed fetch is tried again after this long (or at once when the
/// user turns blocking on again).
const RETRY_AFTER: Duration = Duration::from_secs(3600);
/// How often the keeper looks at the lists' age on its own.
const TICK: Duration = Duration::from_secs(3600);
/// More than any list has ever weighed (EasyList is about 2 MB).
const MAX_LIST_BYTES: u64 = 16 << 20;

/// The setting's name in the browser's settings.
pub const SETTING: &str = "adblock";

/// Keeps the lists fresh and the browser told.
pub struct Keeper {
    dir: PathBuf,
    wake: Arc<Notify>,
    /// The browser said hello: it hears everything again.
    resend: AtomicBool,
    /// The user just turned blocking on: a failed fetch is retried now
    /// rather than in an hour.
    urgent: AtomicBool,
    state: Mutex<KeeperState>,
}

#[derive(Default)]
struct KeeperState {
    fetching: bool,
    error: Option<String>,
    last_try: Option<Instant>,
    /// What the browser was told last.
    told: Option<Call>,
}

/// Whether blocking is on: only when the user turned it on.
pub fn is_on(store: &BrowserStore) -> bool {
    store.settings().get(SETTING).and_then(Value::as_bool) == Some(true)
}

impl Keeper {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("browser").join("filters"),
            wake: Arc::new(Notify::new()),
            resend: AtomicBool::new(false),
            urgent: AtomicBool::new(false),
            state: Mutex::new(KeeperState::default()),
        }
    }

    fn path(&self, list: &FilterList) -> PathBuf {
        self.dir.join(format!("{}.txt", list.id))
    }

    /// When each list on disk was fetched, and its size.
    fn on_disk(&self, list: &FilterList) -> Option<(SystemTime, u64)> {
        let meta = std::fs::metadata(self.path(list)).ok()?;
        Some((meta.modified().ok()?, meta.len()))
    }

    /// Whether any list is missing or past its week.
    fn stale(&self) -> bool {
        LISTS.iter().any(|list| match self.on_disk(list) {
            Some((at, _)) => at.elapsed().map_or(true, |age| age > REFRESH_AFTER),
            None => true,
        })
    }

    /// The browser said hello: tell it everything again.
    pub fn hello(&self) {
        self.resend.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    /// The setting or the allowed sites changed; `turned_on` when the user
    /// just switched blocking on.
    pub fn changed(&self, turned_on: bool) {
        if turned_on {
            self.urgent.store(true, Ordering::SeqCst);
        }
        self.wake.notify_one();
    }

    /// What the browser is told: off, or on with the lists there are.
    fn call(&self, on: bool, allow: Vec<String>) -> Call {
        if !on {
            return Call::Adblock {
                on: false,
                lists: Vec::new(),
                updated: 0,
                allow: Vec::new(),
            };
        }
        let mut lists = Vec::new();
        let mut updated = 0i64;
        for list in LISTS {
            if let Some((at, _)) = self.on_disk(list) {
                lists.push(self.path(list).to_string_lossy().into_owned());
                updated = updated.max(ms(at));
            }
        }
        Call::Adblock {
            on: true,
            lists,
            updated,
            allow,
        }
    }

    /// Fetches every list, keeping the old copy of any that fails.
    async fn fetch(&self) {
        {
            let mut state = lock(&self.state);
            state.fetching = true;
            state.last_try = Some(Instant::now());
        }
        let _ = std::fs::create_dir_all(&self.dir);
        let mut error = None;
        for list in LISTS {
            if let Err(e) = self.fetch_one(list).await {
                error = Some(e);
            }
        }
        let mut state = lock(&self.state);
        state.fetching = false;
        state.error = error;
    }

    async fn fetch_one(&self, list: &FilterList) -> Result<(), String> {
        let body = crate::plugins::http_get(list.url, "text/plain", MAX_LIST_BYTES)
            .await
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8(body)
            .map_err(|_| format!("{} came back as something other than text", list.title))?;
        if !looks_like_a_list(&text) {
            return Err(format!(
                "{} came back as something other than a filter list (a network sign-in page?)",
                list.title
            ));
        }
        let path = self.path(list);
        let part = path.with_extension("txt.part");
        std::fs::write(&part, text.as_bytes()).map_err(|e| e.to_string())?;
        std::fs::rename(&part, &path).map_err(|e| e.to_string())
    }

    /// Whether a fetch may start now: the lists need one, none is running,
    /// and the last failure is an hour old (or the user just asked).
    fn may_fetch(&self) -> bool {
        let urgent = self.urgent.swap(false, Ordering::SeqCst);
        let state = lock(&self.state);
        !state.fetching
            && (urgent
                || state.error.is_none()
                || state.last_try.is_none_or(|at| at.elapsed() > RETRY_AFTER))
    }

    /// What Settings shows. `supported` is whether the browser here can
    /// block at all (the desktop app on Windows, for now).
    pub fn status(&self, store: &BrowserStore, supported: bool) -> Value {
        let on = is_on(store);
        let state = lock(&self.state);
        let mut newest: Option<i64> = None;
        let lists: Vec<Value> = LISTS
            .iter()
            .map(|list| {
                let disk = self.on_disk(list);
                if let Some((at, _)) = disk {
                    newest = newest.max(Some(ms(at)));
                }
                json!({
                    "id": list.id,
                    "title": list.title,
                    "url": list.url,
                    "updated": disk.map(|(at, _)| ms(at)),
                    "bytes": disk.map(|(_, size)| size),
                })
            })
            .collect();
        let stale = self.stale();
        // Blocking works from the lists that came with the app until
        // fresher ones are here, so "updating" and "error" are about the
        // lists, not about whether anything is blocked.
        let word = if !on {
            "off"
        } else if state.fetching || (stale && state.error.is_none()) {
            "updating"
        } else if stale {
            "error"
        } else {
            "on"
        };
        json!({
            "on": on,
            "supported": supported,
            "state": word,
            "error": state.error,
            "updated": newest,
            "lists": lists,
            "sites": store.adblock_sites(),
        })
    }
}

/// A filter list starts with its format line (`[Adblock Plus 2.0]`), which
/// a captive portal's page or an error page never does.
fn looks_like_a_list(text: &str) -> bool {
    text.trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("[Adblock")
}

fn ms(at: SystemTime) -> i64 {
    at.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Whether the browser here can block ads and trackers.
fn supported(service: &BrowserService) -> bool {
    lock(&service.link)
        .as_ref()
        .is_some_and(|link| link.caps.adblock)
}

/// Tells the browser, without waiting: whether there was a browser able
/// to hear it.
fn tell(service: &BrowserService, call: Call) -> bool {
    let send = lock(&service.link)
        .as_ref()
        .filter(|link| link.caps.adblock)
        .map(|link| link.send.clone());
    let Some(send) = send else {
        return false;
    };
    let id = service
        .next
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    send(ToHost { id, call });
    true
}

/// Tells the browser what blocking should be doing, if that changed (or
/// the browser asked to hear it all again).
fn inform(app: &App) {
    let keeper = &app.browser.adblock;
    let (on, allow) = {
        let store = lock(&app.browser.store);
        (is_on(&store), store.adblock_sites())
    };
    let call = keeper.call(on, allow);
    let resend = keeper.resend.swap(false, Ordering::SeqCst);
    let changed = lock(&keeper.state).told.as_ref() != Some(&call);
    if (resend || changed) && tell(&app.browser, call.clone()) {
        lock(&keeper.state).told = Some(call);
    } else if resend {
        // Nobody could hear it yet: ask again when a browser says hello.
        keeper.resend.store(true, Ordering::SeqCst);
    }
}

/// One look. The browser is told first - it blocks with the lists that
/// came with the app while fresher ones are fetched - and again when the
/// fetch changed what it should use.
async fn keep(app: &App) {
    let keeper = &app.browser.adblock;
    inform(app);
    let on = is_on(&lock(&app.browser.store));
    if on && keeper.stale() && keeper.may_fetch() {
        keeper.fetch().await;
        inform(app);
    }
}

/// Starts the keeper: it looks when woken and once an hour.
pub fn start(app: &Arc<App>) {
    let weak = Arc::downgrade(app);
    let wake = Arc::clone(&app.browser.adblock.wake);
    tokio::spawn(async move {
        loop {
            {
                let Some(app) = weak.upgrade() else {
                    return;
                };
                keep(&app).await;
            }
            tokio::select! {
                () = wake.notified() => {}
                () = tokio::time::sleep(TICK) => {}
            }
        }
    });
}

// ---- routes ----

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/browser/adblock", get(status).post(set_on))
        .route("/browser/adblock/site", post(set_site))
}

fn bad(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"error": message}))).into_response()
}

/// Whether blocking is on, the lists' state and the allowed sites.
async fn status(State(app): State<Arc<App>>) -> Response {
    let store = lock(&app.browser.store);
    Json(app.browser.adblock.status(&store, supported(&app.browser))).into_response()
}

#[derive(Deserialize)]
struct OnBody {
    on: bool,
}

/// Turns blocking on or off. Turning it on fetches the lists if they're
/// missing or old; the answer says "downloading" until they're in.
async fn set_on(State(app): State<Arc<App>>, Json(body): Json<OnBody>) -> Response {
    let keeper = &app.browser.adblock;
    {
        let mut store = lock(&app.browser.store);
        // Off is the default: it is stored as no value at all.
        store.set_setting(SETTING, if body.on { json!(true) } else { Value::Null });
    }
    keeper.changed(body.on);
    let store = lock(&app.browser.store);
    let mut status = keeper.status(&store, supported(&app.browser));
    if body.on && keeper.stale() {
        // The keeper is waking to fetch them: said now, so the switch
        // doesn't show an old error for a moment.
        status["state"] = json!("updating");
        status["error"] = Value::Null;
    }
    Json(status).into_response()
}

#[derive(Deserialize)]
struct SiteBody {
    site: String,
    allow: bool,
}

/// Allows ads on a site (`example.com`), or blocks them there again.
async fn set_site(State(app): State<Arc<App>>, Json(body): Json<SiteBody>) -> Response {
    let site = body.site.trim().trim_end_matches('.').to_ascii_lowercase();
    if !is_site(&site) {
        return bad("a site is a host name, like example.com");
    }
    {
        let mut store = lock(&app.browser.store);
        store.set_adblock_site(&site, body.allow);
    }
    app.browser.adblock.changed(false);
    let store = lock(&app.browser.store);
    Json(app.browser.adblock.status(&store, supported(&app.browser))).into_response()
}

/// A host name or address as the browser names a site: no scheme, path,
/// port or spaces.
fn is_site(site: &str) -> bool {
    !site.is_empty()
        && site.len() <= 253
        && site
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '[' | ']' | ':'))
        && !site.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_filter_list_counts_as_one() {
        assert!(looks_like_a_list(
            "[Adblock Plus 2.0]\n! Title: EasyList\n||ads.example^\n"
        ));
        assert!(looks_like_a_list("\u{feff}[Adblock Plus 1.1]\n"));
        assert!(!looks_like_a_list("<!doctype html><title>Sign in</title>"));
        assert!(!looks_like_a_list(""));
    }

    #[test]
    fn off_tells_the_browser_nothing_but_off() {
        let dir = tempfile::tempdir().unwrap();
        let keeper = Keeper::new(dir.path());
        assert_eq!(
            keeper.call(false, vec!["example.com".into()]),
            Call::Adblock {
                on: false,
                lists: vec![],
                updated: 0,
                allow: vec![]
            }
        );
        // On with no lists yet: the browser waits for them.
        assert!(keeper.stale());
        std::fs::create_dir_all(dir.path().join("browser").join("filters")).unwrap();
        for list in LISTS {
            std::fs::write(keeper.path(list), "[Adblock Plus 2.0]\n").unwrap();
        }
        assert!(!keeper.stale());
        let Call::Adblock {
            on, lists, allow, ..
        } = keeper.call(true, vec!["a.test".into()])
        else {
            unreachable!()
        };
        assert!(on);
        assert_eq!(lists.len(), LISTS.len());
        assert_eq!(allow, vec!["a.test".to_string()]);
    }

    #[test]
    fn sites_are_host_names() {
        assert!(is_site("example.com"));
        assert!(is_site("192.168.1.20"));
        assert!(is_site("localhost"));
        assert!(!is_site("https://example.com/"));
        assert!(!is_site("exa mple.com"));
        assert!(!is_site(""));
    }
}
