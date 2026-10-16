//! Updates on the desktop: a signed release found on the release page,
//! downloaded, checked against the public key the app was built with, and
//! installed when the user says so (the app restarts into it). The
//! console decides when to look and shows what was found.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// A newer release, as the console shows it.
#[derive(Clone, Serialize)]
pub struct Available {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// Whether this build can check: releases are signed and the app carries
/// the signing key's public half. Until the key exists, nothing is asked
/// of the network.
fn switched_on(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

const NOT_ON: &str =
    "Updates aren't switched on in this build yet: install new releases from the release page.";

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<Available>, String> {
    if !switched_on(&app) {
        return Err(NOT_ON.into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("couldn't check for updates: {e}"))?;
    Ok(update.map(|u| Available {
        version: u.version,
        notes: u.body,
        date: u.date.map(|d| d.to_string()),
    }))
}

/// Download, verify and install the newer release, then restart into it.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    if !switched_on(&app) {
        return Err(NOT_ON.into());
    }
    let Some(update) = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("couldn't check for updates: {e}"))?
    else {
        return Err("This is already the newest version.".into());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("the update didn't install: {e}"))?;
    // The daemon restarts with the app: its sidecar is replaced too.
    app.restart();
}
