//! Supervisor lifecycle e2e: the hardening paths the audit found - stop
//! settling a session whose harness already died (the fallback drain),
//! a harness uninstalled mid-run disappearing from the console's
//! offers (lazy eviction), and the daemon's exit sweep taking its
//! harness children with it instead of orphaning them.
//!
//! The quiet-session stop baseline lives in e2e.rs
//! (`stop_retires_pending_decisions_and_the_late_answer_conflicts`);
//! this suite stages what that one cannot: dead drivers, vanishing
//! binaries, and process-level exit.

mod common;

use common::*;
use serde_json::json;

/// A grok print-mode session: process-per-prompt, so a `die` turn leaves
/// the driver with no live child and no StdoutClosed ever coming - the
/// exact shape stop's fallback drain exists for.
async fn grok_session(scenario: &str) -> (TestDaemon, tempfile::TempDir, String) {
    let daemon = start_daemon(&[("grok", fixture_agent())]).await;
    let ws = workspace(Some(scenario));
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "l-create", "harness": "grok", "workspace": ws.path()})),
    )
    .await;
    assert_eq!(created.status, 201, "raw: {}", created.raw);
    let id = created.body["id"].as_str().expect("session id").to_string();
    (daemon, ws, id)
}

/// Stop after the harness died on its own (harness audit F12's fallback
/// and F10's removal): a grok `die` turn kills the prompt process with
/// no result and no StdoutClosed - the pump will never answer the stop.
/// Stop must still settle the session (not leave it answerable), retire
/// its pending decisions, and remove the map entry: a later answer
/// conflicts by name, not by dangling promise.
#[tokio::test]
async fn stop_after_the_harness_died_still_settles_and_retires() {
    let (daemon, ws, id) = grok_session("die").await;
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "l-p1", "text": "die on me"})),
    )
    .await;
    // The failed turn boundary lands (grok's own EOF mapping); the
    // session then sits idle-alive with a dead child - the zombie window.
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["turn.completed", "session.status_changed"],
    )
    .await;

    let stop = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/stop"),
        Some(json!({"request_id": "l-stop"})),
    )
    .await;
    assert_eq!(stop.status, 200, "raw: {}", stop.raw);
    assert_eq!(
        stop.body["status"], "stopped",
        "the dead-driver session settles stopped; body: {}",
        stop.raw
    );

    // Nothing stays answerable: a prompt against the removed entry
    // refuses by name - the honest error for a chat no process backs.
    let late = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "l-late", "text": "anyone there"})),
    )
    .await;
    assert_eq!(
        late.status, 404,
        "a stopped chat's prompt answers not-found; raw: {}",
        late.raw
    );
    assert!(
        late.body["error"]
            .as_str()
            .unwrap_or("")
            .contains("not running"),
        "the refusal names the contract; raw: {}",
        late.raw
    );

    // The transcript holds exactly one boundary for the turn - the
    // harness's own failed one, not a duplicate from the settle.
    let events = sse_collect(&daemon, &format!("/sessions/{id}/events"), 6).await;
    let boundaries = events
        .iter()
        .filter(|(_, p)| kind(p) == "turn.completed")
        .count();
    assert_eq!(
        boundaries,
        1,
        "one boundary for one turn; events:\n{}",
        dump(&events)
    );
    let _ = ws;
}

/// A harness uninstalled mid-run (harness audit F18): the registry's
/// probe facts are stale the moment the binary vanishes. The create
/// succeeds (grok spawns no process until the first prompt), the prompt
/// fails with a raw OS error, the supervisor looks, the files are gone,
/// and the harness stops being offered - the console can no longer open
/// chats against a binary that is not there.
#[tokio::test]
async fn a_harness_uninstalled_mid_run_disappears_from_the_offers() {
    // A fixture binary in a temp dir the test owns: present for the
    // probe, deleted before the prompt - the uninstall, staged.
    let dir = tempfile::tempdir().expect("fixture dir");
    let bin = dir.path().join(if cfg!(windows) {
        "vanished-harness.exe"
    } else {
        "vanished-harness"
    });
    std::fs::copy(fixture_agent(), &bin).expect("copy fixture");
    let daemon = start_daemon(&[("grok", bin.clone())]).await;
    let ws = workspace(None);

    // The probe saw it: grok is offered and the create takes it.
    let caps = call(&daemon, "GET", "/capabilities", None).await;
    let offered = caps.body["harnesses"]
        .as_array()
        .expect("harnesses")
        .iter()
        .any(|h| h["id"] == "grok" && h["available"] == true);
    assert!(offered, "grok is offered while the binary exists");
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "l-create-gone", "harness": "grok", "workspace": ws.path()})),
    )
    .await;
    assert_eq!(created.status, 201, "raw: {}", created.raw);
    let id = created.body["id"].as_str().expect("session id").to_string();

    // The uninstall: the binary the registry resolved is gone. The next
    // prompt's spawn fails with the OS's own words.
    std::fs::remove_file(&bin).expect("delete the fixture binary");
    let prompted = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "l-p1", "text": "gone already"})),
    )
    .await;
    assert_eq!(
        prompted.status, 500,
        "the failed spawn surfaces its own error; raw: {}",
        prompted.raw
    );
    let session = until_status(&daemon, &id, &["failed"]).await;
    assert!(
        session["last_error"]
            .as_str()
            .unwrap_or_default()
            .contains("spawn failed"),
        "the session's first fact is the spawn failure; got: {session}"
    );

    // The dangling turn the prompt opened got its failed boundary - the
    // F17 half of the same prompt path.
    let events = sse_collect(&daemon, &format!("/sessions/{id}/events"), 6).await;
    let kinds: Vec<String> = events.iter().map(|(_, p)| kind(p)).collect();
    assert!(
        kinds.contains(&"turn.completed".to_string()),
        "the turn the failed prompt opened is closed; kinds: {kinds:?}"
    );

    // The eviction: the console's next look no longer offers grok.
    let caps = call(&daemon, "GET", "/capabilities", None).await;
    let grok = caps.body["harnesses"]
        .as_array()
        .expect("harnesses")
        .iter()
        .find(|h| h["id"] == "grok")
        .expect("grok keeps its slot")
        .clone();
    assert_eq!(
        grok["available"], false,
        "the vanished harness is no longer offered; raw: {}",
        caps.raw
    );

    // And a second create answers the harness error, not another raw
    // OS spawn error: the slot is closed until a re-probe.
    let second = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "l-create-again", "harness": "grok", "workspace": ws.path()})),
    )
    .await;
    assert_eq!(
        second.status, 400,
        "the evicted harness refuses cleanly; raw: {}",
        second.raw
    );
    assert!(
        second.body["error"]
            .as_str()
            .unwrap_or("")
            .contains("not available"),
        "the refusal names the harness, not the OS; raw: {}",
        second.raw
    );
}

/// The daemon's exit sweep (harness audit F3): the stdin watchdog path
/// runs a bounded shutdown of every live session before exit(0). The
/// opencode fixture is a real serve child with null stdin that would
/// otherwise outlive the daemon - exactly the orphan. The daemon's
/// stdin closes (the shell's death), the sweep runs, the daemon exits,
/// and the child must be gone with it.
#[tokio::test]
async fn the_daemons_exit_sweep_takes_the_serve_child_with_it() {
    let bin = fixture_agent();
    let data_dir = tempfile::tempdir().expect("temp data dir");
    let token = uuid::Uuid::new_v4().to_string();
    std::fs::create_dir_all(data_dir.path()).expect("data dir");
    std::fs::write(data_dir.path().join("token"), &token).expect("token file");
    let mut command = std::process::Command::new(daemon_binary());
    command
        .env("OPENREMOTE_DATA_DIR", data_dir.path())
        .env("OPENREMOTE_OPENCODE_PATH", bin.display().to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().expect("spawn daemon process");
    let mut stdout = child.stdout.take().expect("stdout piped");
    let stdin = child.stdin.take().expect("stdin piped");

    // The READY/DATA_DIR handshake, in the test (bounded).
    use std::io::BufRead;
    let addr = {
        let mut line = String::new();
        let mut reader = std::io::BufReader::new(&mut stdout);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if std::time::Instant::now() >= deadline {
                panic!("daemon never said READY");
            }
            line.clear();
            let _ = reader.read_line(&mut line);
            if let Some(rest) = line.trim().strip_prefix("READY ") {
                break rest.parse::<std::net::SocketAddr>().expect("address");
            }
        }
    };

    // A tiny TestDaemon stand-in for the call helpers: the address and
    // token the raw client needs.
    let daemon = TestDaemon::from_parts(addr, token.clone(), data_dir);

    // A live opencode session: the serve child is up.
    let ws = workspace(None);
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({
            "request_id": "l-op-create",
            "harness": "opencode",
            "workspace": ws.path(),
        })),
    )
    .await;
    assert_eq!(created.status, 201, "raw: {}", created.raw);
    let id = created.body["id"].as_str().expect("session id").to_string();
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;

    let before = fixture_agent_pids().await;
    assert!(!before.is_empty(), "the opencode serve child is running");

    // The shell's death: close the daemon's stdin. The watchdog fires,
    // the sweep runs, the daemon exits 0 - and the serve child goes with
    // it. No kill from this side; the daemon's own exit path is the
    // thing under test.
    drop(stdin);
    let exited = tokio::task::spawn_blocking(move || child.wait().expect("daemon reaped"))
        .await
        .expect("wait task");
    assert!(exited.success(), "the daemon exited cleanly");

    // The sweep is bounded but real; give it the window and then some.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let after = fixture_agent_pids().await;
        if after.is_empty() || tokio::time::Instant::now() >= deadline {
            assert!(
                after.is_empty(),
                "the serve child outlived the daemon - the orphan F3 names; still running: {after:?}"
            );
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

/// The fixture-agent processes running right now, as PIDs (Windows
/// tasklist; the suite is Windows-first and CI runs it there).
async fn fixture_agent_pids() -> Vec<String> {
    let name = if cfg!(windows) {
        "fixture-agent.exe"
    } else {
        "fixture-agent"
    };
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {name}"), "/FO", "CSV", "/NH"])
        .output()
        .expect("tasklist runs");
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    text.lines()
        .filter(|line| line.contains(&format!("\"{name}\"")))
        .filter_map(|line| {
            // CSV: "name","pid",...
            line.split(',')
                .nth(1)
                .map(|pid| pid.trim_matches('"').to_string())
        })
        .collect()
}
