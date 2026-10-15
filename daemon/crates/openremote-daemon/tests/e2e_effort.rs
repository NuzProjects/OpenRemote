//! The effort a chat was given rides every start of its harness - the
//! first spawn and every resume - through the harness's own start-time
//! path: claude `--effort`, codex's `model_reasoning_effort` config
//! override, pi's `set_thinking_level`. The fixtures record what they
//! were handed in the workspace, so the test reads the harness's side.

mod common;

use common::*;
use serde_json::json;

fn lines(ws: &tempfile::TempDir, file: &str) -> Vec<String> {
    std::fs::read_to_string(ws.path().join(file))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

/// Create with an effort, run a turn, stop, resume, run another turn.
async fn start_stop_resume(daemon: &TestDaemon, ws: &tempfile::TempDir, harness: &str) {
    let created = call(
        daemon,
        "POST",
        "/sessions",
        Some(json!({
            "request_id": format!("ef-create-{harness}"),
            "harness": harness,
            "workspace": ws.path(),
            "effort": "high",
        })),
    )
    .await;
    assert_eq!(created.status, 201, "raw: {}", created.raw);
    let id = created.body["id"].as_str().expect("session id").to_string();
    let path = format!("/sessions/{id}/events");
    call(
        daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": format!("ef-p1-{harness}"), "text": "first"})),
    )
    .await;
    until_count(daemon, &path, "turn.completed", 1).await;
    let stopped = call(
        daemon,
        "POST",
        &format!("/sessions/{id}/stop"),
        Some(json!({"request_id": format!("ef-stop-{harness}")})),
    )
    .await;
    assert_eq!(stopped.status, 200, "raw: {}", stopped.raw);
    let resumed = call(
        daemon,
        "POST",
        &format!("/sessions/{id}/resume"),
        Some(json!({"request_id": format!("ef-resume-{harness}")})),
    )
    .await;
    assert_eq!(resumed.status, 200, "raw: {}", resumed.raw);
    call(
        daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": format!("ef-p2-{harness}"), "text": "second"})),
    )
    .await;
    until_count(daemon, &path, "turn.completed", 2).await;
}

#[tokio::test]
async fn claude_starts_and_resumes_with_the_chats_effort() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let ws = workspace(Some("plain"));
    start_stop_resume(&daemon, &ws, "claude").await;
    let spawns = lines(&ws, "fixture-claude-argv");
    assert!(spawns.len() >= 2, "a start and a resume: {spawns:?}");
    for argv in &spawns {
        assert!(
            argv.contains("--effort high"),
            "every start carries the effort: {spawns:?}"
        );
    }
    assert!(spawns.iter().any(|a| a.contains("--resume")), "{spawns:?}");
}

#[tokio::test]
async fn codex_starts_and_resumes_with_the_chats_effort() {
    let daemon = start_daemon(&[("claude", fixture_agent()), ("codex", fixture_agent())]).await;
    let ws = workspace(Some("plain"));
    start_stop_resume(&daemon, &ws, "codex").await;
    assert_eq!(
        lines(&ws, "fixture-codex-starts"),
        vec!["thread/start effort=high", "thread/resume effort=high"],
    );
}

#[tokio::test]
async fn pi_starts_and_resumes_with_the_chats_effort() {
    let daemon = start_daemon(&[
        ("claude", fixture_agent()),
        ("codex", fixture_agent()),
        ("grok", fixture_agent()),
        ("pi", fixture_agent()),
    ])
    .await;
    let ws = workspace(Some("plain"));
    start_stop_resume(&daemon, &ws, "pi").await;
    assert_eq!(lines(&ws, "fixture-pi-thinking"), vec!["high", "high"]);
}
