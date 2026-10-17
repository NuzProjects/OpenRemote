//! The daemon binary.
//!
//! - `openremote-daemon`: the desktop app's sidecar. Prints
//!   `READY 127.0.0.1:<port>` on stdout when it is listening (all logs go to
//!   stderr) and exits when stdin closes or the app that started it is
//!   gone - the desktop shell owns its lifetime.
//! - `openremote-daemon agent`: a machine's long-running service (systemd
//!   runs it). No stdin watchdog; exits 78 when this computer isn't in
//!   OpenRemote Cloud, so the service manager stops retrying.
//! - `openremote-daemon enroll <code>`: joins this computer to the account
//!   that minted the install code.
//! - `openremote-daemon status`: exits 0 when this computer is in Cloud.
//! - `openremote-daemon unenroll`: leaves Cloud (keeps private chats).
//! - `openremote-daemon mcp-chat --session <id> --port <p> --data-dir <d>`:
//!   the read-a-chat MCP server a chat's harness starts over stdio.
//! - `openremote-daemon --version`.

use std::process::ExitCode;
use std::sync::Arc;

use openremote_cloud::{Cloud, CloudConfig};
use openremote_daemon::app::{self, App, AppOptions};
use openremote_daemon::shutdown;

/// sysexits' EX_CONFIG: not enrolled, and retrying won't change that.
const NOT_ENROLLED: u8 = 78;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    match args.first().map(String::as_str) {
        None => runtime.block_on(serve(false)),
        Some("agent") => runtime.block_on(serve(true)),
        Some("enroll") => match args.get(1) {
            Some(code) => runtime.block_on(enroll(code)),
            None => {
                eprintln!("usage: openremote-daemon enroll <code>");
                ExitCode::from(2)
            }
        },
        // A chat's read-a-chat MCP server (OpenRemote Controls), started by
        // the chat's harness over stdio.
        Some("mcp-chat") => runtime.block_on(openremote_daemon::mcp_chat::run(&args[1..])),
        Some("status") => status(),
        Some("unenroll") => runtime.block_on(unenroll()),
        Some("--version" | "-V") => {
            println!("openremote-daemon {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!(
                "openremote-daemon: unknown command '{other}' (agent, enroll, status, unenroll, mcp-chat, --version)"
            );
            ExitCode::from(2)
        }
    }
}

async fn serve(agent: bool) -> ExitCode {
    let data_dir = app::default_data_dir();
    let cloud = CloudConfig::from_env();
    if agent && !Cloud::open(cloud.clone(), &data_dir).enrolled() {
        eprintln!(
            "openremote-daemon: this computer isn't in OpenRemote Cloud - run `openremote-daemon enroll <code>` first"
        );
        return ExitCode::from(NOT_ENROLLED);
    }
    let token = app::load_or_create_token(&data_dir).expect("token");
    // Before the first child starts (the registry probe below): every
    // process this daemon starts ends with it, and none of them holds the
    // daemon's own pipes (shutdown.rs says why).
    shutdown::hold_children();
    shutdown::keep_pipes_private();
    // Bind and announce BEFORE the app assembles: the registry probe
    // spawns each harness's `--version` (bounded), and the shell should
    // know the address long before that finishes. The listener's
    // backlog holds any early request until `serve` picks it up.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    println!("READY 127.0.0.1:{}", addr.port());
    println!("DATA_DIR {}", data_dir.display());
    eprintln!(
        "openremote-daemon: token at {}",
        data_dir.join("token").display()
    );

    let app = App::new(AppOptions {
        data_dir: data_dir.clone(),
        token: token.clone(),
        cloud,
    })
    .await;
    // Chats start OpenRemote's read-a-chat MCP server from this binary,
    // calling back on this port.
    if let Ok(exe) = std::env::current_exe() {
        app.supervisor.set_controls(exe, addr.port());
    }

    if agent {
        // A service is stopped with SIGTERM (or Ctrl-C when run by hand).
        // The sweep before exit(0) is the orphan fix: exit runs no
        // destructors, so without it every harness child outlives the
        // daemon (opencode serve children have null stdin and never see
        // EOF). Bounded - a wedged child never hangs the exit.
        let app = Arc::clone(&app);
        tokio::spawn(async move {
            shutdown_signal().await;
            shutdown::leave(app, "stopping").await;
        });
    } else {
        // The app's sidecar: the app's browser talks to us over these same
        // pipes (`BROWSER {json}` lines both ways), so its tools are offered.
        app.browser.set_hosted();
        app.browser.connect(browser_sender());
        // The sidecar watchdog: when the shell dies, our stdin closes, and
        // the daemon must not outlive its owner. Same sweep for the same
        // reason - the children belong to this process, not to the shell.
        // The shell's process is watched too, in case a pipe end ever
        // outlives it.
        shutdown::watch_parent(Arc::clone(&app));
        let app = Arc::clone(&app);
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if let Some(message) = openremote_browser::parse(&line) {
                            app.browser.receive(message);
                        }
                    }
                    // A line that isn't text is skipped; the pipe is still open.
                    Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {}
                    Ok(None) | Err(_) => break,
                }
            }
            shutdown::leave(app, "stdin closed").await;
        });
    }

    app::serve(Arc::clone(&app) as Arc<App>, listener)
        .await
        .expect("serve");
    ExitCode::SUCCESS
}

/// Calls to the app's browser, one line each on stdout (beside READY and
/// DATA_DIR; every log goes to stderr). Written from a thread of its own,
/// so a slow reader at the other end never holds up the daemon's work.
fn browser_sender() -> openremote_daemon::browser::Sender {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        use std::io::Write;
        let stdout = std::io::stdout();
        for line in rx {
            let mut out = stdout.lock();
            if writeln!(out, "{line}").and_then(|()| out.flush()).is_err() {
                return;
            }
        }
    });
    Arc::new(move |message| {
        let _ = tx.send(openremote_browser::line(&message));
    })
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

async fn enroll(code: &str) -> ExitCode {
    let data_dir = app::default_data_dir();
    let cloud = Cloud::open(CloudConfig::from_env(), &data_dir);
    match cloud.enroll(code.trim()).await {
        Ok(joined) => {
            // The store learns its device id at the next start too; setting
            // it now keeps a crash in between harmless.
            if let Ok(mut store) = openremote_core::Store::open(data_dir) {
                let _ = store.set_this_device(Some(joined.device_id));
            }
            println!(
                "This computer joined {}'s OpenRemote Cloud as {}.",
                joined.account.email,
                cloud.config().device_name
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("openremote-daemon: couldn't join: {e}");
            ExitCode::FAILURE
        }
    }
}

fn status() -> ExitCode {
    let cloud = Cloud::open(CloudConfig::from_env(), &app::default_data_dir());
    let view = cloud.view();
    match view["account"]["email"].as_str() {
        Some(email) if cloud.enrolled() => {
            println!("In OpenRemote Cloud as {email}.");
            ExitCode::SUCCESS
        }
        _ => {
            println!("Not in OpenRemote Cloud.");
            ExitCode::FAILURE
        }
    }
}

async fn unenroll() -> ExitCode {
    let data_dir = app::default_data_dir();
    let cloud = Cloud::open(CloudConfig::from_env(), &data_dir);
    // Best effort: tell the registry this device is gone, then forget it.
    if let (Some(credential), Some(id)) = (cloud.device_credential(), cloud.device_id()) {
        let _ = cloud.registry().delete(&credential, &id.to_string()).await;
    }
    match cloud.signout().await {
        Ok(()) => {
            println!("This computer left OpenRemote Cloud.");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("openremote-daemon: {e}");
            ExitCode::FAILURE
        }
    }
}
