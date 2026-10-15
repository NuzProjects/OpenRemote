//! OpenCode's commands and agents for a composer: a short-lived
//! `opencode serve` in the chat's folder, its own `GET /command` and
//! `GET /agent`, killed once both land. No session is created and nothing
//! is sent to a model.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use openremote_harness::{
    AgentDescriptor, CommandCatalog, CommandDescriptor, DriverError, Resolution,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

pub async fn commands(resolution: &Resolution, cwd: &Path) -> Result<CommandCatalog, DriverError> {
    let mut command = match resolution {
        Resolution::Executable(path) => Command::new(path),
        Resolution::NodeScript { node, script } => {
            let mut c = Command::new(node);
            c.arg(script);
            c
        }
        Resolution::Unavailable => {
            return Err(DriverError::Spawn("opencode CLI not found".to_string()));
        }
    };
    let password = Uuid::new_v4().to_string();
    command
        .args(["serve", "--port", "0", "--hostname", "127.0.0.1"])
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(openremote_harness::creation_flags());
    let mut child = command
        .spawn()
        .map_err(|e| DriverError::Spawn(format!("opencode commands: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| DriverError::Spawn("stdout not piped".into()))?;
    let ask = async {
        let mut lines = BufReader::new(stdout).lines();
        let port = loop {
            let Some(line) = lines.next_line().await? else {
                return Err(DriverError::Protocol(
                    "opencode exited before listening".into(),
                ));
            };
            if let Some(url) = line.strip_prefix("opencode server listening on ") {
                break url
                    .rsplit(':')
                    .next()
                    .and_then(|p| p.trim().parse::<u16>().ok())
                    .ok_or_else(|| DriverError::Protocol(format!("bad listening line: {line}")))?;
            }
        };
        let client = crate::http::HttpClient::new(port, &password);
        let commands = client.get("/command").await?;
        let agents = client.get("/agent").await?;
        Ok::<_, DriverError>(catalog(&commands, &agents))
    };
    let answer = tokio::time::timeout(Duration::from_secs(30), ask).await;
    let _ = child.start_kill();
    match answer {
        Ok(result) => result,
        Err(_) => Err(DriverError::Protocol(
            "opencode did not answer in time".into(),
        )),
    }
}

/// OpenCode's command and agent lists in its own words. A primary agent is
/// a mode the chat runs in, not one a prompt mentions; hidden ones stay
/// hidden.
fn catalog(commands: &Value, agents: &Value) -> CommandCatalog {
    let text = |v: &Value, key: &str| {
        v.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    CommandCatalog {
        commands: commands
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| {
                Some(CommandDescriptor {
                    name: text(c, "name")?,
                    description: text(c, "description"),
                    argument_hint: None,
                    aliases: Vec::new(),
                })
            })
            .collect(),
        agents: agents
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| {
                a.get("mode").and_then(Value::as_str) != Some("primary")
                    && a.get("hidden").and_then(Value::as_bool) != Some(true)
            })
            .filter_map(|a| {
                Some(AgentDescriptor {
                    name: text(a, "name")?,
                    description: text(a, "description"),
                })
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_opencodes_own_lists() {
        let commands =
            json!([{"name": "init", "description": "guided AGENTS.md setup", "template": "x"}]);
        let agents = json!([
            {"name": "build", "description": "default", "mode": "primary"},
            {"name": "general", "description": "General-purpose", "mode": "subagent"},
            {"name": "secret", "mode": "subagent", "hidden": true}
        ]);
        let c = catalog(&commands, &agents);
        assert_eq!(c.commands[0].name, "init");
        let agents: Vec<&str> = c.agents.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(agents, vec!["general"]);
    }
}
