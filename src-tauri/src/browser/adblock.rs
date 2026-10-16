//! Ad and tracker blocking for the browser's tabs: the glue between the
//! daemon's word and the tabs' hooks (`hooks`, which is all WebView2).
//!
//! Off, this does nothing at all: no tab is hooked, so no request is ever
//! held up to be looked at, and the filter engine is not even built. The
//! daemon owns the setting, the sites the user allows ads on, and the
//! lists' freshness, and tells this module in one call (`configure`) when
//! the browser says hello and whenever any of it changes. Until it has
//! fresher lists, blocking uses the ones that came with the app, so it
//! works at once and offline.

mod hooks;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Webview};

use super::Browser;
use hooks::{Hooks, Sink};

/// Where the console hears how many requests a tab's page has had blocked.
const BLOCKED_EVENT: &str = "browser:blocked";

/// Bumped by every `configure`, so a slow build never replaces a newer one.
static ROUND: AtomicU64 = AtomicU64::new(0);

/// The tabs that are hooked, by the tokens to take their hooks off again.
static HOOKED: Mutex<Option<HashMap<String, Hooks>>> = Mutex::new(None);

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What the console is told: a tab's page and how much of it was blocked.
#[derive(Clone, Serialize)]
struct Blocked {
    tab: String,
    count: u32,
}

impl Sink for AppHandle {
    fn blocked(&self, tab: &str, count: u32) {
        let _ = self.emit_to(
            super::console(),
            BLOCKED_EVENT,
            Blocked {
                tab: tab.to_string(),
                count,
            },
        );
    }
}

/// The daemon's word on blocking. Off takes every hook off every tab and
/// frees the engine; on builds the engine (off the window's thread) and
/// hooks the tabs that are open, and tabs opened later hook themselves.
pub fn configure(app: &AppHandle, on: bool, lists: Vec<String>, updated: i64, allow: Vec<String>) {
    let round = ROUND.fetch_add(1, Ordering::SeqCst) + 1;
    if !on {
        hooks::stop();
        unhook_all(app);
        return;
    }
    let source = (lists, updated);
    // Allowed sites change without a rebuild.
    if hooks::update(allow.clone(), &source) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let engine = Arc::new(hooks::build(&source.0));
        // A newer word came while this built: it is the one to keep.
        if ROUND.load(Ordering::SeqCst) != round {
            return;
        }
        hooks::start(engine, source, allow);
        hook_all(&app);
    });
}

/// Hook every tab that is open now.
fn hook_all(app: &AppHandle) {
    let tabs: Vec<String> = app
        .state::<Browser>()
        .tabs
        .lock()
        .expect("browser lock")
        .keys()
        .cloned()
        .collect();
    for id in tabs {
        if let Some(webview) = app.get_webview(&id) {
            attach(app, &webview);
        }
    }
}

fn unhook_all(app: &AppHandle) {
    let hooked: Vec<(String, Hooks)> = locked(&HOOKED)
        .take()
        .map(|m| m.into_iter().collect())
        .unwrap_or_default();
    for (id, tokens) in hooked {
        if let Some(webview) = app.get_webview(&id) {
            let _ = webview.with_webview(move |platform| {
                // SAFETY: COM calls on the window's thread.
                unsafe { hooks::unhook(&platform.controller(), tokens) }
            });
        }
    }
}

/// A tab is gone: nothing of it is kept.
pub fn forget(tab: &str) {
    if let Some(hooked) = locked(&HOOKED).as_mut() {
        hooked.remove(tab);
    }
    hooks::forget(tab);
}

/// Hook one tab, if blocking is on (a tab just opened, or one that was
/// open when blocking was turned on).
pub fn attach(app: &AppHandle, webview: &Webview) {
    if !hooks::is_on() {
        return;
    }
    let app = app.clone();
    let tab = webview.label().to_string();
    let _ = webview.with_webview(move |platform| {
        // Every closure on the window's thread runs one at a time, so a
        // tab is hooked once however many times it was asked.
        if locked(&HOOKED)
            .get_or_insert_with(HashMap::new)
            .contains_key(&tab)
        {
            return;
        }
        // SAFETY: COM calls on the window's thread; the controller and
        // environment are this tab's own.
        let tokens =
            unsafe { hooks::hook(&app, &tab, &platform.controller(), &platform.environment()) };
        if let Some(tokens) = tokens {
            locked(&HOOKED)
                .get_or_insert_with(HashMap::new)
                .insert(tab, tokens);
        }
    });
}
