//! Two of an account's devices reach each other end to end through the
//! relay: a desktop drives a machine's API, a desktop that isn't a machine
//! refuses, private chats stay private, and removal ends it.

mod common;

use std::time::Duration;

use common::{TestDaemon, call, raw_http, start_cloud_daemon};
use fake_cloud::FakeCloud;
use openremote_cloud::CloudConfig;
use openremote_cloud::https::Http;
use serde_json::{Value, json};

fn config(cloud: &FakeCloud, name: &str) -> CloudConfig {
    CloudConfig {
        api_base: cloud.api(),
        auth_issuer: cloud.issuer(),
        client_id: openremote_cloud::config::CLIENT_ID.into(),
        device_name: name.into(),
        platform: std::env::consts::OS.into(),
        redirect_uri: None,
    }
}

async fn sign_in(daemon: &TestDaemon) -> String {
    let started = call(daemon, "POST", "/cloud/signin", None).await;
    let url = started.body["authorize_url"].as_str().unwrap().to_string();
    let page = Http::new().request("GET", &url, &[], None).await.unwrap();
    let location = page.headers["location"].to_str().unwrap().to_string();
    let (_, rest) = location.split_once("/cloud/callback").unwrap();
    let landed = raw_http(daemon, "GET", &format!("/cloud/callback{rest}"), &[], None).await;
    assert_eq!(landed.status, 200, "{}", landed.raw);
    call(daemon, "GET", "/cloud", None).await.body["device"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Polls `check` until it returns Some, for up to ten seconds.
async fn until<T, F, Fut>(what: &str, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    for _ in 0..100 {
        if let Some(v) = check().await {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn sees(daemon: &TestDaemon, id: &str, field: &str, want: Value) -> Option<()> {
    let devices = call(daemon, "GET", "/cloud/devices", None).await.body;
    devices["devices"]
        .as_array()?
        .iter()
        .any(|d| d["id"] == id && d[field] == want)
        .then_some(())
}

#[tokio::test]
async fn a_desktop_drives_a_machine_through_the_relay_and_nothing_more() {
    let cloud = FakeCloud::start().await;
    let a = start_cloud_daemon(&[], Some(config(&cloud, "desk-a"))).await;
    let b = start_cloud_daemon(&[], Some(config(&cloud, "desk-b"))).await;
    let id_a = sign_in(&a).await;
    let id_b = sign_in(&b).await;

    until("a sees b online", || sees(&a, &id_b, "online", json!(true))).await;
    until("b sees a online", || sees(&b, &id_a, "online", json!(true))).await;
    assert_eq!(
        call(&a, "GET", "/cloud", None).await.body["state"],
        "online"
    );

    // A desktop that isn't a machine refuses to be driven.
    let refused = call(&a, "GET", &format!("/devices/{id_b}/capabilities"), None).await;
    assert_eq!(refused.status, 409, "{}", refused.raw);
    assert_eq!(refused.body["code"], "not_a_machine");

    // Made a machine from the other desktop, it answers with its own API.
    let made = call(
        &a,
        "POST",
        &format!("/cloud/devices/{id_b}/kind"),
        Some(json!({"kind": "machine"})),
    )
    .await;
    assert_eq!(made.status, 200, "{}", made.raw);
    until("b knows it is a machine", || {
        sees(&b, &id_b, "kind", json!("machine"))
    })
    .await;
    let caps = call(&a, "GET", &format!("/devices/{id_b}/capabilities"), None).await;
    assert_eq!(caps.status, 200, "{}", caps.raw);
    assert!(caps.body["harnesses"].is_array(), "{}", caps.raw);
    let dirs = call(&a, "GET", &format!("/devices/{id_b}/fs/dirs"), None).await;
    assert_eq!(dirs.status, 200, "{}", dirs.raw);
    assert!(dirs.body["dirs"].is_array());

    // Only what the allowlist names reaches a peer; Cloud's own routes
    // aren't even routed for one.
    for path in ["plugins", "automations", "sessions", "receipts/x"] {
        let denied = call(&a, "GET", &format!("/devices/{id_b}/{path}"), None).await;
        assert_eq!(denied.status, 403, "{path}: {}", denied.raw);
    }
    let cloud_route = call(&a, "GET", &format!("/devices/{id_b}/cloud"), None).await;
    assert_eq!(cloud_route.status, 404, "{}", cloud_route.raw);

    // A private chat on the machine never shows up for the other device.
    let ws = common::workspace(None);
    let private = call(
        &b,
        "POST",
        "/sessions",
        Some(json!({"request_id": uuid::Uuid::new_v4().to_string(), "harness": "claude", "workspace": ws.path()})),
    )
    .await;
    assert_eq!(private.status, 201, "{}", private.raw);
    let machines = call(&a, "GET", &format!("/devices/{id_b}/machines"), None).await;
    assert_eq!(machines.status, 200, "{}", machines.raw);
    assert_eq!(
        machines.body[0]["sessions"],
        json!([]),
        "private chats stay private"
    );
    let own = call(&b, "GET", "/machines", None).await;
    assert_eq!(own.body[0]["sessions"].as_array().map(Vec::len), Some(1));

    let stranger = call(
        &a,
        "GET",
        &format!("/devices/{}/capabilities", uuid::Uuid::new_v4()),
        None,
    )
    .await;
    assert_eq!(stranger.status, 404, "{}", stranger.raw);

    // Removing the machine from the other desktop ends it there: its synced
    // chats would go, and its private chat stays.
    let removed = call(&a, "DELETE", &format!("/cloud/devices/{id_b}"), None).await;
    assert_eq!(removed.status, 204, "{}", removed.raw);
    until("b learns it was removed", || async {
        (call(&b, "GET", "/cloud", None).await.body["state"] == "revoked").then_some(())
    })
    .await;
    assert_eq!(
        call(&b, "GET", "/sessions", None)
            .await
            .body
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    let gone = call(&a, "GET", &format!("/devices/{id_b}/capabilities"), None).await;
    assert_ne!(gone.status, 200);
}

/// A removed desktop signs back in and its mesh comes back. The removal
/// ends the relay loop for good (the relay closes with the removed code);
/// the slot that loop filled must be released, or the sign-in's own
/// `start` finds it occupied and this device stays silent until a process
/// restart - the re-sign-in joins as a new device, and the mesh request
/// that worked before the removal works again after it.
#[tokio::test]
async fn a_removed_device_signs_back_in_and_the_mesh_returns() {
    let cloud = FakeCloud::start().await;
    let a = start_cloud_daemon(&[], Some(config(&cloud, "desk-a"))).await;
    let b = start_cloud_daemon(&[], Some(config(&cloud, "desk-b"))).await;
    let id_a = sign_in(&a).await;
    let id_b = sign_in(&b).await;

    until("a sees b online", || sees(&a, &id_b, "online", json!(true))).await;
    let made = call(
        &a,
        "POST",
        &format!("/cloud/devices/{id_b}/kind"),
        Some(json!({"kind": "machine"})),
    )
    .await;
    assert_eq!(made.status, 200, "{}", made.raw);
    until("b knows it is a machine", || {
        sees(&b, &id_b, "kind", json!("machine"))
    })
    .await;
    let caps = call(&a, "GET", &format!("/devices/{id_b}/capabilities"), None).await;
    assert_eq!(
        caps.status, 200,
        "the mesh works before the removal: {}",
        caps.raw
    );

    // The other desktop removes it: its relay loop stops for good.
    let removed = call(&a, "DELETE", &format!("/cloud/devices/{id_b}"), None).await;
    assert_eq!(removed.status, 204, "{}", removed.raw);
    until("b learns it was removed", || async {
        (call(&b, "GET", "/cloud", None).await.body["state"] == "revoked").then_some(())
    })
    .await;

    // Signing back in (as the new device a removed one becomes) brings
    // the mesh back in the same process: the dead run must not hold it.
    let id_b2 = sign_in(&b).await;
    assert_ne!(id_b2, id_b, "a removed device joins as a new one");
    until("b is online again", || async {
        (call(&b, "GET", "/cloud", None).await.body["state"] == "online").then_some(())
    })
    .await;
    until("b sees a online again", || {
        sees(&b, &id_a, "online", json!(true))
    })
    .await;
    until("a sees the new device online", || {
        sees(&a, &id_b2, "online", json!(true))
    })
    .await;

    let made = call(
        &a,
        "POST",
        &format!("/cloud/devices/{id_b2}/kind"),
        Some(json!({"kind": "machine"})),
    )
    .await;
    assert_eq!(made.status, 200, "{}", made.raw);
    until("the new device knows it is a machine", || {
        sees(&b, &id_b2, "kind", json!("machine"))
    })
    .await;
    let caps = call(&a, "GET", &format!("/devices/{id_b2}/capabilities"), None).await;
    assert_eq!(caps.status, 200, "the mesh works again: {}", caps.raw);
}
