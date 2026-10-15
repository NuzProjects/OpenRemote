//! A message sent while a claude turn is still working. The real CLI
//! folds it into the running turn and answers both at once (one reply,
//! one result), so the chat's record must keep that turn whole: every
//! turn that starts also completes, and a tool's result lands on the
//! turn its start was filed under - or the console shows a turn that
//! never ends and a tool card that never resolves.

mod common;

use common::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn turn_of(event: &Value) -> String {
    match &event["turn"] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => event["message"]["turn"].to_string(),
    }
}

#[tokio::test]
async fn a_message_sent_mid_turn_keeps_the_turn_whole() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let ws = workspace(Some("steer"));
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "st-create", "harness": "claude", "workspace": ws.path()})),
    )
    .await;
    assert_eq!(created.status, 201, "raw: {}", created.raw);
    let id = created.body["id"].as_str().expect("session id").to_string();
    let path = format!("/sessions/{id}/events");

    let first = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "st-p1", "text": "first"})),
    )
    .await;
    assert!(first.status < 300, "raw: {}", first.raw);
    // Mid-flight: the turn's tool has started and nothing has finished.
    until_kinds(&daemon, &path, &["tool.started"]).await;

    let second = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "st-p2", "text": "second"})),
    )
    .await;
    assert!(second.status < 300, "raw: {}", second.raw);
    until_status(&daemon, &id, &["idle"]).await;
    let events = until_kinds(
        &daemon,
        &path,
        &["turn.completed", "session.status_changed"],
    )
    .await;

    let turns = |k: &str| -> BTreeSet<String> {
        events
            .iter()
            .filter(|(_, e)| kind(e) == k)
            .map(|(_, e)| turn_of(e))
            .collect()
    };
    let started = turns("turn.started");
    let completed = turns("turn.completed");
    assert!(
        started.is_subset(&completed),
        "a turn was left open - started {started:?}, completed {completed:?}\n{}",
        dump(&events)
    );

    let tool_start = events
        .iter()
        .find(|(_, e)| kind(e) == "tool.started")
        .map(|(_, e)| turn_of(e));
    let tool_result = events
        .iter()
        .find(|(_, e)| kind(e) == "tool.result")
        .map(|(_, e)| turn_of(e));
    assert_eq!(
        tool_start,
        tool_result,
        "the tool's result landed on another turn than its start\n{}",
        dump(&events)
    );

    // Both messages are in the record, and the one reply answers both.
    let users = events
        .iter()
        .filter(|(_, e)| kind(e) == "message.added" && e["message"]["role"] == "user")
        .count();
    assert_eq!(users, 2, "{}", dump(&events));
    let reply = events
        .iter()
        .rev()
        .find(|(_, e)| kind(e) == "message.added" && e["message"]["role"] == "assistant")
        .map(|(_, e)| e["message"]["text"].as_str().unwrap_or("").to_string());
    assert_eq!(
        reply.as_deref(),
        Some("done: first + second"),
        "{}",
        dump(&events)
    );
}
