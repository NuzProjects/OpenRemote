//! The models route e2e: the answers `GET /harnesses/{id}/models` can
//! give, told apart on the wire. A failed probe used to collapse into
//! `[]` - byte-identical to "this harness advertises no models" - and
//! the route's contract told the console to cache it.

mod common;

use common::*;
use serde_json::json;

#[tokio::test]
async fn a_catalog_and_an_empty_advertisement_are_both_real_answers() {
    // Every slot on the fixture: claude's initialize handshake answers
    // a catalog; pi and opencode advertise nothing through us.
    let daemon = start_daemon(&[]).await;

    // The success shape: claude's handshake answers the fixture's own
    // catalog, real rows on the wire.
    let claude = call(&daemon, "GET", "/harnesses/claude/models", None).await;
    assert_eq!(claude.status, 200, "raw: {}", claude.raw);
    let list = claude.body.as_array().expect("a catalog array");
    assert!(
        !list.is_empty() && list.iter().all(|m| m["model"].as_str().is_some()),
        "the fixture's catalog rows: {list:?}"
    );

    // The genuine-empty shape: pi and opencode answer a real empty list
    // (the slot stays reserved), never a failure and never null.
    for id in ["pi", "opencode"] {
        let empty = call(&daemon, "GET", &format!("/harnesses/{id}/models"), None).await;
        assert_eq!(empty.status, 200, "raw: {}", empty.raw);
        assert_eq!(
            empty.body,
            json!([]),
            "an empty advertisement is an empty list: {}",
            empty.raw
        );
    }
}

#[tokio::test]
async fn a_probe_that_cannot_spawn_answers_503_and_a_later_ask_can_heal() {
    // A file that is no CLI at all: resolution accepts it (it exists on
    // disk), the spawn the probe needs fails - the transient class that
    // used to collapse into `[]`.
    let dir = tempfile::tempdir().expect("temp dir");
    let not_a_cli = dir.path().join("not-a-cli");
    std::fs::write(&not_a_cli, "this is no executable\n").expect("junk file");
    let daemon = start_daemon(&[("agy", not_a_cli.clone())]).await;

    let failed = call(&daemon, "GET", "/harnesses/agy/models", None).await;
    assert_eq!(failed.status, 503, "raw: {}", failed.raw);
    assert!(
        failed.body["error"].as_str().is_some_and(|e| !e.is_empty()),
        "the error body says what failed: {}",
        failed.raw
    );
    // Nothing about the answer can be mistaken for a catalog.
    assert!(failed.body.as_array().is_none(), "raw: {}", failed.raw);

    // The failure is per-harness: the fixture-backed codex beside it
    // still answers its own catalog.
    let codex = call(&daemon, "GET", "/harnesses/codex/models", None).await;
    assert_eq!(codex.status, 200, "raw: {}", codex.raw);
    assert!(codex.body.as_array().is_some_and(|l| !l.is_empty()));

    // 503 is a promise that a later ask may succeed: put a real CLI at
    // the same path and the same route flips to the catalog it prints.
    std::fs::copy(fixture_agent(), &not_a_cli).expect("swap in a real CLI");
    let healed = call(&daemon, "GET", "/harnesses/agy/models", None).await;
    assert_eq!(healed.status, 200, "raw: {}", healed.raw);
    let ids: Vec<&str> = healed
        .body
        .as_array()
        .expect("the catalog")
        .iter()
        .map(|m| m["model"].as_str().expect("model id"))
        .collect();
    assert_eq!(
        ids,
        vec![
            "gemini-3.8-flash-high",
            "gemini-3.8-flash-medium",
            "claude-sonnet-4-6"
        ],
        "the fixture's TSV catalog: {}",
        healed.raw
    );
}

#[tokio::test]
async fn a_cli_that_refuses_answers_503_not_no_models() {
    // The not-signed-in class: the spawn succeeds, the CLI refuses by
    // exiting nonzero - and a refusal must not read as "no models".
    let dir = tempfile::tempdir().expect("temp dir");
    let name = if cfg!(windows) {
        "refuses.cmd"
    } else {
        "refuses"
    };
    let script = dir.path().join(name);
    if cfg!(windows) {
        std::fs::write(&script, "@echo off\r\nexit /b 1\r\n").expect("refusing script");
    } else {
        std::fs::write(&script, "#!/bin/sh\nexit 1\n").expect("refusing script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .expect("executable script");
        }
    }
    let daemon = start_daemon(&[("claude", script)]).await;
    let failed = call(&daemon, "GET", "/harnesses/claude/models", None).await;
    assert_eq!(failed.status, 503, "raw: {}", failed.raw);
    assert!(
        failed.body.as_array().is_none(),
        "a refusal is not a catalog: {}",
        failed.raw
    );
}

#[tokio::test]
async fn a_harness_that_cannot_be_asked_answers_its_own_error() {
    // No slot fills an unknown id, and an override pointing at a file
    // that isn't there leaves the harness not installed: each is its own
    // error (the sign-in route's words), never an empty advertisement.
    let dir = tempfile::tempdir().expect("temp dir");
    let daemon = start_daemon(&[("grok", dir.path().join("no-such-cli"))]).await;

    let unknown = call(&daemon, "GET", "/harnesses/zzz/models", None).await;
    assert_eq!(unknown.status, 400, "raw: {}", unknown.raw);
    assert!(
        unknown.body["error"]
            .as_str()
            .is_some_and(|e| e.contains("is not known")),
        "raw: {}",
        unknown.raw
    );

    let not_installed = call(&daemon, "GET", "/harnesses/grok/models", None).await;
    assert_eq!(not_installed.status, 400, "raw: {}", not_installed.raw);
    assert!(
        not_installed.body["error"]
            .as_str()
            .is_some_and(|e| e.contains("not installed")),
        "raw: {}",
        not_installed.raw
    );
}
