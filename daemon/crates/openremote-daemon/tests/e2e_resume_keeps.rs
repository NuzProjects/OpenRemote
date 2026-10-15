//! A resumed chat on a harness that runs one process per prompt (grok,
//! agy) continues its own conversation: the resume hands the driver the
//! conversation id, and the next prompt's process is started on it. The
//! fixtures open a fresh conversation unless resumed, so a resume the
//! driver dropped shows as a new id instead of passing by accident.

mod common;

use common::*;
use serde_json::json;

async fn ref_of(daemon: &TestDaemon, id: &str) -> String {
    let session = call(daemon, "GET", &format!("/sessions/{id}"), None).await;
    session.body["harness_session_ref"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

async fn the_resumed_chat_keeps_its_conversation(harness: &str) {
    let daemon = start_daemon(&[
        ("claude", fixture_agent()),
        ("codex", fixture_agent()),
        ("grok", fixture_agent()),
        ("pi", fixture_agent()),
        ("opencode", fixture_agent()),
        ("agy", fixture_agent()),
    ])
    .await;
    let ws = workspace(Some("plain"));
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": format!("rk-create-{harness}"), "harness": harness, "workspace": ws.path()})),
    )
    .await;
    assert_eq!(created.status, 201, "raw: {}", created.raw);
    let id = created.body["id"].as_str().expect("session id").to_string();
    let path = format!("/sessions/{id}/events");

    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": format!("rk-p1-{harness}"), "text": "first"})),
    )
    .await;
    until_count(&daemon, &path, "turn.completed", 1).await;
    let before = ref_of(&daemon, &id).await;
    assert!(!before.is_empty(), "the first turn names the conversation");

    for (step, body) in [("stop", "rk-stop"), ("resume", "rk-resume")] {
        let reply = call(
            &daemon,
            "POST",
            &format!("/sessions/{id}/{step}"),
            Some(json!({"request_id": format!("{body}-{harness}")})),
        )
        .await;
        assert_eq!(reply.status, 200, "{step}: {}", reply.raw);
    }
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": format!("rk-p2-{harness}"), "text": "second"})),
    )
    .await;
    until_count(&daemon, &path, "turn.completed", 2).await;
    assert_eq!(
        ref_of(&daemon, &id).await,
        before,
        "the resumed prompt ran on a new {harness} conversation"
    );
}

#[tokio::test]
async fn a_resumed_grok_chat_keeps_its_conversation() {
    the_resumed_chat_keeps_its_conversation("grok").await;
}

#[tokio::test]
async fn a_resumed_agy_chat_keeps_its_conversation() {
    the_resumed_chat_keeps_its_conversation("agy").await;
}
