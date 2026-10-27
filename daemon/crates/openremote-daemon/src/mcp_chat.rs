//! `openremote-daemon mcp-chat`: OpenRemote's read-a-chat MCP server, the
//! first tool of OpenRemote Controls. A chat's harness starts it over
//! stdio (MCP's newline-delimited JSON-RPC). It reads the API token from
//! the data folder, never from its command line, and asks the daemon on
//! loopback for a chat the user pointed this chat at with @ - the daemon
//! refuses any other.
//!
//! It also reads the daemon's port from that folder, for the same reason it
//! reads the token there: a daemon restart moves the port, and a chat's server
//! outlives the daemon that started it. The port is read again on every call
//! (a few bytes against an HTTP round trip), and a call that could not connect
//! reads it once more and tries the fresh value - the gap between an old
//! daemon's clean stop, which removes the file, and a new one's write is
//! exactly what a harness that stays up through a restart meets. The `--port`
//! in argv is what the chat was created with, so it is the fallback rather
//! than the truth.

use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use openremote_cloud::https::HttpError;

/// The MCP revision this server speaks when the client names none.
const PROTOCOL: &str = "2025-06-18";

/// The daemon's current port, in its data folder. Written by the daemon with
/// `fsx::write_private` (owner-only, atomic) and removed on a clean shutdown,
/// the same treatment the token beside it gets.
pub const PORT_FILE: &str = "mcp-port";

struct Config {
    session: String,
    port: u16,
    data_dir: PathBuf,
}

/// Records the port the daemon is serving on, so every running chat's server
/// can find it after a restart moved it.
pub fn write_port_file(data_dir: &Path, port: u16) -> io::Result<()> {
    openremote_core::fsx::write_private(&data_dir.join(PORT_FILE), port.to_string().as_bytes())
}

/// Removes it on a clean shutdown: the next start writes the next port.
pub fn remove_port_file(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(PORT_FILE));
}

/// The port the daemon published, or why it could not be read. The reason
/// matters: with no `--port` behind it, this is the whole of what the person
/// sees before the tool stops working.
fn published_port(data_dir: &Path) -> Result<u16, String> {
    let path = data_dir.join(PORT_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(format!("{} is not there", path.display()));
        }
        Err(e) => return Err(format!("{} could not be read: {e}", path.display())),
    };
    raw.trim()
        .parse::<u16>()
        .map_err(|e| format!("{} does not hold a port: {e}", path.display()))
}

/// The flags and the published port. The file wins when it holds a port; a
/// missing or unreadable file falls back to `--port` (what the chat was
/// created with, which an older daemon still passes) and, with no flag either,
/// is a refusal that says which file and why.
fn parse(args: &[String]) -> Result<(Config, Option<String>), String> {
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let Some(session) = value("--session") else {
        return Err("missing --session".to_string());
    };
    let Some(data_dir) = value("--data-dir").map(PathBuf::from) else {
        return Err("missing --data-dir".to_string());
    };
    let flag = match value("--port") {
        Some(raw) => Some(
            raw.parse::<u16>()
                .map_err(|e| format!("--port {raw} is not a port: {e}"))?,
        ),
        None => None,
    };
    match published_port(&data_dir) {
        Ok(port) => Ok((
            Config {
                session,
                port,
                data_dir,
            },
            None,
        )),
        Err(why) => match flag {
            Some(port) => Ok((
                Config {
                    session,
                    port,
                    data_dir,
                },
                Some(why),
            )),
            None => Err(format!(
                "no port to call the daemon on: {why}, and no --port was given"
            )),
        },
    }
}

pub async fn run(args: &[String]) -> ExitCode {
    let mut config = match parse(args) {
        Ok((config, note)) => {
            if let Some(note) = note {
                // Not fatal: the flag still points at some daemon. Said once,
                // because a corrupt file is otherwise invisible.
                eprintln!("openremote-daemon mcp-chat: using --port: {note}");
            }
            config
        }
        Err(why) => {
            eprintln!("openremote-daemon mcp-chat: {why}");
            eprintln!(
                "usage: openremote-daemon mcp-chat --session <id> [--port <port>] --data-dir <dir>"
            );
            return ExitCode::from(2);
        }
    };
    let token = match std::fs::read_to_string(config.data_dir.join("token")) {
        Ok(token) => token.trim().to_string(),
        Err(e) => {
            eprintln!("openremote-daemon mcp-chat: no token: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // A notification has no id and wants no answer.
        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let reply = match method {
            "initialize" => Ok(json!({
                "protocolVersion": params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(PROTOCOL),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "openremote", "version": env!("CARGO_PKG_VERSION")},
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": [tool()]})),
            "tools/call" => Ok(call(&mut config, &token, &params).await),
            other => Err(json!({"code": -32601, "message": format!("no method {other}")})),
        };
        let frame = match reply {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
        };
        let mut out = serde_json::to_string(&frame).expect("a frame serializes");
        out.push('\n');
        if stdout.write_all(out.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
            break;
        }
    }
    ExitCode::SUCCESS
}

fn tool() -> Value {
    json!({
        "name": "read_chat",
        "description": "Read an OpenRemote chat the user pointed you at with @ (they appear in their message as @chat followed by the chat's title and id). Answers the chat's messages, oldest first. Only chats the user mentioned in this chat can be read.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "chat": {"type": "string", "description": "The chat's id, or at least its first 6 characters."}
            },
            "required": ["chat"],
        },
    })
}

/// The port to call now. The daemon publishes its current one in the data
/// folder and a restart moves it under a running chat, so this is read per
/// call; the value the flags gave is the fallback for the moment when the file
/// is not there (between a clean stop removing it and a start writing it).
fn port_now(config: &Config) -> u16 {
    published_port(&config.data_dir).unwrap_or(config.port)
}

/// One call over the port we think is current, and one more after a fresh read
/// if the first could not connect. The retry is the restart gap: the old
/// daemon's clean stop deletes the port file, a new one writes its own a moment
/// later, and a tool call that lands between them is a connection refused
/// rather than a wrong answer. The fresh value is kept in the config, so the
/// rest of the session falls back to a port that is alive.
async fn with_fresh_port<T, A, Fut>(config: &mut Config, attempt: A) -> Result<T, HttpError>
where
    A: Fn(u16) -> Fut,
    Fut: std::future::Future<Output = Result<T, HttpError>>,
{
    let port = port_now(config);
    config.port = port;
    let first = attempt(port).await;
    // Only a connection failure retries. That is the restart gap: the old
    // daemon's clean stop removed the port file and the new one has not
    // written its own yet, so the call is refused instantly. A timeout is a
    // daemon that took too long to answer, and retrying it would double the
    // harness's wait on the same wedged daemon; a protocol or URL error would
    // fail the same way twice.
    if !matches!(first, Err(HttpError::Connect(_))) {
        return first;
    }
    match published_port(&config.data_dir) {
        Ok(fresh) if fresh != port => {
            config.port = fresh;
            attempt(fresh).await
        }
        // Nothing fresher to try: the failure the caller already knows.
        _ => first,
    }
}

/// The tool's answer: the daemon's condensed chat, or its refusal as a
/// tool error the agent can read.
async fn call(config: &mut Config, token: &str, params: &Value) -> Value {
    if params.get("name").and_then(Value::as_str) != Some("read_chat") {
        return failure("the only tool here is read_chat");
    }
    let Some(chat) = params.pointer("/arguments/chat").and_then(Value::as_str) else {
        return failure("read_chat needs the chat's id");
    };
    let bearer = format!("Bearer {token}");
    let session = config.session.clone();
    let chat = encode(chat);
    // The request over whichever port this attempt is given, so the retry can
    // hand it a different one without rebuilding the parse of the answer.
    let attempt = |port: u16| {
        let url = format!("http://127.0.0.1:{port}/sessions/{session}/mentions/{chat}");
        let bearer = bearer.clone();
        async move {
            let http = openremote_cloud::https::Http::new();
            let response = http
                .request("GET", &url, &[("authorization", bearer.as_str())], None)
                .await?;
            Ok((response.status, response.body))
        }
    };
    match with_fresh_port(config, attempt).await {
        Ok((status, body)) => answer(status, &body),
        Err(e) => failure(&format!("OpenRemote is not reachable: {e}")),
    }
}

/// What one answer from the daemon means to the tool: the chat's text, or a
/// failure the harness can read.
///
/// A 200 is never assumed to be a chat. The route promises JSON with a `text`
/// string, so a 200 that is not JSON (a proxy page, a truncated write) and a
/// 200 whose JSON has no `text` are both malformed answers, and a harness that
/// cannot see them would read the chat as empty rather than unreadable. An
/// empty string under the key is different: that is the route saying the chat
/// has nothing to read, and it stays a success.
fn answer(status: u16, body: &[u8]) -> Value {
    let parsed = serde_json::from_slice::<Value>(body).map_err(|e| e.to_string());
    if status == 200 {
        return match parsed {
            Ok(body) => match body.get("text").and_then(Value::as_str) {
                Some(text) => json!({"content": [{"type": "text", "text": text}]}),
                None => failure("OpenRemote answered with JSON that carries no chat text"),
            },
            Err(e) => failure(&format!(
                "OpenRemote answered 200 with something that is not JSON: {e}"
            )),
        };
    }
    match parsed {
        // The daemon's own sentence for a refusal, when it managed to send one.
        Ok(body) => failure(
            body.get("error")
                .and_then(Value::as_str)
                .unwrap_or("OpenRemote refused the read"),
        ),
        Err(_) => failure(&format!(
            "OpenRemote answered {status} with something that is not JSON"
        )),
    }
}

fn failure(text: &str) -> Value {
    json!({"content": [{"type": "text", "text": text}], "isError": true})
}

/// A path segment, percent-encoded past the unreserved characters.
fn encode(raw: &str) -> String {
    raw.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("or-mcp-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_200_that_is_not_json_is_a_tool_error_not_an_empty_chat() {
        // What a proxy page or a truncated write looks like to the tool: the
        // answer must say so, or a harness reads an unreadable chat as empty.
        let html = answer(200, b"<html><body>Bad Gateway</body></html>");
        assert_eq!(html["isError"], true, "{html}");
        assert!(
            html["content"][0]["text"]
                .as_str()
                .is_some_and(|t| t.contains("not JSON")),
            "{html}"
        );

        // JSON without the key the route promises is the same kind of answer:
        // malformed, not empty.
        let missing = answer(200, br#"{"chat":"c1"}"#);
        assert_eq!(missing["isError"], true, "{missing}");
        assert!(
            missing["content"][0]["text"]
                .as_str()
                .is_some_and(|t| t.contains("no chat text")),
            "{missing}"
        );

        // An empty string IS the route's answer for a chat with nothing to
        // read: the key is there, so this stays a success.
        let empty = answer(200, br#"{"text":""}"#);
        assert!(empty.get("isError").is_none(), "{empty}");
        assert_eq!(empty["content"][0]["text"], "");

        // A non-200 keeps the daemon's own sentence; a non-JSON one names the
        // status instead of inventing a sentence.
        let refusal = answer(403, br#"{"error":"this chat was not pointed at"}"#);
        assert_eq!(
            refusal["content"][0]["text"],
            "this chat was not pointed at"
        );
        let garbled = answer(502, b"<html>bad gateway</html>");
        assert!(
            garbled["content"][0]["text"]
                .as_str()
                .is_some_and(|t| t.contains("502")),
            "{garbled}"
        );
    }
    #[test]
    fn reads_its_flags_and_encodes_a_chat_name() {
        // The flag still works on its own: an older invocation, or a folder
        // with no port file yet, must not lose the port it was given.
        let dir = temp_dir("flags");
        let config = parse(&args(&[
            "--session",
            "s1",
            "--port",
            "4567",
            "--data-dir",
            dir.to_str().unwrap(),
        ]))
        .unwrap()
        .0;
        assert_eq!(config.session, "s1");
        assert_eq!(config.port, 4567);
        assert_eq!(encode("ab cd/ef"), "ab%20cd%2Fef");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_ported_flag_is_dropped_for_the_folder_so_a_restart_survives() {
        // The bug this fixes: the chat was created with one port, the daemon
        // came back on another, and the flag kept calling the dead one.
        let dir = temp_dir("wins");
        write_port_file(&dir, 6001).unwrap();
        let config = parse(&args(&[
            "--session",
            "s1",
            "--port",
            "4567",
            "--data-dir",
            dir.to_str().unwrap(),
        ]))
        .unwrap()
        .0;
        assert_eq!(config.port, 6001, "the folder wins over the flag");
        // And with no flag at all the folder is enough.
        let config = parse(&args(&[
            "--session",
            "s1",
            "--data-dir",
            dir.to_str().unwrap(),
        ]))
        .unwrap()
        .0;
        assert_eq!(config.port, 6001);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_or_unreadable_file_falls_back_or_refuses_with_the_reason() {
        let dir = temp_dir("refuse");
        // Missing file, no flag: a refusal that names the file, not a silent
        // exit. The message is what the harness's log will hold.
        let why = parse(&args(&[
            "--session",
            "s1",
            "--data-dir",
            dir.to_str().unwrap(),
        ]))
        .err()
        .expect("no port anywhere is an error");
        assert!(why.contains(PORT_FILE), "{why}");
        assert!(why.contains("no --port was given"), "{why}");

        // A file that is there but is not a port: same refusal, and the reason
        // says what was in it.
        std::fs::write(dir.join(PORT_FILE), "not a port\n").unwrap();
        let why = parse(&args(&[
            "--session",
            "s1",
            "--data-dir",
            dir.to_str().unwrap(),
        ]))
        .err()
        .expect("a corrupt file with no flag is an error");
        assert!(why.contains("does not hold a port"), "{why}");

        // With the flag behind it, the corrupt file is a warning, not a stop:
        // the caller gets the flag and the note says what was wrong.
        let (config, note) = parse(&args(&[
            "--session",
            "s1",
            "--port",
            "4567",
            "--data-dir",
            dir.to_str().unwrap(),
        ]))
        .unwrap();
        assert_eq!(config.port, 4567);
        assert!(note.unwrap_or_default().contains("does not hold a port"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_port_file_is_owner_only_and_goes_on_a_clean_shutdown() {
        let dir = temp_dir("perms");
        write_port_file(&dir, 6002).unwrap();
        let path = dir.join(PORT_FILE);
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "6002");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "the port is not a secret, but the folder is owner-only"
            );
        }
        remove_port_file(&dir);
        assert!(
            !path.exists(),
            "a clean shutdown leaves no stale port behind"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_port_is_read_per_call_and_the_flag_is_the_fallback() {
        // The reader the reviewer's case needed: a chat that stays up through
        // a restart asks again every time, and only falls back to the flag
        // when the file is not there.
        let dir = temp_dir("per-call");
        let config = Config {
            session: "s1".to_string(),
            port: 4567,
            data_dir: dir.clone(),
        };
        assert_eq!(port_now(&config), 4567, "no file yet: the flag");
        write_port_file(&dir, 6003).unwrap();
        assert_eq!(port_now(&config), 6003, "the published port wins per call");
        remove_port_file(&dir);
        assert_eq!(port_now(&config), 4567, "and the flag is back when it goes");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_call_that_fails_on_the_stale_port_retries_the_fresh_one_and_keeps_it() {
        // The restart gap: the old daemon's clean stop removed the file, so the
        // first attempt uses the flag's stale port; while it is failing, the
        // new daemon publishes its own. The retry must use it, answer, and keep
        // it for the rest of the session.
        const STALE: u16 = 4567;
        const FRESH: u16 = 6004;
        let dir = temp_dir("retry");
        let mut config = Config {
            session: "s1".to_string(),
            port: STALE,
            data_dir: dir.clone(),
        };
        let publish = dir.clone();
        let answer = with_fresh_port(&mut config, move |port| {
            let publish = publish.clone();
            async move {
                if port == STALE {
                    // The new daemon came up between the two attempts.
                    write_port_file(&publish, FRESH).unwrap();
                    Err(HttpError::Connect("127.0.0.1".to_string()))
                } else {
                    Ok(format!("answer from {port}"))
                }
            }
        })
        .await;
        assert_eq!(answer.unwrap(), format!("answer from {FRESH}"));
        assert_eq!(config.port, FRESH, "the fresh port is kept for the session");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_timeout_is_not_retried_even_when_the_port_moved() {
        // A wedged daemon that accepts and then stalls is a timeout, not the
        // restart gap: retrying it would double the harness's wait on the same
        // daemon. The file moving under the first attempt is exactly the case
        // the old any-error retry would have retried, so this fails on it.
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        const FIRST: u16 = 6006;
        const SECOND: u16 = 6007;
        let dir = temp_dir("timeout");
        write_port_file(&dir, FIRST).unwrap();
        let mut config = Config {
            session: "s1".to_string(),
            port: 4567,
            data_dir: dir.clone(),
        };
        let publish = dir.clone();
        let tries = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&tries);
        let err = with_fresh_port(&mut config, move |port| {
            let counted = Arc::clone(&counted);
            let publish = publish.clone();
            async move {
                counted.fetch_add(1, Ordering::SeqCst);
                if port == FIRST {
                    // The daemon republished its port while the call was pending.
                    write_port_file(&publish, SECOND).unwrap();
                }
                Err::<String, HttpError>(HttpError::Timeout)
            }
        })
        .await
        .unwrap_err();
        assert!(
            matches!(err, HttpError::Timeout),
            "the timeout itself comes back, not a retry: {err}"
        );
        assert_eq!(
            tries.load(Ordering::SeqCst),
            1,
            "a timeout is not the restart gap and must not be retried"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_call_that_fails_twice_reports_the_failure_it_already_reported() {
        // Nothing fresher to try: the caller gets the same sentence as before,
        // and only one attempt is made when the published port has not moved.
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        const STALE: u16 = 4567;
        let dir = temp_dir("twice");
        let mut config = Config {
            session: "s1".to_string(),
            port: STALE,
            data_dir: dir.clone(),
        };
        let tries = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&tries);
        let err = with_fresh_port(&mut config, move |port| {
            let counted = Arc::clone(&counted);
            async move {
                counted.fetch_add(1, Ordering::SeqCst);
                assert_eq!(port, STALE);
                Err::<String, HttpError>(HttpError::Connect("127.0.0.1".to_string()))
            }
        })
        .await
        .unwrap_err();
        assert!(err.to_string().contains("127.0.0.1"), "{err}");
        assert_eq!(
            tries.load(Ordering::SeqCst),
            1,
            "no retry without a fresh port"
        );

        // And when the file does move but the new port is dead too, the second
        // failure is what comes back, not a panic and not the first one hidden.
        write_port_file(&dir, 6005).unwrap();
        let mut config = Config {
            session: "s1".to_string(),
            port: STALE,
            data_dir: dir.clone(),
        };
        let err = with_fresh_port(&mut config, |port| async move {
            Err::<String, HttpError>(HttpError::Connect(format!("dead on {port}")))
        })
        .await
        .unwrap_err();
        assert!(err.to_string().contains("dead on 6005"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
