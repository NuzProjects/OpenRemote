//! The fixture's Antigravity print mode: one run per prompt, emitting
//! agy's own frame family - `{event: "init", conversation_id}`,
//! `{event: "step_update", …}`, `{event: "result", result: {status,
//! response}}` where status is Antigravity's own word (`SUCCESS`).
//! The argv the real driver builds is the truth: `--output-format
//! stream-json --input-format stream-json [--model <m>] [--mode <mode>]
//! [--conversation <id>] --print=`. The prompt is one NDJSON message on
//! stdin (`{"event":"user","message":{"role":"user","content":[{"type":
//! "text","text":…}]}}`), never an argv word, so chat text stays clear of
//! the CLI's own option parser. The inline `--print <text>` form is still
//! read because the CLI still has it. `--conversation <id>` resumes;
//! `models` (the subcommand) prints the TSV catalog.

use std::io::{BufRead, Write};

use serde_json::{Value, json};

pub fn main_agy(argv: &[String]) {
    // The models subcommand: the TSV catalog.
    if argv.first().is_some_and(|a| a == "models") {
        let mut stdout = std::io::stdout().lock();
        for (id, name) in [
            ("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"),
            ("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"),
        ] {
            let _ = writeln!(stdout, "{id}\t{name}");
        }
        return;
    }

    let scenario = std::env::var("FIXTURE_AGENT_SCENARIO")
        .ok()
        .or_else(|| {
            std::fs::read_to_string("fixture-scenario")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "plain".to_string());

    // One line per run (harness audit F8): the e2e counts these to prove a
    // refused prompt never spawned a second process - the transcript can
    // only show what a process said; this shows whether it existed.
    if let Ok(mut runs) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("fixture-agy-runs")
    {
        let _ = writeln!(runs, "run");
    }
    if scenario == "slow" {
        // Long enough for the e2e's second prompt to land inside the
        // turn, short enough not to slow the suite down.
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }

    // argv: [--output-format, stream-json, --input-format, stream-json,
    //        (--model, <m>)?, (--mode, <mode>)?, (--conversation, <id>)?,
    //        --print=]
    // The prompt arrives on stdin; the inline forms are read too because
    // the CLI has them. The e2e watches that "-v ..." comes back as text,
    // whichever form carried it.
    let mut prompt = String::new();
    let mut conversation: Option<String> = None;
    let mut model = String::from("gemini-3.8-flash-medium");
    let mut prompt_on_stdin = false;
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--input-format" => {
                if argv.get(i + 1).is_some_and(|form| form == "stream-json") {
                    prompt_on_stdin = true;
                    i += 1;
                }
            }
            "--print" | "--prompt" | "-p" => {
                if let Some(text) = argv.get(i + 1) {
                    prompt = text.clone();
                    i += 1;
                }
            }
            "--conversation" => {
                if let Some(id) = argv.get(i + 1) {
                    conversation = Some(id.clone());
                    i += 1;
                }
            }
            "--model" => {
                if let Some(m) = argv.get(i + 1) {
                    model = m.clone();
                    i += 1;
                }
            }
            other => {
                if let Some(text) = other.strip_prefix("--print=") {
                    prompt = text.to_string();
                } else if let Some(text) = other.strip_prefix("--prompt=") {
                    prompt = text.to_string();
                } else if let Some(text) = other.strip_prefix("-p=") {
                    prompt = text.to_string();
                }
            }
        }
        i += 1;
    }
    if prompt_on_stdin && prompt.is_empty() {
        prompt = read_stdin_prompt();
    }

    // A fresh conversation unless resumed (see grok.rs).
    let conversation =
        conversation.unwrap_or_else(|| format!("agy-fixture-conversation-{}", std::process::id()));
    let out = |value: Value| {
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer(&mut stdout, &value).ok();
        stdout.write_all(b"\n").ok();
        stdout.flush().ok();
    };

    out(json!({
        "event": "init",
        "conversation_id": conversation,
        "init": {"cwd": ".", "model": model, "tools": ["ask_permission", "read_file", "edit_file"]}
    }));
    if scenario == "die" {
        eprintln!("fixture-agy: dying mid-turn");
        return;
    }
    out(json!({
        "event": "step_update",
        "step_update": {"conversation_id": conversation, "step_index": 1, "state": "ACTIVE",
                        "step_type": "agent_response", "text_delta": "work"}
    }));
    out(json!({
        "event": "result",
        "result": {"conversation_id": conversation, "status": "SUCCESS",
                   "response": format!("done: {prompt}\n"), "num_turns": 1,
                   "usage": {"input_tokens": 10, "output_tokens": 5}}
    }));
}

/// The one user message print mode reads from stdin.
///
/// agy names each stream-input line `event`, and a user turn carries an
/// Anthropic-shaped message body; the prompt is the text blocks inside it.
/// Anything else reads as an empty prompt, the way the CLI refuses a line
/// before it ever starts a turn.
fn read_stdin_prompt() -> String {
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    let Ok(frame) = serde_json::from_str::<Value>(line.trim()) else {
        return String::new();
    };
    frame
        .pointer("/message/content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}
