//! The QR pairing e2e: a fake phone, over loopback, against a real daemon
//! router and a real pairing listener.
//!
//! The phone half is a second HTTP client: it scans a code (reads it out of
//! the payload the console would draw), trades it for a scoped token, and
//! uses that token. Everything the pairing page does with the network, these
//! tests do, so the flow is the shipped flow.
//!
//! The LAN narrowing is proved at the socket and route level: the control
//! routes exist only on the loopback router, and the LAN listener serves the
//! page the QR code opens, the code exchange, the home projection and a
//! favicon, and nothing else.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use openremote_core::Store;
use openremote_daemon::app::{App, AppOptions};
use openremote_daemon::pairing::{CODE_TTL_MS, PairingHost};
use openremote_daemon::registry::HarnessRegistry;
use openremote_daemon::supervisor::Supervisor;
use serde_json::Value;

/// A stand-in for the owner token. Never a real one: the tests assert this
/// string never leaves loopback, and a test that used a real token would be
/// proving the wrong thing in a log somewhere.
const OWNER_TOKEN: &str = "e2e-owner-token-never-on-the-lan";

struct Reply {
    status: u16,
    body: String,
    headers: Vec<(String, String)>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// One daemon: its loopback router (with the pairing control routes merged,
/// exactly as `main.rs` merges them) and nothing else.
struct Daemon {
    data_dir: tempfile::TempDir,
    app: Arc<App>,
    host: Arc<PairingHost>,
    control: SocketAddr,
}

async fn start(ttl_ms: i64) -> Daemon {
    start_at("127.0.0.1:0".parse().expect("loopback"), ttl_ms).await
}

/// The same daemon, on an address the test already knows: that is how a
/// socket that should not exist yet can be probed by name.
async fn start_at(addr: SocketAddr, ttl_ms: i64) -> Daemon {
    start_over(tempfile::tempdir().expect("temp data dir"), addr, ttl_ms).await
}

/// A daemon over a data folder the test prepared itself, for the cases where
/// the folder is the thing under test (a phones file that cannot be written).
async fn start_over(data_dir: tempfile::TempDir, addr: SocketAddr, ttl_ms: i64) -> Daemon {
    let store = Arc::new(StdMutex::new(
        Store::open(data_dir.path().to_path_buf()).expect("store"),
    ));
    let supervisor = Supervisor::new(store.clone(), HarnessRegistry::none());
    let app = App::assemble(
        AppOptions {
            data_dir: data_dir.path().to_path_buf(),
            token: OWNER_TOKEN.into(),
            cloud: dead_cloud(),
        },
        store,
        supervisor,
    );
    let host = PairingHost::open_on(Arc::clone(&app), addr, ttl_ms);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind control");
    let control = listener.local_addr().expect("control addr");
    let router = openremote_daemon::http::router(Arc::clone(&app)).merge(host.control_router());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Daemon {
        data_dir,
        app,
        host,
        control,
    }
}

fn dead_cloud() -> openremote_cloud::CloudConfig {
    // No Cloud in this feature at all: the address answers nothing, so a
    // stray attempt fails fast and loudly rather than reaching a real one.
    openremote_cloud::CloudConfig {
        api_base: "http://127.0.0.1:9/v1/openremote".into(),
        auth_issuer: "http://127.0.0.1:9/v1/auth".into(),
        client_id: openremote_cloud::config::CLIENT_ID.into(),
        device_name: "pairing-e2e".into(),
        platform: std::env::consts::OS.into(),
        redirect_uri: None,
    }
}

async fn http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<&str>,
) -> Reply {
    try_http(addr, method, path, bearer, body)
        .await
        .expect("the listener answered")
}

/// The same, for the assertions about a socket that should be gone.
async fn try_http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<&str>,
) -> Option<Reply> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let body = body.unwrap_or_default();
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n");
    if let Some(token) = bearer {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    request.push_str(&format!(
        "Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ));
    let Ok(mut stream) = tokio::net::TcpStream::connect(addr).await else {
        return None;
    };
    // A peer that drops the connection before or while we write has not
    // answered, and that is what a socket with nothing behind it looks like
    // on the way out: no answer, not a panic in the test.
    if stream.write_all(request.as_bytes()).await.is_err() {
        return None;
    }
    let mut raw = Vec::new();
    match tokio::time::timeout(Duration::from_secs(20), stream.read_to_end(&mut raw)).await {
        Ok(Ok(_)) => {}
        Ok(Err(_)) => return None,
        Err(_) => panic!("{method} {path}: never answered within 20s"),
    }
    let raw = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = raw.split_once("\r\n\r\n").expect("header block");
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let headers = head
        .lines()
        .skip(1)
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    Some(Reply {
        status,
        body: body.trim_end_matches(['\r', '\n', '\0']).to_string(),
        headers,
    })
}

/// The console's mint, as the shipped client makes it.
async fn mint(daemon: &Daemon) -> (String, String, SocketAddr) {
    let reply = http(
        daemon.control,
        "POST",
        "/pairing/code",
        Some(OWNER_TOKEN),
        Some("{}"),
    )
    .await;
    assert_eq!(reply.status, 200, "mint: {}", reply.body);
    let json = reply.json();
    let url = json["url"].as_str().expect("url").to_string();
    let code = json["code"].as_str().expect("code").to_string();
    // The QR payload is a URL the phone can open with no discovery step.
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    assert!(url.ends_with(&format!("/#{code}")), "{url}");
    let addr: SocketAddr = url
        .trim_start_matches("http://")
        .split('/')
        .next()
        .expect("host:port")
        .parse()
        .expect("lan address");
    (code, url, addr)
}

#[tokio::test]
async fn a_fake_phone_pairs_and_can_reach_only_its_own_route() {
    let daemon = start(CODE_TTL_MS).await;
    let (code, _url, lan) = mint(&daemon).await;
    assert_eq!(code.len(), 8);

    // The page a phone gets: no data in it, and none of the secrets in it.
    let page = http(lan, "GET", "/", None, None).await;
    assert_eq!(page.status, 200);
    assert!(
        page.header("content-type")
            .unwrap_or_default()
            .starts_with("text/html")
    );
    assert!(page.body.contains("OpenRemote"));
    assert!(
        !page.body.contains(OWNER_TOKEN),
        "the page leaks the owner token"
    );
    assert!(!page.body.contains(&code), "the page leaks the live code");
    assert!(
        page.header("content-security-policy").is_some(),
        "the page carries a CSP"
    );
    assert_eq!(page.header("cache-control"), Some("no-store"));

    // The exchange: the code buys this phone one scoped token.
    let body = format!(r#"{{"code":"{code}","name":"iPhone"}}"#);
    let paired = http(lan, "POST", "/pair", None, Some(&body)).await;
    assert_eq!(paired.status, 200, "exchange: {}", paired.body);
    let json = paired.json();
    let token = json["token"].as_str().expect("token").to_string();
    assert_eq!(token.len(), 64);
    assert_eq!(json["phone"]["name"], "iPhone");
    assert!(json["computer"]["name"].as_str().is_some());
    assert!(
        !paired.body.contains(OWNER_TOKEN),
        "the exchange leaks the owner token"
    );

    // What the phone may read.
    let home = http(lan, "GET", "/api/home", Some(&token), None).await;
    assert_eq!(home.status, 200, "home: {}", home.body);
    let home_json = home.json();
    assert!(home_json["computer"]["name"].as_str().is_some());
    assert!(home_json["chats"].is_array());
    assert_eq!(home_json["phone"]["name"], "iPhone");
    assert!(
        !home.body.contains(OWNER_TOKEN),
        "the phone route leaks the owner token"
    );
    assert!(
        !home.body.contains("workspace"),
        "a chat's workspace path is host detail and stays home"
    );

    // The other direction: the owner token is not a phone token.
    let owner_on_lan = http(lan, "GET", "/api/home", Some(OWNER_TOKEN), None).await;
    assert_eq!(
        owner_on_lan.status, 401,
        "the owner token buys nothing on the LAN"
    );

    // The loopback API does not know the phone's token.
    let phone_on_loopback = http(daemon.control, "GET", "/sessions", Some(&token), None).await;
    assert_eq!(phone_on_loopback.status, 401);

    // Nor do the control routes.
    let phone_mint = http(
        daemon.control,
        "POST",
        "/pairing/code",
        Some(&token),
        Some("{}"),
    )
    .await;
    assert_eq!(phone_mint.status, 401);
    let phone_list = http(daemon.control, "GET", "/pairing/phones", Some(&token), None).await;
    assert_eq!(phone_list.status, 401);

    // And the LAN listener has no owner API on it at all. Asserted with the
    // phone token and again with the owner token: no route on this socket
    // reads either, which is what keeps the owner's credential off the
    // network by structure rather than by a check that could regress.
    for bearer in [Some(token.as_str()), Some(OWNER_TOKEN)] {
        for (method, path) in [
            ("GET", "/sessions"),
            ("POST", "/sessions"),
            ("GET", "/capabilities"),
            ("GET", "/healthz"),
            ("GET", "/pairing/phones"),
            ("POST", "/pairing/code"),
            ("GET", "/pairing/code"),
        ] {
            let reply = http(lan, method, path, bearer, None).await;
            assert_eq!(
                reply.status, 404,
                "{method} {path} must not exist on the LAN listener"
            );
        }
    }

    // The desktop's list: the phone, by name, and never its secret.
    let list = http(
        daemon.control,
        "GET",
        "/pairing/phones",
        Some(OWNER_TOKEN),
        None,
    )
    .await;
    assert_eq!(list.status, 200);
    let phones = list.json();
    let rows = phones["phones"].as_array().expect("phones");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], "iPhone");
    assert!(
        !list.body.contains(&token),
        "the phone's token is never listed"
    );
    assert!(!list.body.contains("digest"), "the digest is never listed");
}

#[tokio::test]
async fn a_code_is_single_use_and_expires() {
    let daemon = start(CODE_TTL_MS).await;
    let (code, _url, lan) = mint(&daemon).await;
    let body = format!(r#"{{"code":"{code}","name":"Pixel"}}"#);

    let first = http(lan, "POST", "/pair", None, Some(&body)).await;
    assert_eq!(first.status, 200, "{}", first.body);

    // The same code, again: the phone it already made is the only one.
    let replay = http(lan, "POST", "/pair", None, Some(&body)).await;
    assert_eq!(replay.status, 404, "a used code must not answer twice");
    assert!(
        replay.json()["token"].is_null(),
        "a replay must not mint a token: {}",
        replay.body
    );
    let list = http(
        daemon.control,
        "GET",
        "/pairing/phones",
        Some(OWNER_TOKEN),
        None,
    )
    .await;
    assert_eq!(list.json()["phones"].as_array().map(Vec::len), Some(1));

    // A code minted with a 50 ms life is gone by the time the phone scans.
    let short = start(50).await;
    let (code, _url, lan) = mint(&short).await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    let late = http(
        lan,
        "POST",
        "/pair",
        None,
        Some(&format!(r#"{{"code":"{code}","name":"Pixel"}}"#)),
    )
    .await;
    assert_eq!(
        late.status, 410,
        "an expired code answers 410: {}",
        late.body
    );
    assert!(
        late.json()["token"].is_null(),
        "an expired code must not mint a token: {}",
        late.body
    );
    // Nothing was written: an expired exchange leaves no phone behind.
    let after = http(
        short.control,
        "GET",
        "/pairing/phones",
        Some(OWNER_TOKEN),
        None,
    )
    .await;
    assert_eq!(after.json()["phones"].as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn wrong_codes_burn_the_live_code_rather_than_feed_guesses() {
    let daemon = start(CODE_TTL_MS).await;
    let (code, _url, lan) = mint(&daemon).await;
    for attempt in 0..5 {
        let guess = if code == "ZZZZZZZZ" {
            "YYYYYYYY"
        } else {
            "ZZZZZZZZ"
        };
        let reply = http(
            lan,
            "POST",
            "/pair",
            None,
            Some(&format!(r#"{{"code":"{guess}","name":"x"}}"#)),
        )
        .await;
        assert_eq!(reply.status, 404, "guess {attempt} must not pair");
    }
    // Five guesses in, the real code is dead too: the guesses were the
    // attack, and the person at the machine shows a new one. With no phone
    // paired the socket goes with the code, so the answer is a refused
    // connection or, if a connection was already open, a 404 either way.
    match try_http(
        lan,
        "POST",
        "/pair",
        None,
        Some(&format!(r#"{{"code":"{code}","name":"x"}}"#)),
    )
    .await
    {
        None => {}
        Some(reply) => assert_eq!(
            reply.status, 404,
            "the code must not survive the attempt limit: {}",
            reply.body
        ),
    }
    // And nothing of this feature is answering the network any more.
    assert!(
        try_http(lan, "GET", "/", None, None).await.is_none(),
        "burning the last code left the listener up"
    );
}

#[tokio::test]
async fn revoking_a_phone_ends_its_access_and_nothing_idles_on_the_lan() {
    let daemon = start(CODE_TTL_MS).await;
    let (code, _url, lan) = mint(&daemon).await;
    let paired = http(
        lan,
        "POST",
        "/pair",
        None,
        Some(&format!(r#"{{"code":"{code}","name":"iPhone"}}"#)),
    )
    .await;
    let token = paired.json()["token"].as_str().expect("token").to_string();
    let id = paired.json()["phone"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    assert_eq!(
        http(lan, "GET", "/api/home", Some(&token), None)
            .await
            .status,
        200
    );

    // A second phone, so revoking the first leaves the listener serving
    // somebody: that is the case where the removed phone hears a plain 401
    // and its page can say what happened.
    let (code, _url, _lan) = mint(&daemon).await;
    let second = http(
        lan,
        "POST",
        "/pair",
        None,
        Some(&format!(r#"{{"code":"{code}","name":"Pixel"}}"#)),
    )
    .await;
    let second_token = second.json()["token"].as_str().expect("token").to_string();

    let revoked = http(
        daemon.control,
        "POST",
        &format!("/pairing/phones/{id}/revoke"),
        Some(OWNER_TOKEN),
        Some("{}"),
    )
    .await;
    assert_eq!(revoked.status, 200, "{}", revoked.body);
    assert_eq!(revoked.json()["phones"].as_array().map(Vec::len), Some(1));

    // The phone's next word is 401: there is no record left to match, and
    // the other phone is untouched.
    let after = http(lan, "GET", "/api/home", Some(&token), None).await;
    assert_eq!(after.status, 401);
    assert!(after.body.contains("removed"), "{}", after.body);
    assert_eq!(
        http(lan, "GET", "/api/home", Some(&second_token), None)
            .await
            .status,
        200
    );

    // Revoking the last phone, with no code live, closes the socket: nothing
    // of this feature answers the network when nobody is paired.
    let last = http(
        daemon.control,
        "GET",
        "/pairing/phones",
        Some(OWNER_TOKEN),
        None,
    )
    .await;
    let last_id = last.json()["phones"][0]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let drained = http(
        daemon.control,
        "POST",
        &format!("/pairing/phones/{last_id}/revoke"),
        Some(OWNER_TOKEN),
        Some("{}"),
    )
    .await;
    assert_eq!(drained.status, 200, "{}", drained.body);
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        // Ask until nothing answers: a closed socket is a refused
        // connection, so the loop ends when the probe fails rather than when
        // a status changes. Spelled `is_some` rather than `while let Some(_)`
        // because clippy reads the pattern form as a redundant match.
        while try_http(lan, "GET", "/", None, None).await.is_some() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(
        closed.is_ok(),
        "the LAN listener stayed up with nothing to serve"
    );

    // Revoking a phone that is not there says so instead of lying.
    let missing = http(
        daemon.control,
        "POST",
        &format!("/pairing/phones/{id}/revoke"),
        Some(OWNER_TOKEN),
        Some("{}"),
    )
    .await;
    assert_eq!(missing.status, 404);
}

#[tokio::test]
async fn cancel_stops_pairing_and_shuts_the_listener() {
    let daemon = start(CODE_TTL_MS).await;
    let (code, _url, lan) = mint(&daemon).await;
    let before = http(lan, "GET", "/", None, None).await;
    assert_eq!(before.status, 200);

    let cancelled = http(
        daemon.control,
        "POST",
        "/pairing/cancel",
        Some(OWNER_TOKEN),
        Some("{}"),
    )
    .await;
    assert_eq!(cancelled.status, 200);

    // The code that was on screen is dead, and the socket is closed.
    let dead = try_http(
        lan,
        "POST",
        "/pair",
        None,
        Some(&format!(r#"{{"code":"{code}","name":"x"}}"#)),
    )
    .await;
    // A socket that is gone, or one that answers "not valid": both are
    // honest, and neither pairs a phone.
    let status = dead.map(|reply| reply.status);
    assert!(
        matches!(status, None | Some(404)),
        "a cancelled code must not pair: {status:?}"
    );
    // Nothing is paired, so nothing may answer the network at all once the
    // abort lands.
    let gone = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if try_http(lan, "GET", "/", None, None).await.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(gone.is_ok(), "cancel left the LAN listener up");
}

#[tokio::test]
async fn paired_phones_survive_a_restart_and_only_their_digest_is_written() {
    let daemon = start(CODE_TTL_MS).await;
    let (code, _url, lan) = mint(&daemon).await;
    let paired = http(
        lan,
        "POST",
        "/pair",
        None,
        Some(&format!(r#"{{"code":"{code}","name":"iPhone"}}"#)),
    )
    .await;
    let token = paired.json()["token"].as_str().expect("token").to_string();

    let file = daemon.host.phones_path().to_path_buf();
    let raw = std::fs::read_to_string(&file).expect("the phones file is written");
    assert!(
        !raw.contains(&token),
        "the file must hold a digest, never the token"
    );
    assert!(raw.contains("digest"), "{raw}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the phones file is owner-only");
    }

    // A second daemon over the same data folder: the phone is still there,
    // and its token still matches its digest.
    let reopened = PairingHost::open_on(
        Arc::clone(&daemon.app),
        "127.0.0.1:0".parse().expect("loopback"),
        CODE_TTL_MS,
    );
    let phones = reopened.phones();
    assert_eq!(phones.len(), 1);
    assert_eq!(phones[0].name, "iPhone");
    let phone = reopened.phone_for(&token).expect("the token still matches");
    assert_eq!(phone.id, phones[0].id);
    assert!(reopened.phone_for("not-the-token").is_none());
}

#[tokio::test]
async fn nothing_listens_until_a_code_is_live() {
    // A fixed loopback port the daemon is given by name, so this test can
    // probe it before anything is live. Fixed, and outside the range the
    // operating system hands to a port-0 bind: the other suites bind port 0
    // while this one waits, and a port out of that range cannot be taken
    // from under it. The candidate is proved free by binding it here first.
    let mut addr = None;
    for port in 41011..41021u16 {
        let candidate: SocketAddr = format!("127.0.0.1:{port}").parse().expect("loopback");
        if let Ok(listener) = tokio::net::TcpListener::bind(candidate).await {
            drop(listener);
            addr = Some(candidate);
            break;
        }
    }
    let addr = addr.expect("a free fixed loopback port");

    // A short life, so the test can watch the socket go down with the code.
    let daemon = start_at(addr, 300).await;
    // First boot: no code, no paired phone, so nothing of this feature
    // answers the network. A phone finds a refused connection - not a 401,
    // not the page, not a port that is silently accepting.
    for attempt in 0..3 {
        assert!(
            try_http(addr, "GET", "/", None, None).await.is_none(),
            "attempt {attempt}: something answered before a code was live"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Showing a code opens exactly that address, and the payload names it.
    let (_code, url, lan) = mint(&daemon).await;
    assert_eq!(lan, addr, "the payload must name the address that is bound");
    assert!(url.contains("/#"), "the code rides the fragment: {url}");
    assert_eq!(http(lan, "GET", "/", None, None).await.status, 200);

    // The code is left on screen and nobody scans it. When it runs out the
    // socket closes by itself: no paired phone is holding it up, so nothing
    // of this feature is left answering the network, and no cancel was sent.
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        // Same wait as above, on the address the payload named: the socket
        // goes down by itself when the code runs out and no phone is paired.
        while try_http(addr, "GET", "/", None, None).await.is_some() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(
        closed.is_ok(),
        "the LAN listener outlived the code that opened it"
    );
}

#[tokio::test]
async fn ten_parallel_wrong_guesses_pair_nothing() {
    // What this proves: ten guesses arriving together pair nothing, no token
    // is handed out, and the fifth burn takes the socket down with the code
    // even though no phone is paired - so a burst cannot keep a listener
    // answering after the code it was opened for is gone. It does not prove
    // the counter has no window where two requests both read "four failures",
    // because every answer here is a 404 either way and a refused connection
    // is tolerated; the counter sits under the same lock as the code, but a
    // test would have to see the fifth and sixth attempts share a read to
    // show it, and this one cannot.
    let daemon = start(CODE_TTL_MS).await;
    let (code, _url, lan) = mint(&daemon).await;

    let mut guesses = Vec::new();
    for n in 0..10u8 {
        // Well formed, eight characters, one wrong: the daemon's own
        // comparison is what must refuse them, not a length check.
        let mut wrong = code.clone().into_bytes();
        let last = wrong.len() - 1;
        wrong[last] = if wrong[last] == b'2' { b'3' } else { b'2' };
        let body = format!(
            r#"{{"code":"{}","name":"phone {n}"}}"#,
            String::from_utf8(wrong).expect("ascii")
        );
        guesses.push(tokio::spawn(async move {
            try_http(lan, "POST", "/pair", None, Some(&body)).await
        }));
    }
    let mut answered = 0;
    for handle in guesses {
        let reply = handle.await.expect("guess task");
        if let Some(reply) = reply {
            answered += 1;
            assert_eq!(reply.status, 404, "a wrong guess answered {}", reply.body);
            assert!(
                !reply.body.contains("\"token\""),
                "a wrong guess minted a token: {}",
                reply.body
            );
        }
    }
    assert!(answered > 0, "no guess was answered at all");

    // Nobody is paired, so nothing a phone could use exists: and the code is
    // gone, which is why the fifth guess also closed the socket even though
    // no phone is holding it up.
    let listed = http(
        daemon.control,
        "GET",
        "/pairing/phones",
        Some(OWNER_TOKEN),
        None,
    )
    .await;
    assert_eq!(listed.json()["phones"].as_array().map(Vec::len), Some(0));
    assert!(
        try_http(lan, "GET", "/", None, None).await.is_none(),
        "burning the last code left the listener up"
    );
}

#[tokio::test]
async fn a_pairing_that_cannot_be_saved_hands_out_no_token() {
    // A phones path that cannot be written (here it is a folder, so the file
    // cannot be created). Nothing is handed out: a phone this computer would
    // forget on its next start is worse than one that never paired.
    let data_dir = tempfile::tempdir().expect("temp data dir");
    std::fs::create_dir(data_dir.path().join("paired-phones.json")).expect("blocking folder");
    let daemon = start_over(
        data_dir,
        "127.0.0.1:0".parse().expect("loopback"),
        CODE_TTL_MS,
    )
    .await;
    let (code, _url, lan) = mint(&daemon).await;

    let body = format!(r#"{{"code":"{code}","name":"iPhone"}}"#);
    let answer = http(lan, "POST", "/pair", None, Some(&body)).await;
    assert_eq!(answer.status, 500, "{}", answer.body);
    assert!(!answer.body.contains("\"token\""), "{}", answer.body);

    let listed = http(
        daemon.control,
        "GET",
        "/pairing/phones",
        Some(OWNER_TOKEN),
        None,
    )
    .await;
    assert_eq!(
        listed.json()["phones"].as_array().map(Vec::len),
        Some(0),
        "a phone that could not be written was kept in memory"
    );
}

#[tokio::test]
async fn a_revoke_that_cannot_be_saved_keeps_the_phone_paired() {
    // Revoking is the one path that must fail closed. The write is made to
    // fail after a successful pairing (the file is replaced by a folder), so
    // the removal has somewhere to fail.
    let daemon = start(CODE_TTL_MS).await;
    let (code, _url, lan) = mint(&daemon).await;
    let body = format!(r#"{{"code":"{code}","name":"iPhone"}}"#);
    let paired = http(lan, "POST", "/pair", None, Some(&body)).await;
    assert_eq!(paired.status, 200, "{}", paired.body);
    let phone_id = paired.json()["phone"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    let phones_path = daemon.data_dir.path().join("paired-phones.json");
    std::fs::remove_file(&phones_path).expect("remove the phones file");
    std::fs::create_dir(&phones_path).expect("blocking folder");

    let answer = http(
        daemon.control,
        "POST",
        &format!("/pairing/phones/{phone_id}/revoke"),
        Some(OWNER_TOKEN),
        Some("{}"),
    )
    .await;
    assert_eq!(answer.status, 500, "{}", answer.body);
    assert!(
        !answer.body.contains("\"phones\": []"),
        "a failed revoke redrew the list as empty: {}",
        answer.body
    );

    // The phone is still paired, so the desktop still knows about it and the
    // token still works: the removal simply did not happen.
    let listed = http(
        daemon.control,
        "GET",
        "/pairing/phones",
        Some(OWNER_TOKEN),
        None,
    )
    .await;
    assert_eq!(listed.json()["phones"].as_array().map(Vec::len), Some(1));
    let token = paired.json()["token"].as_str().expect("token").to_string();
    let home = http(lan, "GET", "/api/home", Some(&token), None).await;
    assert_eq!(home.status, 200, "{}", home.body);
}

#[tokio::test]
async fn the_production_bind_puts_a_real_network_address_in_the_payload() {
    // The only test that exercises the shipped binding: the machine's own
    // address, not loopback, so a phone on the same network can reach it.
    let data_dir = tempfile::tempdir().expect("temp data dir");
    let store = Arc::new(StdMutex::new(
        Store::open(data_dir.path().to_path_buf()).expect("store"),
    ));
    let supervisor = Supervisor::new(store.clone(), HarnessRegistry::none());
    let app = App::assemble(
        AppOptions {
            data_dir: data_dir.path().to_path_buf(),
            token: OWNER_TOKEN.into(),
            cloud: dead_cloud(),
        },
        store,
        supervisor,
    );
    let host = PairingHost::open(app);
    let mint = match host.mint().await {
        Ok(mint) => mint,
        // A machine with no route off loopback cannot pair a phone, and the
        // desktop says exactly that. Nothing to assert about an address, and
        // a green run here is not coverage of the shipped bind, so an offline
        // run fails unless it says out loud that it meant to be offline: this
        // is the only test that binds the address a phone would dial, and a
        // silent skip would leave the shipping path unproved on a build
        // machine that happens to have no network.
        Err(openremote_daemon::pairing::MintError::NoNetwork) => {
            assert!(
                std::env::var_os("OPENREMOTE_PAIRING_ALLOW_OFFLINE").is_some(),
                "this machine has no LAN address, so the shipped bind was not exercised; \
                 set OPENREMOTE_PAIRING_ALLOW_OFFLINE=1 to accept that on purpose"
            );
            eprintln!(
                "SKIPPED the_production_bind_puts_a_real_network_address_in_the_payload: \
                 this machine has no LAN address, and OPENREMOTE_PAIRING_ALLOW_OFFLINE is set"
            );
            return;
        }
        Err(err) => panic!("mint: {err:?}"),
    };
    let host_part = mint
        .url
        .trim_start_matches("http://")
        .split('/')
        .next()
        .expect("host:port");
    let ip: std::net::IpAddr = host_part
        .rsplit_once(':')
        .expect("address and port")
        .0
        .parse()
        .expect("an IP address the phone can dial");
    assert!(!ip.is_loopback(), "a phone cannot reach loopback: {ip}");
    assert!(!ip.is_unspecified(), "0.0.0.0 is not an address to dial");
    // The listener is bound to that address and not to the wildcard: the
    // payload's own address answers, and loopback does not (the console
    // never needs it - it talks to the daemon's own API).
    let port: u16 = host_part
        .rsplit_once(':')
        .expect("address and port")
        .1
        .parse()
        .expect("port");
    let page = http(
        format!("{ip}:{port}").parse().expect("the LAN address"),
        "GET",
        "/",
        None,
        None,
    )
    .await;
    assert_eq!(page.status, 200);
    assert!(
        try_http(
            format!("127.0.0.1:{port}").parse().expect("loopback"),
            "GET",
            "/",
            None,
            None,
        )
        .await
        .is_none(),
        "the listener must not answer on loopback as well"
    );
}

/// A loopback address nothing is holding, from the range the suites keep for
/// "a port I can name". Binding first is the only way to know it is free, and
/// the range sits below the block Windows hands out, so no other test's port
/// zero can take it.
async fn free_loopback_addr() -> SocketAddr {
    for port in 41011..41021u16 {
        let addr: SocketAddr = format!("127.0.0.1:{port}").parse().expect("loopback");
        if let Ok(listener) = tokio::net::TcpListener::bind(addr).await {
            drop(listener);
            return addr;
        }
    }
    panic!("no free loopback port in 41011..41021");
}

/// A phone on the list, made the way the panel makes one: show a code, then
/// let the phone exchange it. Answers the phone's id and the address it
/// reached, which is the address it will dial again.
async fn pair_one_phone(daemon: &Daemon) -> (String, SocketAddr) {
    let (code, _url, lan) = mint(daemon).await;
    let reply = http(
        lan,
        "POST",
        "/pair",
        None,
        Some(&format!("{{\"code\":\"{code}\",\"name\":\"Pixel\"}}")),
    )
    .await;
    assert_eq!(reply.status, 200, "pair: {}", reply.body);
    let id = reply.json()["phone"]["id"]
        .as_str()
        .expect("phone id")
        .to_string();
    (id, lan)
}

/// A pairing host over a data folder a daemon has already used, at whatever
/// address it binds now: how this suite moves "this computer" to another
/// network without touching the machine's own interfaces.
fn reopen_at(data_dir: &std::path::Path, addr: SocketAddr) -> Arc<PairingHost> {
    let data_dir = data_dir.to_path_buf();
    let store = Arc::new(StdMutex::new(Store::open(data_dir.clone()).expect("store")));
    let supervisor = Supervisor::new(store.clone(), HarnessRegistry::none());
    let app = App::assemble(
        AppOptions {
            data_dir,
            token: OWNER_TOKEN.into(),
            cloud: dead_cloud(),
        },
        store,
        supervisor,
    );
    PairingHost::open_on(app, addr, CODE_TTL_MS)
}

#[tokio::test]
async fn a_moved_address_tells_the_panel_the_phones_must_pair_again() {
    // Pair at home, open the laptop on another network: the phone's token is
    // stored against the old origin, so the phone shows "site can't be
    // reached" while this end still lists it as paired and blames the
    // network or the firewall. The file remembers the address, so the panel
    // can say what actually happened.
    let (daemon, lan) = {
        let daemon = start(CODE_TTL_MS).await;
        let (id, lan) = pair_one_phone(&daemon).await;
        assert!(daemon.host.phones().iter().any(|p| p.id == id));
        (daemon, lan)
    };
    let data_dir = daemon.data_dir.path().to_path_buf();
    let file = std::fs::read_to_string(data_dir.join("paired-phones.json")).expect("phones file");
    assert!(
        file.contains(&lan.to_string()),
        "the file records the address the phone paired at: {file}"
    );
    // The daemon stays alive on its old address: its temp folder goes with
    // it, and the point here is a second daemon reading the folder the first
    // one wrote, which is what a restart on another network is.

    // The same folder, a different address: the phone is still on the list
    // (nothing destroys a record behind the person's back) and the panel says
    // why it cannot reach us.
    let moved = reopen_at(&data_dir, free_loopback_addr().await);
    moved.restore().await;
    assert_eq!(moved.phones().len(), 1, "the record is kept");
    let notice = moved.notice().expect("a notice about the moved address");
    assert!(
        notice.contains("network address changed"),
        "the notice names the cause: {notice}"
    );
    assert!(
        notice.contains("pair it again"),
        "the notice says what to do: {notice}"
    );

    // Control: the daemon still bound where the phone paired says nothing at
    // all, so the sentence above is about the move and not about reading the
    // file back.
    assert_eq!(
        daemon.host.notice(),
        None,
        "the daemon that did not move is quiet"
    );
}

#[tokio::test]
async fn a_revoke_racing_a_mint_never_leaves_a_code_on_a_closed_socket() {
    // The window: mint binds the socket, then installs the code, and a revoke
    // arriving between the two used to close the socket and still let the
    // mint answer with a QR for it. The lock closes the window, so the
    // assertion is an invariant and not a timing: a code the panel is showing
    // names a socket that is there.
    let daemon = start(CODE_TTL_MS).await;
    for round in 0..20 {
        let (id, _lan) = pair_one_phone(&daemon).await;
        let revoke_path = format!("/pairing/phones/{id}/revoke");
        let (minted, revoked) = tokio::join!(
            try_http(
                daemon.control,
                "POST",
                "/pairing/code",
                Some(OWNER_TOKEN),
                Some("{}"),
            ),
            try_http(
                daemon.control,
                "POST",
                &revoke_path,
                Some(OWNER_TOKEN),
                Some("{}"),
            )
        );
        let minted = minted.expect("the control listener answered the mint");
        let revoked = revoked.expect("the control listener answered the revoke");
        assert_eq!(minted.status, 200, "round {round}: mint {}", minted.body);
        assert_eq!(
            revoked.status, 200,
            "round {round}: revoke {}",
            revoked.body
        );
        let url = minted.json()["url"].as_str().expect("url").to_string();
        let named: SocketAddr = url
            .trim_start_matches("http://")
            .split('/')
            .next()
            .expect("host:port")
            .parse()
            .expect("an address a phone can dial");
        assert!(
            try_http(named, "GET", "/", None, None).await.is_some(),
            "round {round}: the code names {named}, and nothing is listening there"
        );
        // Start the next round from a known state: no code, no phones.
        http(
            daemon.control,
            "POST",
            "/pairing/cancel",
            Some(OWNER_TOKEN),
            Some("{}"),
        )
        .await;
    }
}
