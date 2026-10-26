//! OpenRemote's shell: wraps the console (`src/`) and gives it a daemon.
//! On the desktop the daemon is a sidecar process (`desktop.rs`). Android
//! has no sidecars, so the app runs the daemon in its own process
//! (`mobile.rs`).

use std::sync::Mutex;

use tauri::State;

#[cfg(desktop)]
mod browser;
#[cfg(desktop)]
mod desktop;
#[cfg(target_os = "android")]
mod mobile;
#[cfg(desktop)]
mod tray;

/// What the shell knows about the running daemon. The console asks for
/// this on boot and while it has no connection, and the shell pushes it
/// whenever the answer changes.
#[derive(Clone, serde::Serialize, Default)]
pub struct DaemonInfo {
    /// `http://127.0.0.1:<port>` - ready when Some.
    pub url: Option<String>,
    /// The daemon's bearer token.
    pub token: Option<String>,
    /// The daemon's data dir.
    pub data_dir: Option<String>,
    /// The Android app: no window chrome, no tray, and Cloud only, since a
    /// phone runs no chats of its own.
    pub mobile: bool,
    /// Why the last attempt to run the daemon failed, when one did. The
    /// console shows this instead of waiting in silence; it is cleared as
    /// soon as a daemon says READY, and never set while one runs.
    pub error: Option<DaemonFailure>,
}

/// Which failure a reason describes. The reason text is the shell's own
/// words, and the title above it has to match them: "did not start" is a
/// lie about a daemon that ran for an hour and then exited.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonFailureKind {
    /// The binary never ran: missing, quarantined, locked, truncated.
    Start,
    /// It ran, and then exited on its own.
    Stopped,
    /// It is running and has not said READY.
    Silent,
}

/// A daemon that is not running: which failure it was, and the shell's own
/// words for it. The console shows the words under the title the kind picks.
#[derive(Clone, serde::Serialize)]
pub struct DaemonFailure {
    pub kind: DaemonFailureKind,
    /// The reason, in the shell's words.
    pub text: String,
}

#[derive(Default)]
struct DaemonState {
    info: Mutex<DaemonInfo>,
}

#[tauri::command]
fn daemon_info(state: State<'_, DaemonState>) -> DaemonInfo {
    state.info.lock().expect("daemon state lock").clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop::run();
    #[cfg(target_os = "android")]
    mobile::run();
}
