//! The chat's queue: a message sent while a turn is working waits in the
//! daemon and runs as its own turn when that one ends - it never reaches
//! the harness early. An interrupt holds the queue until the user resumes
//! it; Steer takes a message out of the queue and puts it into the
//! running turn now (or, on a harness that runs one process per prompt,
//! interrupts the turn and runs the message next).

mod common;

use common::*;
use serde_json::{Value, json};

async fn session(daemon: &TestDaemon, harness: &str, ws: &tempfile::TempDir) -> String {
    let created = call(
        daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": format!("q-create-{harness}"), "harness": harness, "workspace": ws.path()})),
    )
    .await;
    assert_eq!(created.status, 201, "raw: {}", created.raw);
    created.body["id"].as_str().expect("session id").to_string()
}

async fn post(daemon: &TestDaemon, path: &str, body: Value) -> Reply {
    let reply = call(daemon, "POST", path, Some(body)).await;
    assert!(reply.status < 300, "{path}: {} {}", reply.status, reply.raw);
    reply
}

fn user_texts(events: &[(u64, Value)]) -> Vec<String> {
    events
        .iter()
        .filter(|(_, e)| kind(e) == "message.added" && e["message"]["role"] == "user")
        .map(|(_, e)| e["message"]["text"].as_str().unwrap_or("").to_string())
        .collect()
}

fn replies(events: &[(u64, Value)]) -> Vec<String> {
    events
        .iter()
        .filter(|(_, e)| kind(e) == "message.added" && e["message"]["role"] == "assistant")
        .map(|(_, e)| e["message"]["text"].as_str().unwrap_or("").to_string())
        .collect()
}

fn queue_len(session: &Value) -> usize {
    session["queue"].as_array().map(|q| q.len()).unwrap_or(0)
}

#[tokio::test]
async fn a_queued_message_waits_for_the_turn_then_runs_as_its_own() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let ws = workspace(Some("slow"));
    let id = session(&daemon, "claude", &ws).await;
    let path = format!("/sessions/{id}/events");

    post(
        &daemon,
        &format!("/sessions/{id}/prompts"),
        json!({"request_id": "q1-p", "text": "first"}),
    )
    .await;
    until_kinds(&daemon, &path, &["tool.started"]).await;
    post(
        &daemon,
        &format!("/sessions/{id}/queue"),
        json!({"request_id": "q1-a", "text": "second"}),
    )
    .await;
    let third = post(
        &daemon,
        &format!("/sessions/{id}/queue"),
        json!({"request_id": "q1-b", "text": "third"}),
    )
    .await;

    // Both wait in the daemon; the harness has seen only the first.
    let now = call(&daemon, "GET", &format!("/sessions/{id}"), None)
        .await
        .body;
    assert_eq!(queue_len(&now), 2, "{now}");
    let so_far = until_count(&daemon, &path, "queue.changed", 2).await;
    assert_eq!(user_texts(&so_far), vec!["first"], "{}", dump(&so_far));

    // Removing one leaves the other to run.
    let third_id = third.body["result"]["queue"][1]["id"]
        .as_str()
        .expect("queued id")
        .to_string();
    post(
        &daemon,
        &format!("/sessions/{id}/queue/{third_id}/remove"),
        json!({"request_id": "q1-r"}),
    )
    .await;

    let events = until_count(&daemon, &path, "turn.completed", 2).await;
    until_status(&daemon, &id, &["idle"]).await;
    assert_eq!(
        user_texts(&events),
        vec!["first", "second"],
        "{}",
        dump(&events)
    );
    assert_eq!(
        replies(&events),
        vec!["done: first", "done: second"],
        "{}",
        dump(&events)
    );
    // The queued message opened its own turn after the first one ended.
    let kinds: Vec<String> = events.iter().map(|(_, e)| kind(e)).collect();
    let first_end = kinds
        .iter()
        .position(|k| k == "turn.completed")
        .expect("first end");
    let second_start = kinds
        .iter()
        .rposition(|k| k == "turn.started")
        .expect("second start");
    assert!(second_start > first_end, "{}", dump(&events));
    let after = call(&daemon, "GET", &format!("/sessions/{id}"), None)
        .await
        .body;
    assert_eq!(queue_len(&after), 0, "{after}");
}

#[tokio::test]
async fn an_interrupt_holds_the_queue_until_resume() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let ws = workspace(Some("slow"));
    let id = session(&daemon, "claude", &ws).await;
    let path = format!("/sessions/{id}/events");

    post(
        &daemon,
        &format!("/sessions/{id}/prompts"),
        json!({"request_id": "q2-p", "text": "first"}),
    )
    .await;
    until_kinds(&daemon, &path, &["tool.started"]).await;
    post(
        &daemon,
        &format!("/sessions/{id}/queue"),
        json!({"request_id": "q2-a", "text": "second"}),
    )
    .await;
    post(
        &daemon,
        &format!("/sessions/{id}/interrupt"),
        json!({"request_id": "q2-i"}),
    )
    .await;
    until_count(&daemon, &path, "turn.completed", 1).await;
    let held = until_status(&daemon, &id, &["idle"]).await;
    assert_eq!(held["queue_paused"], true, "{held}");
    assert_eq!(queue_len(&held), 1, "{held}");

    // Held: the turn's end did not fire it - it is still in the queue
    // (checked above, after the turn ended), and nothing new was sent.

    post(
        &daemon,
        &format!("/sessions/{id}/queue/resume"),
        json!({"request_id": "q2-r"}),
    )
    .await;
    let events = until_count(&daemon, &path, "turn.completed", 2).await;
    assert_eq!(
        user_texts(&events),
        vec!["first", "second"],
        "{}",
        dump(&events)
    );
    let after = until_status(&daemon, &id, &["idle"]).await;
    assert_eq!(queue_len(&after), 0, "{after}");
    assert!(
        after.get("queue_paused").is_none() || after["queue_paused"] == false,
        "{after}"
    );
}

#[tokio::test]
async fn steering_a_queued_message_puts_it_into_the_running_claude_turn() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    // The fixture folds a mid-turn message into its open turn, like the
    // real CLI, and answers both at once.
    let ws = workspace(Some("steer"));
    let id = session(&daemon, "claude", &ws).await;
    let path = format!("/sessions/{id}/events");

    post(
        &daemon,
        &format!("/sessions/{id}/prompts"),
        json!({"request_id": "q3-p", "text": "first"}),
    )
    .await;
    until_kinds(&daemon, &path, &["tool.started"]).await;
    let queued = post(
        &daemon,
        &format!("/sessions/{id}/queue"),
        json!({"request_id": "q3-a", "text": "second"}),
    )
    .await;
    let item = queued.body["result"]["queue"][0]["id"]
        .as_str()
        .expect("queued id")
        .to_string();
    post(
        &daemon,
        &format!("/sessions/{id}/queue/{item}/steer"),
        json!({"request_id": "q3-s"}),
    )
    .await;

    let events = until_count(&daemon, &path, "turn.completed", 1).await;
    until_status(&daemon, &id, &["idle"]).await;
    assert_eq!(
        user_texts(&events),
        vec!["first", "second"],
        "{}",
        dump(&events)
    );
    assert_eq!(
        replies(&events),
        vec!["done: first + second"],
        "{}",
        dump(&events)
    );
    // One turn: the steered message joined it.
    let started = events
        .iter()
        .filter(|(_, e)| kind(e) == "turn.started")
        .count();
    assert_eq!(started, 1, "{}", dump(&events));
    let after = call(&daemon, "GET", &format!("/sessions/{id}"), None)
        .await
        .body;
    assert_eq!(queue_len(&after), 0, "{after}");
}

#[tokio::test]
async fn steer_on_a_one_process_per_prompt_harness_interrupts_and_runs_next() {
    let daemon = start_daemon(&[("grok", fixture_agent())]).await;
    let ws = workspace(Some("slow"));
    let id = session(&daemon, "grok", &ws).await;
    let path = format!("/sessions/{id}/events");

    post(
        &daemon,
        &format!("/sessions/{id}/prompts"),
        json!({"request_id": "q4-p", "text": "first"}),
    )
    .await;
    until_status(&daemon, &id, &["working"]).await;
    post(
        &daemon,
        &format!("/sessions/{id}/steer"),
        json!({"request_id": "q4-s", "text": "second"}),
    )
    .await;

    let events = until_count(&daemon, &path, "turn.completed", 2).await;
    until_status(&daemon, &id, &["idle"]).await;
    assert_eq!(
        user_texts(&events),
        vec!["first", "second"],
        "{}",
        dump(&events)
    );
    // The first turn was cut short for the steer; only the second answered.
    assert_eq!(replies(&events), vec!["done: second"], "{}", dump(&events));
    let after = call(&daemon, "GET", &format!("/sessions/{id}"), None)
        .await
        .body;
    assert!(
        after.get("queue_paused").is_none() || after["queue_paused"] == false,
        "{after}"
    );
}
