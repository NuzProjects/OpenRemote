//! The browser across the user's devices, over the Cloud stand-in: an
//! agent's tabs open where the user last wrote from, other devices' tabs
//! are listed and used by device-qualified names, and a tab is shown live
//! on another device with only the controller's input reaching it. Each
//! device's browser here is a stand-in that answers the daemon's calls.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use common::cloud::{config, device, sees, sign_in, until};
use common::{call, start_embedded};
use fake_cloud::FakeCloud;
use openremote_browser::{Call, Caps, FromHost, Input, TabInfo, ToHost};
use openremote_core::DeviceId;
use openremote_daemon::app::App;
use openremote_daemon::browser::Chat;
use serde_json::{Value, json};

const FRAMES: &[&[u8]] = &[b"\xff\xd8first", b"\xff\xd8second", b"\xff\xd8third"];

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A device's browser as the daemon reaches it: answers calls, and plays
/// the engine's pictures when asked to cast, one per acknowledgement.
struct Browser {
    calls: Arc<Mutex<Vec<Call>>>,
}

impl Browser {
    fn saw(&self, want: impl Fn(&Call) -> bool) -> bool {
        self.calls.lock().unwrap().iter().any(want)
    }
}

fn tab(id: &str, url: &str, title: &str, private: bool) -> FromHost {
    FromHost::Tab {
        tab: TabInfo {
            id: id.into(),
            url: url.into(),
            title: title.into(),
            private,
            ..Default::default()
        },
    }
}

fn attach(app: &Arc<App>, live: bool, tabs: Vec<FromHost>) -> Browser {
    let calls: Arc<Mutex<Vec<Call>>> = Arc::default();
    let log = Arc::clone(&calls);
    let weak = Arc::downgrade(app);
    let cast = Arc::new(Mutex::new(0usize));
    app.browser.set_hosted();
    app.browser.connect(Arc::new(move |m: ToHost| {
        log.lock().unwrap().push(m.call.clone());
        let Some(app) = weak.upgrade() else { return };
        let ok = |value: Value| FromHost::Reply {
            id: m.id,
            ok: Some(value),
            error: None,
        };
        let page = json!({"url": "https://example.com/", "title": "Example"});
        let reply = match &m.call {
            Call::Open { url, controller } => ok(serde_json::to_value(TabInfo {
                id: "tab-9".into(),
                url: url.clone(),
                title: "Opened".into(),
                controller: controller.clone(),
                ..Default::default()
            })
            .unwrap()),
            Call::Snapshot { .. } => ok(json!({
                "text": "- heading \"Example\"",
                "url": "https://example.com/",
                "title": "Example",
            })),
            Call::Click { target, .. } => {
                let mut answer = page.clone();
                answer["text"] = json!(format!("Clicked {target}."));
                ok(answer)
            }
            Call::Screencast { tab, on: true, .. } => {
                // The first picture comes with the cast, as the shell sends one.
                *cast.lock().unwrap() = 1;
                app.browser.receive(ok(json!({})));
                app.browser.receive(FromHost::Frame {
                    tab: tab.clone(),
                    data: b64(FRAMES[0]),
                    width: 1280.0,
                    height: 800.0,
                });
                return;
            }
            Call::FrameAck { tab } => {
                // The engine paints the next picture once let go.
                let mut sent = cast.lock().unwrap();
                if *sent < FRAMES.len() {
                    let data = b64(FRAMES[*sent]);
                    *sent += 1;
                    drop(sent);
                    app.browser.receive(FromHost::Frame {
                        tab: tab.clone(),
                        data,
                        width: 1280.0,
                        height: 800.0,
                    });
                }
                return;
            }
            Call::Input { .. } => ok(json!({"editable": true})),
            Call::Mark { .. } | Call::Screencast { .. } => return,
            other => FromHost::Reply {
                id: m.id,
                ok: None,
                error: Some(format!("the stand-in can't {other:?}")),
            },
        };
        app.browser.receive(reply);
    }));
    app.browser.receive(FromHost::Hello {
        engine: "stand-in".into(),
        caps: Caps {
            live,
            ..Caps::default()
        },
    });
    for t in tabs {
        app.browser.receive(t);
    }
    Browser { calls }
}

fn chat(id: &str) -> Chat {
    Chat {
        id: id.into(),
        title: "Fix the login".into(),
        workspace: None,
    }
}

fn text(result: &Value) -> String {
    result["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn device_id(id: &str) -> DeviceId {
    DeviceId::parse(id).expect("a device id")
}

#[tokio::test]
async fn an_agents_tabs_open_where_the_user_is_and_other_devices_tabs_are_used_by_name() {
    let cloud = FakeCloud::start().await;
    let (here, here_app) = start_embedded(config(&cloud, "Machine")).await;
    sign_in(&here).await;
    let (there, there_app) = start_embedded(config(&cloud, "Pixel 8")).await;
    let there_id = sign_in(&there).await;
    let (_bare, bare_id) = device(&cloud, "Laptop").await;
    until("the machine sees the phone online", || {
        sees(&here, &there_id, "online", json!(true))
    })
    .await;
    until("the machine sees the laptop online", || {
        sees(&here, &bare_id, "online", json!(true))
    })
    .await;

    let mine = attach(
        &here_app,
        true,
        vec![tab("tab-1", "https://mine.test/", "Mine", false)],
    );
    let phone = attach(
        &there_app,
        false,
        vec![
            tab("tab-1", "https://example.com/", "Example", false),
            tab("tab-2", "https://secret.test/", "Secret", true),
        ],
    );

    // Where the user last wrote from decides where a new tab opens.
    let browser = &here_app.browser;
    browser.note_origin("chat-1", Some(device_id(&there_id)));
    let listed = text(
        &browser
            .run_tool(&chat("chat-1"), "browser_tabs", &json!({}))
            .await,
    );
    assert!(listed.contains("On Pixel 8"), "{listed}");
    assert!(listed.contains("pixel-8:tab-1"), "{listed}");
    assert!(
        !listed.contains("secret.test"),
        "a private tab is never listed: {listed}"
    );
    assert!(listed.contains("New tabs open on Pixel 8"), "{listed}");

    let opened = text(
        &browser
            .run_tool(
                &chat("chat-1"),
                "browser_tab_open",
                &json!({"url": "https://example.org/"}),
            )
            .await,
    );
    assert!(opened.contains("Opened on Pixel 8"), "{opened}");
    assert!(
        phone.saw(|c| matches!(c, Call::Open { url, .. } if url == "https://example.org/")),
        "the tab opened on the phone"
    );

    // An address on the machine itself stays on the machine, and says why.
    let local = text(
        &browser
            .run_tool(
                &chat("chat-1"),
                "browser_tab_open",
                &json!({"url": "localhost:3000"}),
            )
            .await,
    );
    assert!(local.contains("only works on this computer"), "{local}");
    assert!(
        mine.saw(|c| matches!(c, Call::Open { url, .. } if url == "http://localhost:3000")),
        "the dev server opened on the machine"
    );

    // A device with no browser open can't take it: the machine does, and
    // the result says so.
    browser.note_origin("chat-2", Some(device_id(&bare_id)));
    let fallback = text(
        &browser
            .run_tool(
                &chat("chat-2"),
                "browser_tab_open",
                &json!({"url": "https://example.net/"}),
            )
            .await,
    );
    assert!(fallback.contains("isn't available right now"), "{fallback}");
    assert!(
        mine.saw(|c| matches!(c, Call::Open { url, .. } if url == "https://example.net/")),
        "the tab opened on the machine instead"
    );

    // A tab on another device is used by its qualified name, over there.
    let seen = text(
        &browser
            .run_tool(
                &chat("chat-1"),
                "browser_snapshot",
                &json!({"tab": "pixel-8:tab-1"}),
            )
            .await,
    );
    assert!(
        seen.starts_with("[pixel-8:tab-1] https://example.com/"),
        "{seen}"
    );
    assert!(
        seen.contains("<page>"),
        "page text is marked as the page's: {seen}"
    );
    assert!(phone.saw(|c| matches!(c, Call::Snapshot { tab } if tab == "tab-1")));

    // Acting there holds the tab for the chat; the user taking it over on
    // that device refuses the agent, as it would on its own.
    let click = browser
        .run_tool(
            &chat("chat-1"),
            "browser_click",
            &json!({"tab": "pixel-8:tab-1", "ref": "e1", "element": "Go"}),
        )
        .await;
    assert!(click["isError"].is_null(), "{click}");
    assert!(there_app.browser.control("tab-1", "take_over").is_ok());
    let refused = browser
        .run_tool(
            &chat("chat-1"),
            "browser_click",
            &json!({"tab": "pixel-8:tab-1", "ref": "e1", "element": "Go"}),
        )
        .await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(text(&refused).contains("taken over"), "{refused}");

    // Files only go into tabs on the machine that has the chat's folder.
    let upload = browser
        .run_tool(
            &chat("chat-1"),
            "browser_upload",
            &json!({"tab": "pixel-8:tab-1", "ref": "e1", "element": "Pick", "paths": ["a.txt"]}),
        )
        .await;
    assert_eq!(upload["isError"], true, "{upload}");

    // What another device may ask of a browser is only its Browser routes,
    // and never a private tab.
    let upload_call = call(
        &here,
        "POST",
        &format!("/devices/{there_id}/browser/rpc"),
        Some(json!({"chat": {"id": "c", "title": "t"}, "call": {"op": "upload", "tab": "tab-1", "target": "e1", "paths": []}})),
    )
    .await;
    assert_eq!(upload_call.status, 403, "{}", upload_call.raw);
    let private = call(
        &here,
        "POST",
        &format!("/devices/{there_id}/browser/rpc"),
        Some(
            json!({"chat": {"id": "c", "title": "t"}, "call": {"op": "snapshot", "tab": "tab-2"}}),
        ),
    )
    .await;
    assert_eq!(private.status, 404, "{}", private.raw);
    let none = call(
        &here,
        "GET",
        &format!("/devices/{bare_id}/browser/tabs"),
        None,
    )
    .await;
    assert_eq!(none.status, 409, "a device with no browser: {}", none.raw);
}

#[tokio::test]
async fn a_tab_is_shown_live_on_another_device_and_only_its_controller_reaches_the_page() {
    let cloud = FakeCloud::start().await;
    let (viewer, _viewer_app) = start_embedded(config(&cloud, "Pixel 8")).await;
    let _viewer_id = sign_in(&viewer).await;
    let (source, source_app) = start_embedded(config(&cloud, "Desktop")).await;
    let source_id = sign_in(&source).await;
    until("the phone sees the desktop online", || {
        sees(&viewer, &source_id, "online", json!(true))
    })
    .await;
    let desktop = attach(
        &source_app,
        true,
        vec![
            tab("tab-1", "https://example.com/", "Example", false),
            tab("tab-2", "https://secret.test/", "Secret", true),
        ],
    );

    // The other devices' tabs, for the lists: live-capable only, no private ones.
    let listed = call(&viewer, "GET", "/browser/remote", None).await;
    assert_eq!(listed.status, 200, "{}", listed.raw);
    let devices = listed.body["devices"].as_array().unwrap();
    assert_eq!(devices.len(), 1, "{}", listed.raw);
    assert_eq!(devices[0]["live"], true);
    assert_eq!(devices[0]["tabs"].as_array().unwrap().len(), 1);

    // A private tab is not there to show.
    let secret = call(
        &viewer,
        "POST",
        "/browser/live",
        Some(json!({"device": source_id, "tab": "tab-2"})),
    )
    .await;
    assert_eq!(secret.status, 404, "{}", secret.raw);

    // The first picture is waiting when the view opens (it can beat the answer).
    let started = call(
        &viewer,
        "POST",
        "/browser/live",
        Some(json!({"device": source_id, "tab": "tab-1", "network": "wifi", "width": 800})),
    )
    .await;
    assert_eq!(started.status, 200, "{}", started.raw);
    let id = started.body["id"].as_str().unwrap().to_string();
    let first = next(&viewer, &id, 0, 0).await;
    assert_eq!(first["data"], b64(FRAMES[0]));
    assert_eq!(first["width"], 1280.0);
    assert_eq!(first["control"], false);
    assert!(desktop.saw(|c| matches!(c, Call::Screencast { on: true, .. })));

    // Taking the picture lets the engine paint the next; the newest wins.
    let seq = first["seq"].as_u64().unwrap();
    let mut latest = first.clone();
    let mut after = seq;
    for _ in 0..30 {
        let more = next(&viewer, &id, after, 0).await;
        if more["data"].is_string() {
            after = more["seq"].as_u64().unwrap();
            latest = more;
            if latest["data"] == b64(FRAMES[FRAMES.len() - 1]) {
                break;
            }
        }
    }
    assert_eq!(latest["data"], b64(FRAMES[FRAMES.len() - 1]));
    assert!(desktop.saw(|c| matches!(c, Call::FrameAck { .. })));

    // Without control nothing reaches the page.
    let tap = call(
        &viewer,
        "POST",
        &format!("/browser/live/{id}/input"),
        Some(json!({"kind": "click", "x": 10, "y": 20})),
    )
    .await;
    assert_eq!(tap.status, 409, "{}", tap.raw);

    let taken = call(
        &viewer,
        "POST",
        &format!("/browser/live/{id}/control"),
        Some(json!({"take": true})),
    )
    .await;
    assert_eq!(taken.status, 200, "{}", taken.raw);
    assert_eq!(taken.body["control"], true);
    let views = call(&source, "GET", "/browser/views", None).await;
    assert_eq!(
        views.body["viewed"][0]["viewer"], "Pixel 8",
        "{}",
        views.raw
    );
    assert_eq!(views.body["viewed"][0]["control"], true);

    // The user's hand is on the page: an agent on this device can read it
    // but not act in it.
    let local = chat("local");
    let acting = json!({"tab": "tab-1", "ref": "e1", "element": "Go"});
    let refused = source_app
        .browser
        .run_tool(&local, "browser_click", &acting)
        .await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(text(&refused).contains("controlling this tab"), "{refused}");

    let tap = call(
        &viewer,
        "POST",
        &format!("/browser/live/{id}/input"),
        Some(json!({"kind": "click", "x": 10, "y": 20})),
    )
    .await;
    assert_eq!(tap.status, 200, "{}", tap.raw);
    until("the tap reached the page", || async {
        desktop
            .saw(|c| {
                matches!(
                    c,
                    Call::Input { tab, input: Input::Click { x, y, .. } }
                        if tab == "tab-1" && *x == 10.0 && *y == 20.0
                )
            })
            .then_some(())
    })
    .await;

    // The page says a field took the focus: the viewer hears of it.
    let state = until("the viewer hears of the focused field", || async {
        let news = next(&viewer, &id, after, 0).await;
        news["editable"].as_bool().filter(|e| *e).map(|_| news)
    })
    .await;
    assert_eq!(state["control"], true);

    // Letting go gives the page back to the agents.
    let released = call(
        &viewer,
        "POST",
        &format!("/browser/live/{id}/control"),
        Some(json!({"take": false})),
    )
    .await;
    assert_eq!(released.body["control"], false, "{}", released.raw);
    let acted = source_app
        .browser
        .run_tool(&local, "browser_click", &acting)
        .await;
    assert!(acted["isError"].is_null(), "{acted}");

    // Stopping ends the cast.
    let stopped = call(&viewer, "DELETE", &format!("/browser/live/{id}"), None).await;
    assert_eq!(stopped.status, 200);
    until("the cast stopped", || async {
        desktop
            .saw(|c| matches!(c, Call::Screencast { on: false, .. }))
            .then_some(())
    })
    .await;
    let views = call(&source, "GET", "/browser/views", None).await;
    assert!(
        views.body["viewed"].as_array().unwrap().is_empty(),
        "{}",
        views.raw
    );
}

/// The viewer's next news of a view: a picture newer than `after`, or a
/// change of state past `rev`; waits a while for one.
async fn next(viewer: &common::TestDaemon, id: &str, after: u64, rev: u64) -> Value {
    for _ in 0..20 {
        let got = call(
            viewer,
            "GET",
            &format!("/browser/live/{id}/frame?after={after}&rev={rev}"),
            None,
        )
        .await;
        match got.status {
            200 => return got.body,
            204 => tokio::time::sleep(Duration::from_millis(50)).await,
            other => panic!("the live view answered {other}: {}", got.raw),
        }
    }
    panic!("no news of the live view in time");
}
