//! The WebView2 half of ad and tracker blocking: the engine, and what a
//! tab's hooks do with each request and each page. It knows nothing of
//! Tauri (the glue in `adblock.rs` ties it to the app's tabs), so it can
//! run against a bare WebView2.
//!
//! Off, nothing here runs: no filter is registered with any tab, so no
//! request is ever held up to be looked at, and the filter engine is not
//! even built. On, each hooked tab hands every request to Brave's filter
//! engine (the `adblock` crate) running EasyList and EasyPrivacy, and
//! answers the ones the lists name with an empty response, so the page
//! simply never receives them. The lists' cosmetic rules ride along where
//! they are cheap: the page's own hide rules go in as it starts, and the
//! class and id rules once it has loaded.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;
use url::Url;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2Environment,
    ICoreWebView2NavigationStartingEventArgs, ICoreWebView2WebResourceRequestedEventArgs,
    ICoreWebView2_2, COREWEBVIEW2_WEB_RESOURCE_CONTEXT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
};
use webview2_com::{
    take_pwstr, DOMContentLoadedEventHandler, ExecuteScriptCompletedHandler,
    NavigationStartingEventHandler, WebResourceRequestedEventHandler,
};
use windows::core::{w, Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};

/// Where a tab's count of blocked requests goes (the app tells the
/// console).
pub trait Sink: Clone + Send + Sync + 'static {
    /// How many requests the tab's page has had blocked; 0 when a new
    /// page starts.
    fn blocked(&self, tab: &str, count: u32);
}

/// The lists that ship with the app: EasyList and EasyPrivacy as their
/// publishers had them when this build was made (`scripts/update-filter-
/// lists.mjs`), brotli-compressed. Used until the daemon has fetched fresh
/// copies, and whenever a fresh copy turns out unreadable.
const BUNDLED: [(&str, &[u8]); 2] = [
    (
        "easylist",
        include_bytes!("../../../filters/easylist.txt.br"),
    ),
    (
        "easyprivacy",
        include_bytes!("../../../filters/easyprivacy.txt.br"),
    ),
];

/// The console is told of a page's count at most this often.
const TELL_EVERY: Duration = Duration::from_millis(250);

/// A blocked image is answered with this, so the page shows nothing
/// where an advert was instead of a broken-picture mark: a transparent
/// 1x1 GIF.
const PIXEL: [u8; 43] = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
];

/// The engine and the sites it leaves alone, while blocking is on.
struct Active {
    engine: Arc<Engine>,
    /// The lists' files and their stamp the engine was built from.
    source: (Vec<String>, i64),
    /// Sites the user allows ads on, lower case.
    allow: Arc<Vec<String>>,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

/// What a tab's hooks are called back by, to take them off again.
#[derive(Clone, Copy, Debug)]
pub struct Hooks {
    requested: i64,
    navigating: i64,
    loaded: i64,
}

/// What each tab's current page is doing.
#[derive(Default)]
struct Page {
    /// Requests blocked since the page started loading.
    blocked: u32,
    /// A count is waiting to be sent.
    pending: bool,
    /// The address the tab is navigating to: its main document's request,
    /// which is never blocked.
    document: Option<String>,
    /// Cosmetic exceptions for the page's address, for the class and id
    /// rules that come once it has loaded.
    exceptions: HashSet<String>,
    generichide: bool,
}

static PAGES: Mutex<Option<HashMap<String, Page>>> = Mutex::new(None);

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn active() -> Option<(Arc<Engine>, Arc<Vec<String>>)> {
    locked(&ACTIVE)
        .as_ref()
        .map(|a| (Arc::clone(&a.engine), Arc::clone(&a.allow)))
}

// ---- the engine ----

/// Whether blocking is on.
pub fn is_on() -> bool {
    locked(&ACTIVE).is_some()
}

/// Blocking is on, with this engine (built from `source`) and these
/// allowed sites.
pub fn start(engine: Arc<Engine>, source: (Vec<String>, i64), allow: Vec<String>) {
    *locked(&ACTIVE) = Some(Active {
        engine,
        source,
        allow: Arc::new(sites(allow)),
    });
}

/// The allowed sites changed. True when the engine in use was already
/// built from `source`, so nothing needs rebuilding.
pub fn update(allow: Vec<String>, source: &(Vec<String>, i64)) -> bool {
    match locked(&ACTIVE).as_mut() {
        Some(now) => {
            now.allow = Arc::new(sites(allow));
            now.source == *source
        }
        None => false,
    }
}

/// Blocking is off: the engine is dropped and no page is remembered.
pub fn stop() {
    *locked(&ACTIVE) = None;
    locked(&PAGES).take();
}

/// A tab is gone.
pub fn forget(tab: &str) {
    if let Some(pages) = locked(&PAGES).as_mut() {
        pages.remove(tab);
    }
}

/// The engine for the lists: each one from the fresh file the daemon
/// kept when that reads as a list, else from the copy that came with the
/// app.
pub fn build(files: &[String]) -> Engine {
    let mut set = FilterSet::new(false);
    for (id, packed) in BUNDLED {
        let fresh = files
            .iter()
            .filter(|path| {
                std::path::Path::new(path)
                    .file_stem()
                    .is_some_and(|stem| stem == id)
            })
            .find_map(|path| std::fs::read_to_string(path).ok())
            .filter(|text| text.trim_start_matches('\u{feff}').starts_with("[Adblock"));
        let text = fresh.or_else(|| unpack(packed));
        if let Some(text) = text {
            set.add_filter_list(text, ParseOptions::default());
        }
    }
    Engine::new_with_filter_set(set)
}

fn unpack(packed: &[u8]) -> Option<String> {
    let mut out = Vec::with_capacity(packed.len() * 8);
    brotli_decompressor::BrotliDecompress(&mut &packed[..], &mut out).ok()?;
    String::from_utf8(out).ok()
}

/// The user's allowed sites as the page matching wants them.
fn sites(raw: Vec<String>) -> Vec<String> {
    raw.into_iter()
        .map(|s| s.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

// ---- hooking a tab ----

/// Hook a tab's page: its requests, its navigations and its loads.
///
/// # Safety
/// Call on the window's thread; the controller and environment are the
/// tab's own.
pub unsafe fn hook<S: Sink>(
    sink: &S,
    tab: &str,
    controller: &ICoreWebView2Controller,
    env: &ICoreWebView2Environment,
) -> Option<Hooks> {
    let core = controller.CoreWebView2().ok()?;
    let mut hooks = Hooks {
        requested: 0,
        navigating: 0,
        loaded: 0,
    };

    let (s, t, e) = (sink.clone(), tab.to_string(), env.clone());
    let requested = WebResourceRequestedEventHandler::create(Box::new(move |core, args| {
        if let (Some(core), Some(args)) = (core, args) {
            // Whatever goes wrong, the request goes through: a page that
            // loads with an advert is better than one that doesn't load.
            let _ = on_request(&s, &t, &e, &core, &args);
        }
        Ok(())
    }));
    if core
        .add_WebResourceRequested(&requested, &mut hooks.requested)
        .is_err()
        || core
            .AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
            .is_err()
    {
        let _ = core.remove_WebResourceRequested(hooks.requested);
        return None;
    }

    let (s, t) = (sink.clone(), tab.to_string());
    let navigating = NavigationStartingEventHandler::create(Box::new(move |core, args| {
        if let (Some(core), Some(args)) = (core, args) {
            let _ = on_navigation(&s, &t, &core, &args);
        }
        Ok(())
    }));
    let _ = core.add_NavigationStarting(&navigating, &mut hooks.navigating);

    if let Ok(core2) = core.cast::<ICoreWebView2_2>() {
        let t = tab.to_string();
        let loaded = DOMContentLoadedEventHandler::create(Box::new(move |core, _| {
            if let Some(core) = core {
                let _ = on_loaded(&t, &core);
            }
            Ok(())
        }));
        let _ = core2.add_DOMContentLoaded(&loaded, &mut hooks.loaded);
    }
    Some(hooks)
}

/// Take a tab's hooks off again.
///
/// # Safety
/// Call on the window's thread.
pub unsafe fn unhook(controller: &ICoreWebView2Controller, hooks: Hooks) {
    if let Ok(core) = controller.CoreWebView2() {
        let _ = core.RemoveWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
        let _ = core.remove_WebResourceRequested(hooks.requested);
        let _ = core.remove_NavigationStarting(hooks.navigating);
        if let Ok(core2) = core.cast::<ICoreWebView2_2>() {
            let _ = core2.remove_DOMContentLoaded(hooks.loaded);
        }
    }
}

// ---- requests ----

/// What the lists call a request of this kind (a tab's own page never
/// gets here, so a document is a frame in it).
fn kind_of(context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
    match context {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "sub_frame",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST
        | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "xhr",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT => "csp_report",
        _ => "other",
    }
}

/// An address's host, and whether it names this computer or its network:
/// the user's own dev servers and devices are never filtered.
fn host_of(address: &str) -> Option<(String, bool)> {
    let url = Url::parse(address).ok()?;
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let local = match bare.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local(),
        Err(_) => host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local"),
    };
    Some((host, local))
}

/// Whether two addresses are one document: the same but for a fragment
/// and for how a bare host is written.
fn same_document(a: &str, b: &str) -> bool {
    match (Url::parse(a), Url::parse(b)) {
        (Ok(mut a), Ok(mut b)) => {
            a.set_fragment(None);
            b.set_fragment(None);
            a == b
        }
        _ => a == b,
    }
}

/// Whether `host` is one of the allowed sites or below one.
fn site_allowed(allow: &[String], host: &str) -> bool {
    allow.iter().any(|site| {
        host == site
            || host
                .strip_suffix(site.as_str())
                .is_some_and(|rest| rest.ends_with('.'))
    })
}

/// A small empty stand-in for a blocked request.
fn stand_in(context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> (&'static str, &'static [u8]) {
    match context {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => ("image/gif", &PIXEL),
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => ("application/javascript", &[]),
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => ("text/css", &[]),
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => ("text/html", &[]),
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => ("font/woff2", &[]),
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => ("video/mp4", &[]),
        _ => ("text/plain", &[]),
    }
}

/// A stream holding `bytes`, for a response body (none for no bytes).
///
/// # Safety
/// Call on a thread COM is set up on.
unsafe fn memory_stream(bytes: &[u8]) -> Option<IStream> {
    if bytes.is_empty() {
        return None;
    }
    let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true).ok()?;
    stream
        .Write(bytes.as_ptr().cast(), bytes.len() as u32, None)
        .ok()
        .ok()?;
    stream.Seek(0, STREAM_SEEK_SET, None).ok()?;
    Some(stream)
}

/// Look at one request; answer it with nothing when the lists say so.
///
/// # Safety
/// Call on the window's thread, from the request's event.
unsafe fn on_request<S: Sink>(
    sink: &S,
    tab: &str,
    env: &ICoreWebView2Environment,
    core: &ICoreWebView2,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
) -> windows::core::Result<()> {
    let Some((engine, allow)) = active() else {
        return Ok(());
    };
    let request = args.Request()?;
    let mut text = PWSTR::null();
    request.Uri(&mut text)?;
    let url = take_pwstr(text);
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Ok(());
    }
    let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
    args.ResourceContext(&mut context)?;

    // What the page asking is: the top-level page the tab shows.
    text = PWSTR::null();
    core.Source(&mut text)?;
    let page = take_pwstr(text);
    let (page_host, page_local) = host_of(&page).unwrap_or_default();
    if page_local || site_allowed(&allow, &page_host) {
        return Ok(());
    }
    // Nothing is filtered on the user's own machine or network, in either
    // direction.
    let Some((_, false)) = host_of(&url) else {
        return Ok(());
    };

    // A tab's own page is never blocked, only what it asks for. A document
    // request that is the address the tab is going to, or is showing, is
    // that page; any other is a frame in it.
    if context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT {
        let going = locked(&PAGES)
            .as_ref()
            .and_then(|pages| pages.get(tab))
            .and_then(|page| page.document.clone());
        let is_page = same_document(&url, &page)
            || going
                .as_deref()
                .is_none_or(|going| same_document(&url, going));
        if is_page {
            return Ok(());
        }
    }

    text = PWSTR::null();
    request.Method(&mut text)?;
    let method = take_pwstr(text);
    let kind = kind_of(context);
    let source = if page.is_empty() { url.as_str() } else { &page };
    let blocked = catch_unwind(AssertUnwindSafe(|| {
        Request::new(&url, source, kind, &method)
            .map(|request| engine.check_network_request(&request).should_block())
            .unwrap_or(false)
    }))
    .unwrap_or(false);
    if !blocked {
        return Ok(());
    }

    let (mime, body) = stand_in(context);
    let stream = memory_stream(body);
    let response = env.CreateWebResourceResponse(
        stream.as_ref(),
        200,
        w!("Blocked"),
        &HSTRING::from(format!(
            "Content-Type: {mime}\r\nCache-Control: no-store\r\nX-Blocked-By: OpenRemote"
        )),
    )?;
    args.SetResponse(&response)?;
    count(sink, tab);
    Ok(())
}

/// One more request blocked on a tab's page: the sink hears the total
/// soon (at most every quarter second, however many a page blocks).
fn count<S: Sink>(sink: &S, tab: &str) {
    let first = {
        let mut guard = locked(&PAGES);
        let page = guard
            .get_or_insert_with(HashMap::new)
            .entry(tab.to_string())
            .or_default();
        page.blocked += 1;
        !std::mem::replace(&mut page.pending, true)
    };
    if !first {
        return;
    }
    let (sink, tab) = (sink.clone(), tab.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(TELL_EVERY);
        let count = {
            let mut guard = locked(&PAGES);
            guard
                .as_mut()
                .and_then(|pages| pages.get_mut(&tab))
                .map(|page| {
                    page.pending = false;
                    page.blocked
                })
        };
        if let Some(count) = count {
            sink.blocked(&tab, count);
        }
    });
}

// ---- pages ----

/// Run a script in the tab's page; its result, as JSON, goes to `then`
/// (on the window's thread).
///
/// # Safety
/// Call on the window's thread.
unsafe fn run(
    core: &ICoreWebView2,
    script: &str,
    then: impl FnOnce(String) + 'static,
) -> windows::core::Result<()> {
    let mut then = Some(then);
    let done = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
        if result.is_ok() {
            if let Some(then) = then.take() {
                then(json);
            }
        }
        Ok(())
    }));
    core.ExecuteScript(&HSTRING::from(script), &done)
}

/// A script that hides these selectors in the page: one rule each, so a
/// selector the engine can't parse costs only itself.
fn hide_script(selectors: &[String]) -> Option<String> {
    let usable: Vec<&String> = selectors
        .iter()
        .filter(|s| !s.is_empty() && s.len() < 1000 && !s.contains(['{', '}']))
        .collect();
    if usable.is_empty() {
        return None;
    }
    let list = serde_json::to_string(&usable).ok()?;
    Some(format!(
        "(()=>{{try{{const s=new CSSStyleSheet();for(const r of {list}){{try{{s.insertRule(r+'{{display:none!important}}')}}catch(e){{}}}}document.adoptedStyleSheets=[...document.adoptedStyleSheets,s]}}catch(e){{}}}})()"
    ))
}

/// The classes and ids a page uses, for the lists' class and id rules.
const COLLECT: &str = "(()=>{const c=new Set(),i=new Set();for(const e of document.querySelectorAll('[class],[id]')){for(const k of e.classList)c.add(k);if(e.id)i.add(e.id)}return[[...c],[...i]]})()";

/// A main-frame navigation began: the page's count starts again, and the
/// lists' hide rules for its address are put in as the new document opens.
///
/// # Safety
/// Call on the window's thread, from the navigation's event.
unsafe fn on_navigation<S: Sink>(
    sink: &S,
    tab: &str,
    core: &ICoreWebView2,
    args: &ICoreWebView2NavigationStartingEventArgs,
) -> windows::core::Result<()> {
    let mut text = PWSTR::null();
    args.Uri(&mut text)?;
    let uri = take_pwstr(text);
    let mut redirected = BOOL::default();
    args.IsRedirected(&mut redirected)?;
    let told = {
        let mut guard = locked(&PAGES);
        let page = guard
            .get_or_insert_with(HashMap::new)
            .entry(tab.to_string())
            .or_default();
        let had = page.blocked;
        if !redirected.as_bool() {
            page.blocked = 0;
        }
        page.document = Some(uri.clone());
        page.exceptions.clear();
        page.generichide = false;
        had != 0 && !redirected.as_bool()
    };
    if told {
        sink.blocked(tab, 0);
    }

    let Some((engine, allow)) = active() else {
        return Ok(());
    };
    let Some((host, local)) = host_of(&uri) else {
        return Ok(());
    };
    if local || site_allowed(&allow, &host) || !uri.starts_with("http") {
        return Ok(());
    }
    let Ok(found) = catch_unwind(AssertUnwindSafe(|| engine.url_cosmetic_resources(&uri))) else {
        return Ok(());
    };
    {
        let mut guard = locked(&PAGES);
        if let Some(page) = guard.as_mut().and_then(|pages| pages.get_mut(tab)) {
            page.exceptions = found.exceptions;
            page.generichide = found.generichide;
        }
    }
    let selectors: Vec<String> = found.hide_selectors.into_iter().collect();
    if let Some(script) = hide_script(&selectors) {
        // Run after NavigationStarting, a script runs in the document
        // being opened, as it loads.
        run(core, &script, |_| {})?;
    }
    Ok(())
}

/// A page finished parsing: the class and id rules for what it uses.
///
/// # Safety
/// Call on the window's thread, from the page's event.
unsafe fn on_loaded(tab: &str, core: &ICoreWebView2) -> windows::core::Result<()> {
    let Some((engine, allow)) = active() else {
        return Ok(());
    };
    let mut text = PWSTR::null();
    core.Source(&mut text)?;
    let page = take_pwstr(text);
    let Some((host, local)) = host_of(&page) else {
        return Ok(());
    };
    if local || site_allowed(&allow, &host) || !page.starts_with("http") {
        return Ok(());
    }
    let (exceptions, generichide) = match locked(&PAGES).as_ref().and_then(|pages| pages.get(tab)) {
        Some(page) => (page.exceptions.clone(), page.generichide),
        None => return Ok(()),
    };
    if generichide {
        return Ok(());
    }
    let injector = core.clone();
    run(core, COLLECT, move |json| {
        let Ok((classes, ids)) = serde_json::from_str::<(Vec<String>, Vec<String>)>(&json) else {
            return;
        };
        let Ok(selectors) = catch_unwind(AssertUnwindSafe(|| {
            engine.hidden_class_id_selectors(&classes, &ids, &exceptions)
        })) else {
            return;
        };
        if let Some(script) = hide_script(&selectors) {
            // SAFETY: still on the window's thread, where this runs.
            let _ = unsafe { run(&injector, &script, |_| {}) };
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_allows_its_own_pages_and_the_ones_below_it() {
        let allow = sites(vec!["Example.com".into(), "shop.test.".into()]);
        assert!(site_allowed(&allow, "example.com"));
        assert!(site_allowed(&allow, "news.example.com"));
        assert!(site_allowed(&allow, "a.b.shop.test"));
        assert!(!site_allowed(&allow, "notexample.com"));
        assert!(!site_allowed(&allow, "example.com.evil.test"));
        assert!(!site_allowed(&[], "example.com"));
    }

    #[test]
    fn the_users_own_machine_and_network_are_never_filtered() {
        for local in [
            "http://localhost:3000/",
            "http://app.localhost/",
            "http://127.0.0.1:5175/",
            "http://192.168.1.20/",
            "http://10.0.0.5/",
            "http://[::1]:8080/",
            "http://printer.local/",
        ] {
            assert!(host_of(local).unwrap().1, "{local} is local");
        }
        for web in ["https://example.com/", "http://93.184.216.34/"] {
            assert!(!host_of(web).unwrap().1, "{web} is the web");
        }
    }

    #[test]
    fn hide_rules_go_in_one_at_a_time_and_cannot_close_their_own_rule() {
        let script = hide_script(&[
            ".ad-banner".into(),
            "a{color:red}".into(),
            "".into(),
            "#sponsor".into(),
        ])
        .unwrap();
        assert!(script.contains(r##"[".ad-banner","#sponsor"]"##));
        assert!(!script.contains("color:red"));
        assert!(hide_script(&[]).is_none());
    }

    #[test]
    fn a_page_is_one_document_whatever_follows_its_hash() {
        assert!(same_document("https://a.test", "https://a.test/#top"));
        assert!(same_document("https://a.test/x?y=1#a", "https://a.test/x?y=1"));
        assert!(!same_document("https://a.test/x", "https://a.test/y"));
    }

    #[test]
    fn what_ships_with_the_app_is_two_filter_lists() {
        for (id, packed) in BUNDLED {
            let text = unpack(packed).unwrap_or_else(|| panic!("{id} unpacks"));
            assert!(text.starts_with("[Adblock"), "{id} is a filter list");
            assert!(text.len() > 100_000, "{id} is more than a stub");
        }
    }

    #[test]
    fn the_lists_block_an_advert_and_leave_a_page_alone() {
        let engine = build(&[]);
        let check = |url: &str, page: &str, kind: &str| {
            engine
                .check_network_request(&Request::new(url, page, kind, "GET").unwrap())
                .should_block()
        };
        assert!(check(
            "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
            "https://www.bbc.co.uk/news",
            "script"
        ));
        assert!(check(
            "https://www.google-analytics.com/analytics.js",
            "https://www.example.com/",
            "script"
        ));
        assert!(!check(
            "https://www.bbc.co.uk/news/app.js",
            "https://www.bbc.co.uk/news",
            "script"
        ));
    }
}
