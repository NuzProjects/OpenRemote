//! Pi's commands for a composer: a short-lived `pi --mode rpc` in the
//! chat's folder, its own `get_commands` (prompt templates, skills as
//! `skill:<name>`, extension commands), killed once the list lands. No
//! session is saved and nothing is sent to a model. A prompt that starts
//! with `/name` runs the command in pi itself.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use openremote_harness::{CommandCatalog, CommandDescriptor, DriverError, Resolution, kill_tree};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

pub async fn commands(resolution: &Resolution, cwd: &Path) -> Result<CommandCatalog, DriverError> {
    let (program, prefix): (PathBuf, Vec<std::ffi::OsString>) = match resolution {
        Resolution::Executable(path) => (path.clone(), Vec::new()),
        Resolution::NodeScript { node, script } => {
            (node.clone(), vec![script.as_os_str().to_os_string()])
        }
        Resolution::Unavailable => {
            return Err(DriverError::Spawn("pi CLI not found".to_string()));
        }
    };
    let mut command = Command::new(program);
    command
        .args(&prefix)
        .args(["--mode", "rpc", "--no-session"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(openremote_harness::creation_flags());
    let mut child = command
        .spawn()
        .map_err(|e| DriverError::Spawn(format!("pi commands: {e}")))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| DriverError::Spawn("stdin not piped".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| DriverError::Spawn("stdout not piped".into()))?;
    let exchange = async {
        stdin
            .write_all(b"{\"id\":\"or-commands\",\"type\":\"get_commands\"}\n")
            .await?;
        stdin.flush().await?;
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await? {
            let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if frame.get("id").and_then(Value::as_str) == Some("or-commands") {
                return Ok::<_, std::io::Error>(Some(frame));
            }
        }
        Ok(None)
    };
    let answer = tokio::time::timeout(Duration::from_secs(30), exchange).await;
    kill_tree(&mut child).await;
    let frame = match answer {
        Ok(Ok(Some(frame))) => frame,
        Ok(Ok(None)) => {
            return Err(DriverError::Protocol(
                "pi closed before get_commands".into(),
            ));
        }
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => return Err(DriverError::Protocol("pi get_commands timed out".into())),
    };
    if frame.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(DriverError::Harness(format!(
            "pi rejected get_commands: {}",
            frame.get("error").cloned().unwrap_or(Value::Null)
        )));
    }
    Ok(catalog(&frame))
}

/// The commands in a `get_commands` answer, in pi's own words.
fn catalog(frame: &Value) -> CommandCatalog {
    let commands = frame
        .pointer("/data/commands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            Some(CommandDescriptor {
                name: c.get("name").and_then(Value::as_str)?.to_string(),
                description: c
                    .get("description")
                    .and_then(Value::as_str)
                    .filter(|d| !d.is_empty())
                    .map(String::from),
                argument_hint: None,
                aliases: Vec::new(),
            })
        })
        .collect();
    CommandCatalog {
        commands,
        agents: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_pis_own_answer() {
        let frame = serde_json::json!({
            "id": "or-commands", "type": "response", "command": "get_commands", "success": true,
            "data": {"commands": [
                {"name": "mcp", "description": "Manage MCP servers", "source": "extension"},
                {"name": "skill:recon", "description": "Recon", "source": "skill"},
                {"description": "nameless"}
            ]}
        });
        let names: Vec<String> = catalog(&frame)
            .commands
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["mcp", "skill:recon"]);
    }
}
