//! The desktop shell runs the daemon as a sidecar. The shell owns one
//! daemon for the app's lifetime and respawns it when it dies on its
//! own; the daemon's stdin watchdog (it exits when stdin closes) kills it
//! transitively on app exit.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, State, WindowEvent};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::{browser, tray, DaemonInfo, DaemonState};

const DAEMON_NAME: &str = "openremote-daemon";

/// How long the shell waits before respawning a daemon that died on its
/// own. A daemon that got as far as READY was healthy, so its death was
/// a blip and the wait resets to the minimum; each daemon that dies (or
/// fails to start) without ever saying READY doubles the wait, capped,
/// so a daemon that cannot start is retried slowly instead of in a tight
/// loop.
const RESPAWN_WAIT_MIN: Duration = Duration::from_secs(2);
const RESPAWN_WAIT_MAX: Duration = Duration::from_secs(30);

/// The sidecar child the shell owns: the running daemon's handle, or
/// None while none runs (dead, and not yet respawned). daemon_restart
/// takes the child to stop the old daemon before spawning a new one, and
/// a watcher tells its own daemon by the child's pid. Storing a
/// replacement drops the child it replaces, and with it the daemon's
/// stdin pipe: the daemon exits when stdin closes, so a replaced daemon
/// stops itself, and the app-exit path rides the same watchdog.
#[derive(Default)]
struct Sidecar(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// Lines for the daemon's stdin (the built-in browser's news and answers),
/// written in order by one thread so a busy pipe never holds up the window.
static TO_DAEMON: std::sync::OnceLock<std::sync::mpsc::Sender<String>> = std::sync::OnceLock::new();

/// Send one line to the running daemon; dropped when none runs (the next
/// daemon hears everything again in its hello).
pub fn write_to_daemon(app: &tauri::AppHandle, line: &str) {
    let tx = TO_DAEMON.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let app = app.clone();
        std::thread::spawn(move || {
            for line in rx {
                let sidecar = app.state::<Sidecar>();
                let mut slot = sidecar.0.lock().expect("daemon state lock");
                if let Some(child) = slot.as_mut() {
                    let _ = child.write(
                        format!(
                            "{line}
"
                        )
                        .as_bytes(),
                    );
                }
            }
        });
        tx
    });
    let _ = tx.send(line.to_string());
}

/// Restart the daemon sidecar: kill the old child, drop what the shell
/// knew about it, spawn fresh. The console heals on its own - on
/// connection error it re-polls daemon_info every 2.5s and follows a
/// new port - so this returns before the new daemon is ready.
#[tauri::command]
fn daemon_restart(
    app: tauri::AppHandle,
    state: State<'_, DaemonState>,
    sidecar: State<'_, Sidecar>,
) {
    if let Some(child) = sidecar.0.lock().expect("daemon state lock").take() {
        let _ = child.kill();
    }
    *state.info.lock().expect("daemon state lock") = DaemonInfo::default();
    spawn_daemon(app);
}

pub fn run() {
    let builder = tauri::Builder::default();
    // First, so a second launch is answered before anything else starts.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        tray::show_main(app);
    }));
    builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(DaemonState::default())
        .manage(Sidecar::default())
        .manage(tray::TrayState::default())
        .manage(browser::Browser::default())
        .invoke_handler(tauri::generate_handler![
            crate::daemon_info,
            daemon_restart,
            tray::tray_prefs,
            tray::set_tray_prefs,
            browser::browser_open,
            browser::browser_tabs,
            browser::browser_close,
            browser::browser_set_bounds,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_capture,
            browser::browser_cdp,
            browser::browser_stop,
            browser::browser_zoom,
            browser::browser_find,
            browser::browser_print,
            browser::browser_devtools,
            browser::browser_viewport,
            browser::browser_clear_site,
            browser::browser_open_external,
            browser::browser_reveal,
            browser::browser_permission,
            browser::browser_pick,
            browser::browser_screencast,
            browser::browser_save_file,
            browser::browser_clear_data,
            browser::browser_share
        ])
        .setup(|app| {
            // A dev build gives the console's webview a debugging port
            // (main.rs). The window exists by now, so the variable has done
            // its job; dropping it keeps the port off the browser's own
            // profile, which is driven in-process and never opens one.
            #[cfg(all(windows, debug_assertions))]
            std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
            #[cfg(all(windows, debug_assertions))]
            if let Some(out) = std::env::var_os("OPENREMOTE_BROWSER_SELFTEST") {
                browser::selftest::start(app.handle().clone(), out.into());
            }
            tray::load(app.handle());
            tray::apply(app.handle());
            spawn_daemon(app.handle().clone());
            browser::start_sweeper(app.handle().clone());
            Ok(())
        })
        // With the tray on, closing the window hides it: the daemon keeps
        // serving this computer's synced chats and the user's other devices.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && tray::keeps_running(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenRemote");
}

/// Spawn the daemon sidecar and keep it alive for the app's lifetime:
/// watch its stdout lines (READY / DATA_DIR) and publish the info once
/// both are seen. When the event stream ends while the child is still
/// this watcher's own (the daemon crashed, or something outside the app
/// killed it), clear the published info and spawn a replacement after a
/// bounded wait: the console's poll then sees a not-ready daemon instead
/// of retrying a dead address, and follows the replacement once it
/// publishes. A deliberate restart replaces the child itself, which the
/// watcher sees and stands down for.
fn spawn_daemon(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // The delay before the next spawn after a death.
        let mut wait = RESPAWN_WAIT_MIN;
        loop {
            let sidecar = app
                .shell()
                .sidecar(DAEMON_NAME)
                .expect("daemon sidecar registered in tauri.conf.json");
            let sidecar = match system_env() {
                Some(vars) => sidecar.env_clear().envs(vars),
                None => sidecar,
            };
            let (mut rx, child) = match sidecar.spawn() {
                Ok(spawned) => spawned,
                Err(err) => {
                    // The binary could not be started at all:
                    // quarantined by a scanner, truncated by an
                    // interrupted copy, locked by another process. That
                    // can be transient while the app lives, so retry on
                    // the growing wait; the info stays clear meanwhile.
                    eprintln!("openremote: the daemon could not be started: {err}");
                    respawn_delay(wait).await;
                    if daemon_slot_claimed(&app) {
                        return;
                    }
                    wait = (wait * 2).min(RESPAWN_WAIT_MAX);
                    continue;
                }
            };
            let pid = child.pid();
            app.state::<Sidecar>()
                .0
                .lock()
                .expect("daemon state lock")
                .replace(child);

            let mut info = DaemonInfo::default();
            let mut published = false;
            while let Some(event) = rx.recv().await {
                if let CommandEvent::Stdout(line) = event {
                    let line = String::from_utf8_lossy(&line).trim().to_string();
                    // The daemon's calls to the built-in browser share the pipe.
                    if browser::pipe::receive(&app, &line) {
                        continue;
                    }
                    if let Some(addr) = line.strip_prefix("READY ") {
                        info.url = Some(format!("http://{addr}"));
                    } else if let Some(dir) = line.strip_prefix("DATA_DIR ") {
                        info.data_dir = Some(dir.to_string());
                    }
                    if info.url.is_some() && info.data_dir.is_some() && !published {
                        publish(&app, &mut info);
                        published = true;
                        // A new daemon learns about the browser and its tabs.
                        browser::pipe::hello(&app);
                    }
                }
            }
            // The stream ends only when the process is gone. If the
            // child in the slot is still this one's, the daemon died on
            // its own: take the dead handle out so the slot says what is
            // true (no daemon running). Otherwise a deliberate restart
            // or another watcher already replaced it.
            let was_mine = {
                let sidecar = app.state::<Sidecar>();
                let mut slot = sidecar.0.lock().expect("daemon state lock");
                let mine = slot.as_ref().is_some_and(|child| child.pid() == pid);
                if mine {
                    let _ = slot.take();
                }
                mine
            };
            if !was_mine {
                return;
            }
            // Clear the dead daemon's info so daemon_info stops answering
            // with an address nothing listens on. The replacement
            // repopulates it when it says READY and DATA_DIR.
            *app.state::<DaemonState>()
                .info
                .lock()
                .expect("daemon state lock") = DaemonInfo::default();
            eprintln!("openremote: the daemon exited, respawning");
            respawn_delay(wait).await;
            if daemon_slot_claimed(&app) {
                return;
            }
            let was_ready = info.url.is_some();
            wait = if was_ready {
                RESPAWN_WAIT_MIN
            } else {
                (wait * 2).min(RESPAWN_WAIT_MAX)
            };
        }
    });
}

/// Whether another spawn claimed the sidecar slot while a dead daemon's
/// watcher was waiting to respawn it. Only daemon_restart and a
/// respawning watcher store a child, so a claimed slot means one of them
/// ran; the waiting watcher stands down rather than double-spawn.
fn daemon_slot_claimed(app: &tauri::AppHandle) -> bool {
    app.state::<Sidecar>()
        .0
        .lock()
        .expect("daemon state lock")
        .is_some()
}

/// Sleep out a respawn wait on the runtime's blocking pool. The shell
/// carries no timer of its own, and sleeping inline would park an async
/// worker that other work still needs; the blocking pool exists for
/// exactly this kind of wait.
async fn respawn_delay(wait: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(wait)).await;
}

/// Under an AppImage the shell runs with the image's own library and data
/// paths. The daemon and every harness it starts (node, python, git...)
/// must see the system's instead, or they load the image's libraries and
/// break. None outside an AppImage: the environment passes through as is.
fn system_env() -> Option<Vec<(String, String)>> {
    let appdir = std::env::var("APPDIR").ok().filter(|d| !d.is_empty())?;
    let mut vars = Vec::new();
    for (key, value) in std::env::vars() {
        // The AppImage runtime's own variables, and toolkit paths set only
        // for the image's GTK/WebKit.
        if matches!(key.as_str(), "APPDIR" | "APPIMAGE" | "ARGV0" | "OWD")
            || key.starts_with("GTK_")
            || key.starts_with("GIO_")
            || key.starts_with("GDK_PIXBUF_")
            || key == "GI_TYPELIB_PATH"
            || key == "GSETTINGS_SCHEMA_DIR"
        {
            continue;
        }
        if !value.contains(&appdir) {
            vars.push((key, value));
            continue;
        }
        // Path lists keep their entries from outside the image.
        let kept: Vec<&str> = value
            .split(':')
            .filter(|entry| !entry.is_empty() && !entry.starts_with(&appdir))
            .collect();
        if !kept.is_empty() {
            vars.push((key, kept.join(":")));
        }
    }
    Some(vars)
}

/// Fill in the token (from the daemon's data dir) and hand the info to the
/// console.
fn publish(app: &tauri::AppHandle, info: &mut DaemonInfo) {
    info.token = info
        .data_dir
        .as_deref()
        .and_then(read_daemon_token_at)
        .or_else(read_daemon_token_default);
    let state = app.state::<DaemonState>();
    *state.info.lock().expect("daemon state lock") = info.clone();
}

/// The daemon's default data dir is `~/.openremote`; its `token` file holds
/// the bearer secret (the daemon logs it on first run as well).
fn read_daemon_token_default() -> Option<String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)?;
    read_daemon_token_at(home.join(".openremote").to_str()?)
}

fn read_daemon_token_at(dir: &str) -> Option<String> {
    let token = std::fs::read_to_string(std::path::Path::new(dir).join("token")).ok()?;
    let token = token.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}
