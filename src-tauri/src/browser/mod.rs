//! The built-in browser's engine on the desktop. Each tab is a native
//! webview (WebView2 on Windows, WebKit on macOS and Linux) laid over a
//! placeholder the console draws, in a profile folder of its own, so web
//! pages never share storage with the console. The console owns the
//! browser's chrome (tab strip, address bar, menus); the shell owns the
//! pages and tells the console what they do through `browser:*` events.
//!
//! Tabs are webviews in the console's own window, so two rules keep them
//! away from the app: the app's commands answer only the console's webview
//! (the ACL in build.rs and capabilities/default.json), and a tab never
//! loads the app's own addresses (`allowed`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, State, Url, Webview,
    WebviewUrl,
};

#[cfg(all(windows, debug_assertions))]
pub mod selftest;
#[cfg(windows)]
mod win;

/// The console's webview: the only one that hears the browser's events.
const CONSOLE: &str = "main";

static DOWNLOADS: AtomicU64 = AtomicU64::new(0);

/// The tabs this window holds, by id.
#[derive(Default)]
pub struct Browser {
    next: AtomicU64,
    tabs: Mutex<HashMap<String, Tab>>,
}

/// What the console is told about a tab.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Tab {
    pub id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    /// The page's icon as a data URL (the console shows no remote images).
    pub favicon: Option<String>,
    pub can_back: bool,
    pub can_forward: bool,
    /// The tab that opened this one (a link with target=_blank or
    /// window.open), so the console can place it beside its opener.
    pub opener: Option<String>,
    #[serde(skip)]
    bounds: Option<Bounds>,
}

/// A download a tab asked for, as the console lists it.
#[derive(Clone, Debug, Serialize)]
pub struct Download {
    pub id: u64,
    pub tab: String,
    pub url: String,
    pub path: Option<String>,
    /// "blocked" (a page asked and was refused), "started", "done" or
    /// "failed".
    pub state: &'static str,
}

/// Where the console's placeholder sits, in CSS pixels. The console's
/// webview fills the window from its top-left corner, so CSS pixels are
/// the window's logical pixels and Tauri scales them for the display.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A browser key pressed while a page had focus: the page never sees it
/// and the console acts on it (`Mod+T`, the app's own `Mod+K`...).
#[derive(Clone, Debug, Serialize)]
pub struct KeyPress {
    pub tab: String,
    pub chord: String,
}

/// Whether a tab may load this address. The console is served from
/// `tauri.localhost` (and in development from the dev server), and Tauri
/// answers its IPC and asset schemes on other `*.localhost` names in every
/// webview of the app, so those stay out of reach. Plain `localhost` and
/// 127.0.0.1 stay open: they are the user's own dev servers.
pub fn allowed(url: &Url, dev: Option<&Url>) -> bool {
    match url.scheme() {
        "http" | "https" => {
            let host = url.host_str().unwrap_or("").trim_end_matches('.');
            if host.ends_with(".localhost") {
                return false;
            }
            !dev.is_some_and(|dev| dev.origin() == url.origin())
        }
        "about" | "blob" | "data" | "file" => true,
        _ => false,
    }
}

/// Whether a page may start a download on its own. It may not. Tauri
/// reports a download as it arrives and takes the handler's answer as
/// allow-or-refuse, so there is no way to hold it and ask the user first:
/// every allowed download is a file written where the user keeps their
/// own, with nothing on screen to say a page put it there. The console
/// lists the attempt instead, and the user who wants the file asks for it
/// in a browser that prompts.
fn page_may_download() -> bool {
    false
}

/// The browser's profile: cookies, storage and cache live here, apart
/// from the console's own.
fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // A test run points the profile somewhere disposable.
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("OPENREMOTE_BROWSER_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("browser").join("profile"))
}

fn console() -> EventTarget {
    EventTarget::Webview {
        label: CONSOLE.into(),
    }
}

fn tab(app: &AppHandle, id: &str) -> Result<Webview, String> {
    app.get_webview(id)
        .filter(|_| id.starts_with("tab-"))
        .ok_or_else(|| format!("no tab {id}"))
}

/// Change what the shell knows about a tab and tell the console.
fn update(app: &AppHandle, id: &str, change: impl FnOnce(&mut Tab)) {
    let browser = app.state::<Browser>();
    let snapshot = {
        let mut tabs = browser.tabs.lock().expect("browser lock");
        let Some(tab) = tabs.get_mut(id) else {
            return;
        };
        change(tab);
        tab.clone()
    };
    let _ = app.emit_to(console(), "browser:tab", snapshot);
}

/// Open a tab. It blocks until the window's thread has built the webview
/// (Tauri's add_child waits on it), so it must never run on that thread:
/// commands call it from the async runtime, and a page's popup from the
/// blocking pool.
pub fn open_tab(
    app: AppHandle,
    url: Url,
    bounds: Bounds,
    show: bool,
    opener: Option<String>,
) -> Result<String, String> {
    if !allowed(&url, app.config().build.dev_url.as_ref()) {
        return Err(format!("{url} can't be opened here"));
    }
    let browser = app.state::<Browser>();
    let id = format!("tab-{}", browser.next.fetch_add(1, Ordering::Relaxed) + 1);
    let window = app.get_window(CONSOLE).ok_or("the window is gone")?;
    let dev = app.config().build.dev_url.clone();
    let (on_load, on_title, on_popup, on_download) =
        (app.clone(), app.clone(), app.clone(), app.clone());
    // Downloads are told apart by their address, which is all the finish
    // event carries; the newest started one with that address finishes.
    // Nothing starts today (see on_download), so this pairs nothing until a
    // build allows a download the user asked for.
    let started: std::sync::Arc<Mutex<Vec<(String, u64)>>> = Default::default();
    let popup_from = id.clone();
    let builder = WebviewBuilder::new(&id, WebviewUrl::External(url.clone()))
        .data_directory(profile_dir(&app)?)
        .on_navigation(move |to| allowed(to, dev.as_ref()))
        .on_page_load(move |webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            let url = payload.url().to_string();
            update(&on_load, webview.label(), |tab| {
                tab.loading = loading;
                tab.url = url;
            });
        })
        .on_document_title_changed(move |webview, title| {
            update(&on_title, webview.label(), |tab| tab.title = title);
        })
        // A page asking for a new window gets a tab instead. The page stays
        // hidden until the console says it has the tab: a pane that closed
        // while the page was being built must not leave it drawn over the
        // console with no tab strip to close it.
        .on_new_window(move |url, _features| {
            let app = on_popup.clone();
            let opener = popup_from.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let bounds = app
                    .state::<Browser>()
                    .tabs
                    .lock()
                    .expect("browser lock")
                    .get(&opener)
                    .and_then(|tab| tab.bounds);
                if let Some(bounds) = bounds {
                    let _ = open_tab(app, url, bounds, false, Some(opener));
                }
            });
            NewWindowResponse::Deny
        })
        // A page never writes a file on its own. Above where WebView2 would
        // put it (the user's Downloads folder, a free name) and behind Edge's
        // own bubble, a download the page starts is a file the user never
        // agreed to; the event can only be allowed or refused as it arrives,
        // so there is no way to hold it and ask the user first. It is
        // refused, and the console is told what the page tried to save.
        .on_download(move |webview, event| {
            let download = match event {
                DownloadEvent::Requested { url, destination } => Download {
                    id: DOWNLOADS.fetch_add(1, Ordering::Relaxed) + 1,
                    tab: webview.label().to_string(),
                    url: url.to_string(),
                    path: Some(destination.display().to_string()),
                    state: "blocked",
                },
                DownloadEvent::Finished { url, path, success } => {
                    let url = url.to_string();
                    let id = {
                        let mut started = started.lock().expect("downloads lock");
                        let at = started.iter().rposition(|(u, _)| *u == url);
                        at.map(|at| started.remove(at).1).unwrap_or_default()
                    };
                    Download {
                        id,
                        tab: webview.label().to_string(),
                        url,
                        path: path.map(|p| p.display().to_string()),
                        state: if success { "done" } else { "failed" },
                    }
                }
                _ => return true,
            };
            let _ = on_download.emit_to(console(), "browser:download", download);
            page_may_download()
        });
    #[cfg(windows)]
    let builder = builder.additional_browser_args(win::BROWSER_ARGS);
    browser.tabs.lock().expect("browser lock").insert(
        id.clone(),
        Tab {
            id: id.clone(),
            url: url.to_string(),
            loading: true,
            opener: opener.clone(),
            bounds: Some(bounds),
            ..Tab::default()
        },
    );
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| {
            browser.tabs.lock().expect("browser lock").remove(&id);
            e.to_string()
        })?;
    if !show {
        let _ = webview.hide();
    }
    #[cfg(windows)]
    win::attach(&app, &webview);
    update(&app, &id, |_| {});
    Ok(id)
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    url: String,
    bounds: Bounds,
    show: bool,
) -> Result<String, String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    open_tab(app, url, bounds, show, None)
}

/// What this build's shell can actually do with a tab. Find, the DevTools
/// bridge (element picking and screenshots), device view and forgetting a
/// site are written against WebView2, so every other build answers false
/// and the console keeps those controls off its chrome instead of drawing
/// buttons that fail silently.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub find: bool,
    /// Screenshots and the DevTools protocol: element picking.
    pub cdp: bool,
    /// Device view, which drives the page's emulation over the bridge.
    pub viewport: bool,
    pub clear_site: bool,
}

#[tauri::command]
pub fn browser_features() -> Features {
    #[cfg(windows)]
    return Features {
        find: true,
        cdp: true,
        viewport: true,
        clear_site: true,
    };
    #[cfg(not(windows))]
    Features {
        find: false,
        cdp: false,
        viewport: false,
        clear_site: false,
    }
}

/// The tabs the shell holds, oldest first: a console that reloaded takes
/// them back instead of leaving them on screen, orphaned.
#[tauri::command]
pub fn browser_tabs(browser: State<'_, Browser>) -> Vec<Tab> {
    let mut tabs: Vec<Tab> = browser
        .tabs
        .lock()
        .expect("browser lock")
        .values()
        .cloned()
        .collect();
    tabs.sort_by_key(|t| t.id.trim_start_matches("tab-").parse::<u64>().unwrap_or(0));
    tabs
}

#[tauri::command]
pub fn browser_close(
    app: AppHandle,
    browser: State<'_, Browser>,
    tab: String,
) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    browser.tabs.lock().expect("browser lock").remove(&tab);
    webview.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_bounds(app: AppHandle, tab: String, bounds: Bounds) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    if let Some(known) = app
        .state::<Browser>()
        .tabs
        .lock()
        .expect("browser lock")
        .get_mut(&tab)
    {
        known.bounds = Some(bounds);
    }
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_show(app: AppHandle, tab: String, focus: bool) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    webview.show().map_err(|e| e.to_string())?;
    if focus {
        let _ = webview.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn browser_hide(app: AppHandle, tab: String) -> Result<(), String> {
    self::tab(&app, &tab)?.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, tab: String, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    if !allowed(&url, app.config().build.dev_url.as_ref()) {
        return Err(format!("{url} can't be opened here"));
    }
    self::tab(&app, &tab)?
        .navigate(url)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_back(app: AppHandle, tab: String) -> Result<(), String> {
    history(&self::tab(&app, &tab)?, -1)
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, tab: String) -> Result<(), String> {
    history(&self::tab(&app, &tab)?, 1)
}

fn history(webview: &Webview, step: i32) -> Result<(), String> {
    #[cfg(windows)]
    return win::history(webview, step);
    #[cfg(not(windows))]
    webview
        .eval(format!("history.go({step})"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, tab: String) -> Result<(), String> {
    self::tab(&app, &tab)?.reload().map_err(|e| e.to_string())
}

/// A picture of the tab as it is now, as a data URL: the console shows it
/// in the tab's place while one of its own menus or dialogs covers the
/// page (a native webview always draws above the console's HTML).
#[tauri::command]
pub async fn browser_capture(app: AppHandle, tab: String) -> Result<String, String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    {
        let shot = win::cdp(
            &webview,
            "Page.captureScreenshot",
            serde_json::json!({ "format": "jpeg", "quality": 80 }),
        )
        .await?;
        let data = shot["data"].as_str().ok_or("no picture came back")?;
        Ok(format!("data:image/jpeg;base64,{data}"))
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Err("not on this platform yet".into())
    }
}

/// One DevTools protocol call on a tab, in-process: no debugging port is
/// ever opened, so nothing else on the machine can attach to the browser.
#[tauri::command]
pub async fn browser_cdp(
    app: AppHandle,
    tab: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    return win::cdp(&webview, &method, params).await;
    #[cfg(not(windows))]
    {
        let _ = (webview, method, params);
        Err("not on this platform yet".into())
    }
}

/// Stop loading the page.
#[tauri::command]
pub fn browser_stop(app: AppHandle, tab: String) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    return win::stop(&webview);
    #[cfg(not(windows))]
    webview.eval("window.stop()").map_err(|e| e.to_string())
}

/// The page's zoom, 1.0 being 100%.
#[tauri::command]
pub fn browser_zoom(app: AppHandle, tab: String, factor: f64) -> Result<(), String> {
    self::tab(&app, &tab)?
        .set_zoom(factor.clamp(0.25, 5.0))
        .map_err(|e| e.to_string())
}

/// Find in page: a term to look for (and step through with `step`, 1 or
/// -1), the matches arriving as `browser:find` events. An empty term ends
/// the search.
#[tauri::command]
pub fn browser_find(app: AppHandle, tab: String, term: String, step: i32) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    return win::find(&app, &webview, term, step);
    #[cfg(not(windows))]
    {
        let _ = (app, webview, term, step);
        Err("not on this platform yet".into())
    }
}

#[tauri::command]
pub fn browser_print(app: AppHandle, tab: String) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    return win::print(&webview);
    #[cfg(not(windows))]
    webview.print().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_devtools(app: AppHandle, tab: String) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    // Release builds gain DevTools with the browser's first release; the
    // console only offers the item in development until then.
    #[cfg(debug_assertions)]
    {
        webview.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = webview;
        Err("DevTools aren't in this build yet".into())
    }
}

/// Show the page as another screen shows it: a phone's or any width and
/// height, drawn at `scale` when the space is smaller than the screen, and
/// for a phone with touch and a phone's user agent (what the browser's
/// own developer tools do). No size: the tab's own size again.
#[tauri::command]
pub async fn browser_viewport(
    app: AppHandle,
    tab: String,
    width: Option<u32>,
    height: Option<u32>,
    mobile: bool,
    scale: Option<f64>,
) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    {
        let Some((w, h)) = width.zip(height) else {
            win::cdp(
                &webview,
                "Emulation.clearDeviceMetricsOverride",
                serde_json::json!({}),
            )
            .await?;
            win::cdp(
                &webview,
                "Emulation.setTouchEmulationEnabled",
                serde_json::json!({ "enabled": false }),
            )
            .await?;
            win::cdp(
                &webview,
                "Emulation.setUserAgentOverride",
                serde_json::json!({ "userAgent": "" }),
            )
            .await?;
            return Ok(());
        };
        win::cdp(
            &webview,
            "Emulation.setDeviceMetricsOverride",
            serde_json::json!({
                "width": w.clamp(200, 3840),
                "height": h.clamp(200, 2160),
                "deviceScaleFactor": 0,
                "mobile": mobile,
                "scale": scale.unwrap_or(1.0).clamp(0.1, 1.0),
            }),
        )
        .await?;
        win::cdp(
            &webview,
            "Emulation.setTouchEmulationEnabled",
            serde_json::json!({ "enabled": mobile, "maxTouchPoints": 5 }),
        )
        .await?;
        let agent = if mobile {
            // The engine's own user agent, as its Android build words it.
            let found = win::cdp(&webview, "Browser.getVersion", serde_json::json!({})).await?;
            phone_agent(found["userAgent"].as_str().unwrap_or_default())
        } else {
            String::new()
        };
        win::cdp(
            &webview,
            "Emulation.setUserAgentOverride",
            serde_json::json!({ "userAgent": agent }),
        )
        .await
        .map(|_| ())
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, width, height, mobile, scale);
        Err("not on this platform yet".into())
    }
}

/// A desktop Chromium user agent as the same engine's Android build sends
/// it, so sites serve the phone layout in device view.
#[cfg_attr(not(windows), allow(dead_code))]
fn phone_agent(desktop: &str) -> String {
    let Some(open) = desktop.find('(') else {
        return String::new();
    };
    let Some(close) = desktop[open..].find(')').map(|i| open + i) else {
        return String::new();
    };
    let rest = desktop[close + 1..].replace(" Safari/", " Mobile Safari/");
    // Edge's token is not on Android's Chromium.
    let rest = rest.split(" Edg/").next().unwrap_or(&rest).to_string();
    format!("{}(Linux; Android 10; K){rest}", &desktop[..open])
}

/// Forget the current site: its cookies, storage and cache.
#[tauri::command]
pub async fn browser_clear_site(app: AppHandle, tab: String) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    let url = webview.url().map_err(|e| e.to_string())?;
    let origin = url.origin().ascii_serialization();
    if origin == "null" {
        return Err("this page has no site to clear".into());
    }
    #[cfg(windows)]
    {
        win::cdp(
            &webview,
            "Storage.clearDataForOrigin",
            serde_json::json!({ "origin": origin, "storageTypes": "all" }),
        )
        .await?;
        webview.reload().map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Err("not on this platform yet".into())
    }
}

/// Open the page in the system's default browser.
#[tauri::command]
pub fn browser_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only web pages open outside".into());
    }
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app)
        .open(url.as_str(), None)
        .map_err(|e| e.to_string())
}

/// Show a finished download in the file manager.
#[tauri::command]
pub fn browser_reveal(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.exists() {
        return Err("that file is gone".into());
    }
    #[cfg(windows)]
    let shown = std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&path)
        .spawn();
    #[cfg(target_os = "macos")]
    let shown = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let shown = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(&path))
        .spawn();
    shown.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn tabs_never_load_the_apps_own_addresses() {
        let dev = url("http://127.0.0.1:5175/");
        for app in [
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "http://ipc.localhost/daemon_info",
            "http://asset.localhost/x",
            "http://tauri.localhost./",
            "http://127.0.0.1:5175/",
            "tauri://localhost/",
            "ipc://localhost/",
            "javascript:alert(1)",
        ] {
            assert!(!allowed(&url(app), Some(&dev)), "{app} should be refused");
        }
    }

    #[test]
    fn the_web_and_the_users_dev_servers_stay_open() {
        let dev = url("http://127.0.0.1:5175/");
        for page in [
            "https://example.com/",
            "http://localhost:5173/",
            "http://127.0.0.1:3000/",
            "http://127.0.0.1:5176/",
            "about:blank",
            "file:///C:/site/index.html",
            "data:text/html,hi",
        ] {
            assert!(allowed(&url(page), Some(&dev)), "{page} should open");
        }
        // Without a dev server, its address is just another local port.
        assert!(allowed(&url("http://127.0.0.1:5175/"), None));
    }

    /// A page load must never be enough to write a file into the user's
    /// Downloads folder. This pins the answer the download handler gives:
    /// a page's download is refused, and the console reports it.
    #[test]
    fn a_page_never_starts_a_download_on_its_own() {
        assert!(!page_may_download());
    }

    #[test]
    fn device_view_speaks_as_the_engines_android_build() {
        let desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
        assert_eq!(
            phone_agent(desktop),
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"
        );
        assert_eq!(phone_agent("odd"), "");
    }

    /// The console decides what to draw from this, so it has to name every
    /// feature the four platform-gated commands need, and it has to be
    /// right about this build.
    #[test]
    fn this_build_says_which_browser_features_it_has() {
        let features = browser_features();
        let windows = cfg!(windows);
        assert_eq!(features.find, windows);
        assert_eq!(features.cdp, windows);
        assert_eq!(features.viewport, windows);
        assert_eq!(features.clear_site, windows);
        // The console reads camelCase keys off the JSON.
        let json = serde_json::to_value(features).unwrap();
        for key in ["find", "cdp", "viewport", "clearSite"] {
            assert!(json.get(key).is_some(), "{key} should be in {json}");
        }
    }
}
