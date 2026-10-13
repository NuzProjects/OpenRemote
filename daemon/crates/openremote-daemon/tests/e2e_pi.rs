//! Pi e2e: the real HTTP API + SSE driving the real openremote-pi driver
//! against the fixture's rpc mode - including a real dialog answer,
//! the thing cloudroom cancels and OpenRemote does.

mod common;

use common::*;
use serde_json::json;

async fn pi_daemon(scenario: Option<&str>) -> (TestDaemon, tempfile::TempDir) {
    let daemon = start_daemon(&[
        ("claude", fixture_agent()),
        ("codex", fixture_agent()),
        ("grok", fixture_agent()),
        ("pi", fixture_agent()),
    ])
    .await;
    let ws = workspace(scenario);
    (daemon, ws)
}

async fn create_pi(daemon: &TestDaemon, ws: &tempfile::TempDir) -> String {
    let created = call(
        daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "pi-create", "harness": "pi", "workspace": ws.path()})),
    )
    .await;
    assert_eq!(created.status, 201, "raw: {}", created.raw);
    created.body["id"].as_str().expect("session id").to_string()
}

#[tokio::test]
async fn a_pi_prompt_runs_a_real_turn_end_to_end() {
    let (daemon, ws) = pi_daemon(Some("plain")).await;
    let id = create_pi(&daemon, &ws).await;

    // get_state names pi's own conversation.
    let events = until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;
    let _ = events;
    let session = call(&daemon, "GET", &format!("/sessions/{id}"), None).await;
    assert_eq!(
        session.body["harness_session_ref"].as_str(),
        Some("pi-fixture-session-1"),
        "pi's session id is the ref: {}",
        session.raw
    );

    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "pi-p1", "text": "ship the notes"})),
    )
    .await;
    let events = until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["message.delta", "turn.completed", "session.status_changed"],
    )
    .await;
    let completed = events
        .iter()
        .find(|(_, p)| kind(p) == "turn.completed")
        .expect("completed");
    assert_eq!(completed.1["outcome"], "stop", "pi's own word");
    assert_eq!(completed.1["coarse"], "completed");
}

#[tokio::test]
async fn pi_dialogs_are_answered_not_cancelled() {
    let (daemon, ws) = pi_daemon(Some("dialog")).await;
    let id = create_pi(&daemon, &ws).await;
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;

    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "pi-p1", "text": "migrate the db"})),
    )
    .await;

    // The select dialog arrives as a decision with pi's own options.
    let events = until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["decision.requested", "session.status_changed"],
    )
    .await;
    let decision = events
        .iter()
        .find(|(_, p)| kind(p) == "decision.requested")
        .and_then(|(_, p)| p.get("decision"))
        .expect("the decision");
    assert_eq!(decision["kind"], "question");
    assert_eq!(
        decision["harness_request"]["title"], "Which database?",
        "pi's own dialog title rides verbatim"
    );
    let options: Vec<&str> = decision["options"]
        .as_array()
        .expect("options")
        .iter()
        .map(|o| o["id"].as_str().expect("option id"))
        .collect();
    assert_eq!(options, vec!["Postgres", "SQLite"]);
    let decision_id = decision["id"].as_str().expect("decision id").to_string();

    // Answer with pi's own option word; the turn finishes with the choice.
    let answer = call(
        &daemon,
        "POST",
        &format!("/decisions/{decision_id}/answer"),
        Some(json!({"request_id": "pi-a1", "choice": "Postgres"})),
    )
    .await;
    assert_eq!(answer.status, 200, "raw: {}", answer.raw);

    let events = until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &[
            "decision.responded",
            "session.status_changed",
            "message.delta",
            "turn.completed",
            "session.status_changed",
        ],
    )
    .await;
    let responded_at = events
        .iter()
        .position(|(_, p)| kind(p) == "decision.responded")
        .expect("decision.responded");
    let delta = events[responded_at + 1..]
        .iter()
        .find(|(_, p)| kind(p) == "message.delta")
        .map(|(_, p)| p["text"].as_str().expect("delta text").to_string());
    assert_eq!(
        delta.as_deref(),
        Some("Postgres"),
        "the answer flowed into the turn"
    );
    let completed = events
        .iter()
        .find(|(_, p)| kind(p) == "turn.completed")
        .expect("completed");
    assert_eq!(completed.1["outcome"], "stop");
}

#[tokio::test]
async fn pi_interrupts_map_to_pi_own_word() {
    let (daemon, ws) = pi_daemon(Some("dialog")).await;
    let id = create_pi(&daemon, &ws).await;
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "pi-p1", "text": "anything"})),
    )
    .await;
    // Park on the dialog, then interrupt.
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["decision.requested", "session.status_changed"],
    )
    .await;
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/interrupt"),
        Some(json!({"request_id": "pi-int"})),
    )
    .await;
    let events = until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["turn.completed", "session.status_changed"],
    )
    .await;
    let completed = events
        .iter()
        .find(|(_, p)| kind(p) == "turn.completed")
        .expect("completed");
    assert_eq!(completed.1["outcome"], "aborted", "pi's own word");
    assert_eq!(completed.1["coarse"], "interrupted");
}

#[tokio::test]
async fn pi_resumes_the_same_conversation() {
    let (daemon, ws) = pi_daemon(Some("plain")).await;
    let id = create_pi(&daemon, &ws).await;
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "pi-p1", "text": "first"})),
    )
    .await;
    until_count(
        &daemon,
        &format!("/sessions/{id}/events"),
        "turn.completed",
        1,
    )
    .await;

    let stopped = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/stop"),
        Some(json!({"request_id": "pi-stop"})),
    )
    .await;
    assert_eq!(stopped.body["status"], "stopped", "raw: {}", stopped.raw);

    let resumed = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/resume"),
        Some(json!({"request_id": "pi-resume"})),
    )
    .await;
    assert_eq!(resumed.status, 200, "raw: {}", resumed.raw);
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "pi-p2", "text": "second"})),
    )
    .await;
    let events = until_count(
        &daemon,
        &format!("/sessions/{id}/events"),
        "turn.completed",
        2,
    )
    .await;
    assert_eq!(
        events
            .iter()
            .filter(|(_, p)| kind(p) == "turn.started")
            .count(),
        2,
        "both turns in the log; events:\n{}",
        dump(&events)
    );
}

/// A CLI that dies at boot must fail create in seconds, not after the
/// 60s the unraced get_state call used to burn (harness audit F13).
#[tokio::test]
async fn a_boot_crashed_pi_fails_create_in_seconds_not_a_minute() {
    let started = std::time::Instant::now();
    let (daemon, ws) = pi_daemon(Some("boot-crash")).await;
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "pi-create", "harness": "pi", "workspace": ws.path()})),
    )
    .await;
    assert_eq!(created.status, 201, "raw: {}", created.raw);
    let id = created.body["id"].as_str().expect("session id").to_string();

    // The session lands failed with the exit status and the CLI's dying
    // words - never a hang, never a Working-forever create.
    let events = until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;
    let failure = events
        .iter()
        .find(|(_, p)| kind(p) == "session.status_changed")
        .expect("the terminal status");
    assert_eq!(failure.1["status"], "failed", "events:\n{}", dump(&events));
    let reason = failure.1["reason"].as_str().unwrap_or_default();
    assert!(
        reason.contains("exited during get_state"),
        "the failure names the handshake step; got: {reason}"
    );
    assert!(
        reason.contains("crashed at boot"),
        "the CLI's dying stderr rides the failure; got: {reason}"
    );
    // The patience bound: the old code burned the full 60s call
    // timeout. Fail in seconds.
    assert!(
        started.elapsed() < std::time::Duration::from_secs(20),
        "create took {:?} - the death race did not fire",
        started.elapsed()
    );
    let session = call(&daemon, "GET", &format!("/sessions/{id}"), None).await;
    assert_eq!(session.body["status"], "failed", "raw: {}", session.raw);
}
