//! The fixture's Antigravity print mode: one run per prompt, emitting
//! agy's own frame family - `{event: "init", conversation_id}`,
//! `{event: "step_update", …}`, `{event: "result", result: {status,
//! response}}` where status is Antigravity's own word (`SUCCESS`).
//! The argv the real driver builds is the truth: `--output-format
//! stream-json [--model <m>] [--mode <mode>] [--conversation <id>]
//! --print <text>`. agy 1.4+ takes the word after `--print` as the
//! prompt, so the prompt rides there, not as a positional after `--`.
//! `--conversation <id>` resumes; `models` (the subcommand) prints the
//! TSV catalog.

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

    // argv: [--output-format, stream-json, (--model, <m>)?, (--mode, <mode>)?,
    //        (--conversation, <id>)?, --print, <text>]
    // The prompt is `--print`'s value, including a dash-leading one. The
    // e2e watches that "-v ..." comes back as text, not a flag guess.
    let mut prompt = String::new();
    let mut conversation: Option<String> = None;
    let mut model = String::from("gemini-3.8-flash-medium");
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
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
                }
            }
        }
        i += 1;
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
    let _ = std::io::stdin().lock().lines().next();
}
