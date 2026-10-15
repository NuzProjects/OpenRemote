//! The fixture's Grok Build print mode: one run per prompt, emitting the
//! Anthropic-Messages streaming wire (`system/init`, `assistant`,
//! `result`) exactly as the openremote-grok driver expects. The argv the
//! real driver builds is the truth: `--single --output-format
//! streaming-messages-json --cwd <dir> [--model <m>] [--resume <id>] --
//! <text>` - every flag first, then end-of-options, then the prompt as
//! the one positional.
//!
//! Scenarios: `plain` completes the turn; `die` exits after init with no
//! result (the process died mid-turn - the daemon maps it to a failed
//! turn with a note); `slow` holds the turn open for a moment (the e2e
//! fires a second prompt inside the Working window).

use std::io::{BufRead, Write};

use serde_json::{Value, json};

const SESSION_ID: &str = "grok-fixture-1";

pub fn main_grok(argv: &[String]) {
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
        .open("fixture-grok-runs")
    {
        let _ = writeln!(runs, "run");
    }
    if scenario == "slow" {
        // Long enough for the e2e's second prompt to land inside the
        // turn, short enough not to slow the suite down.
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }

    // argv: [.., --single, --output-format, streaming-messages-json,
    //        --cwd, <dir>, (--model, <m>)?, (--permission-mode, <mode>)?,
    //        (--resume, <id>)?, --, <text>]
    // `--` is end-of-options (harness audit F6), yargs-class in spirit:
    // the prompt is the one positional after it, whatever it starts with.
    // A dash-leading prompt that arrived as a bare argv word would fall
    // through the arms below as an unknown flag and the echo would name
    // the bug - that is the regression the e2e watches for.
    let mut prompt = String::new();
    let mut resume: Option<String> = None;
    let mut model = String::from("grok-4.7-fixture");
    let mut permission_mode = String::from("default");
    let mut positional = false;
    let mut i = 0;
    while i < argv.len() {
        if positional {
            prompt = argv[i].clone();
            break;
        }
        match argv[i].as_str() {
            "--" => positional = true,
            // Mode flag - the prompt is the positional after `--`, not
            // this flag's value.
            "--single" => {}
            "--resume" => {
                if let Some(id) = argv.get(i + 1) {
                    resume = Some(id.clone());
                    i += 1;
                }
            }
            "--model" => {
                if let Some(m) = argv.get(i + 1) {
                    model = m.clone();
                    i += 1;
                }
            }
            "--permission-mode" => {
                if let Some(mode) = argv.get(i + 1) {
                    permission_mode = mode.clone();
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }

    let session_id = resume.unwrap_or_else(|| SESSION_ID.to_string());
    let out = |value: Value| {
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer(&mut stdout, &value).ok();
        stdout.write_all(b"\n").ok();
        stdout.flush().ok();
    };

    out(json!({
        "type": "system",
        "subtype": "init",
        "session_id": session_id,
        "model": model,
        "permissionMode": permission_mode,
        "cwd": "."
    }));
    if scenario == "die" {
        // The process dies mid-turn: no assistant, no result.
        eprintln!("fixture-grok: dying mid-turn");
        return;
    }
    out(json!({
        "type": "assistant",
        "session_id": SESSION_ID,
        "message": {
            "id": "msg_fixture",
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": format!("done: {prompt}")}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 5}
        }
    }));
    out(json!({
        "type": "result",
        "subtype": "success",
        "session_id": SESSION_ID,
        "result": format!("done: {prompt}"),
        "is_error": false,
        "num_turns": 1,
        "usage": {"input_tokens": 10, "output_tokens": 5}
    }));
    // Keep stdin semantics irrelevant (grok runs with stdin closed); the
    // reader sees EOF and the result frame already ended the turn.
    let _ = std::io::stdin().lock().lines().next();
}
