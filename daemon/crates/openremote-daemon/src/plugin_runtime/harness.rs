//! A harness a plugin drives: the plugin's program speaks for the CLI it
//! wraps, through `harness/*` calls and `harness/event` notifications, and
//! OpenRemote treats the result like the built-in six - pickers list it,
//! chats run on it, its events fill the transcript, its asks become
//! decisions.
//!
//! One plugin program drives any number of chats at once; each chat is a
//! session handle OpenRemote picks (`s-<uuid>`) and names in every call
//! and event.

use std::sync::{Arc, Weak};
use std::time::Duration;

use openremote_core::{DecisionKind, DecisionOption, HarnessContribution, TurnOutcome};
use openremote_harness::events::{ApprovalRequest, DecisionSpec};
use openremote_harness::{
    AgentDescriptor, AnswerOutcome, CommandCatalog, CommandDescriptor, DriverError, DriverEvent,
    ModelDescriptor, SessionSettings, SpawnOptions,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::PluginRuntime;
use super::process::{Conn, RpcError};

const SPAWN: Duration = Duration::from_secs(60);
const CALL: Duration = Duration::from_secs(30);
const STOP: Duration = Duration::from_secs(10);
const LIST: Duration = Duration::from_secs(20);

/// A plugin harness in the registry: which plugin, which of its harnesses.
#[derive(Clone)]
pub struct PluginBackend {
    pub runtime: Weak<PluginRuntime>,
    pub plugin: String,
    pub spec: HarnessContribution,
}

fn driver_error(e: RpcError) -> DriverError {
    if e.code == -32000 {
        DriverError::Gone
    } else {
        DriverError::Harness(e.message)
    }
}

impl PluginBackend {
    async fn conn(&self) -> Result<Arc<Conn>, DriverError> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| DriverError::Spawn("OpenRemote is stopping".into()))?;
        runtime
            .process(&self.plugin)
            .await
            .map_err(DriverError::Spawn)
    }

    /// Start a chat: the plugin opens a session of its harness and names
    /// the harness's own conversation, which a resume hands back.
    pub async fn spawn(
        &self,
        opts: SpawnOptions,
    ) -> Result<(PluginDriver, mpsc::Receiver<DriverEvent>), DriverError> {
        let conn = self.conn().await?;
        let session = format!("s-{}", uuid::Uuid::new_v4());
        let (tx, rx) = mpsc::channel(256);
        conn.attach(&session, tx.clone());
        let params = json!({
            "session": session,
            "harness": self.spec.id,
            "cwd": opts.cwd,
            "model": opts.model,
            "effort": opts.effort,
            "permission_mode": opts.permission_mode,
            "resume": opts.resume,
            "fast": opts.fast,
            // OpenRemote's MCP servers for this chat (its own per-chat
            // server among them), for a harness that can take MCP.
            "mcp_servers": opts.mcp_servers.iter().map(|s| json!({
                "id": s.id, "command": s.command, "args": s.args,
            })).collect::<Vec<_>>(),
            "allowed_tools": opts.allowed_tools,
        });
        let reply = match conn.call("harness/spawn", params, SPAWN).await {
            Ok(reply) => reply,
            Err(e) => {
                conn.detach(&session);
                return Err(DriverError::Spawn(e.message));
            }
        };
        // The plugin may name its conversation in the answer, or in an
        // `initialized` event of its own later.
        if reply.get("session_ref").is_some() || reply.get("model").is_some() {
            let _ = tx
                .send(DriverEvent::Initialized {
                    session_ref: text(&reply, "session_ref").unwrap_or_else(|| session.clone()),
                    model: text(&reply, "model"),
                    permission_mode: text(&reply, "permission_mode"),
                })
                .await;
        }
        Ok((
            PluginDriver {
                conn,
                session,
                tx,
                one_prompt_at_a_time: self.spec.one_prompt_at_a_time,
                steers_mid_turn: self.spec.steers_mid_turn,
            },
            rx,
        ))
    }

    /// Its models: the manifest's list when it gives one (no program
    /// starts for a picker), else the plugin's own answer.
    pub async fn models(&self) -> Result<Option<Vec<ModelDescriptor>>, DriverError> {
        if !self.spec.models.is_empty() {
            return Ok(Some(
                self.spec
                    .models
                    .iter()
                    .map(|m| ModelDescriptor {
                        model: m.model.clone(),
                        display_name: m.display_name.clone(),
                        resolved_model: None,
                        reasoning_efforts: m.efforts.clone(),
                        is_default: m.default,
                    })
                    .collect(),
            ));
        }
        let conn = self.conn().await?;
        match conn
            .call("harness/models", json!({"harness": self.spec.id}), LIST)
            .await
        {
            Ok(reply) => Ok(Some(
                reply
                    .get("models")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|m| {
                                Some(ModelDescriptor {
                                    model: text(m, "model")?,
                                    display_name: text(m, "display_name"),
                                    resolved_model: None,
                                    reasoning_efforts: strings(m, "efforts"),
                                    is_default: m
                                        .get("default")
                                        .and_then(Value::as_bool)
                                        .unwrap_or(false),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            )),
            Err(e) if e.is_missing_method() => Ok(None),
            Err(e) => Err(driver_error(e)),
        }
    }

    /// What a composer's / and @ menus offer for it, when the plugin
    /// lists anything.
    pub async fn commands(
        &self,
        cwd: &std::path::Path,
    ) -> Result<Option<CommandCatalog>, DriverError> {
        let conn = self.conn().await?;
        match conn
            .call(
                "harness/commands",
                json!({"harness": self.spec.id, "cwd": cwd}),
                LIST,
            )
            .await
        {
            Ok(reply) => Ok(Some(CommandCatalog {
                commands: list(&reply, "commands")
                    .iter()
                    .filter_map(|c| {
                        Some(CommandDescriptor {
                            name: text(c, "name")?,
                            description: text(c, "description"),
                            argument_hint: text(c, "argument_hint"),
                            aliases: strings(c, "aliases"),
                        })
                    })
                    .collect(),
                agents: list(&reply, "agents")
                    .iter()
                    .filter_map(|a| {
                        Some(AgentDescriptor {
                            name: text(a, "name")?,
                            description: text(a, "description"),
                        })
                    })
                    .collect(),
            })),
            Err(e) if e.is_missing_method() => Ok(None),
            Err(e) => Err(driver_error(e)),
        }
    }

    /// The model a fresh chat runs: the manifest's default.
    pub fn default_model(&self) -> Option<(String, Option<String>)> {
        self.spec
            .models
            .iter()
            .find(|m| m.default)
            .map(|m| (m.model.clone(), None))
    }
}

/// One chat on a plugin harness.
pub struct PluginDriver {
    conn: Arc<Conn>,
    session: String,
    /// The chat's own channel, to close it when the chat stops.
    tx: mpsc::Sender<DriverEvent>,
    one_prompt_at_a_time: bool,
    steers_mid_turn: bool,
}

impl PluginDriver {
    pub async fn send_prompt(&mut self, text: &str) -> Result<(), DriverError> {
        self.conn
            .call(
                "harness/prompt",
                json!({"session": self.session, "text": text}),
                CALL,
            )
            .await
            .map(|_| ())
            .map_err(driver_error)
    }

    pub async fn apply_settings(&mut self, settings: &SessionSettings) -> Result<(), DriverError> {
        self.conn
            .call(
                "harness/settings",
                json!({
                    "session": self.session,
                    "model": settings.model,
                    "effort": settings.effort,
                    "fast": settings.fast,
                }),
                CALL,
            )
            .await
            .map(|_| ())
            .map_err(driver_error)
    }

    pub async fn interrupt(&mut self) -> Result<(), DriverError> {
        self.conn
            .call("harness/interrupt", json!({"session": self.session}), CALL)
            .await
            .map(|_| ())
            .map_err(driver_error)
    }

    /// Answer one of the harness's asks with the choice id it offered.
    pub async fn answer(
        &mut self,
        harness_ref: &str,
        choice: &str,
        request: &Value,
    ) -> Result<AnswerOutcome, DriverError> {
        let reply = self
            .conn
            .call(
                "harness/answer",
                json!({
                    "session": self.session,
                    "ref": harness_ref,
                    "choice": choice,
                    "request": request,
                }),
                CALL,
            )
            .await
            .map_err(driver_error)?;
        Ok(AnswerOutcome {
            interrupts_turn: reply
                .get("interrupts_turn")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            session_grant: text(&reply, "session_grant"),
        })
    }

    /// End the chat's session. The plugin's program keeps running for its
    /// other chats and tools.
    pub async fn shutdown(&mut self) -> Result<Option<i32>, DriverError> {
        let reply = self
            .conn
            .call("harness/stop", json!({"session": self.session}), STOP)
            .await
            .unwrap_or(Value::Null);
        if self.conn.detach(&self.session).is_some() {
            let _ = self.tx.send(DriverEvent::StdoutClosed).await;
        }
        Ok(reply
            .get("exit_code")
            .and_then(Value::as_i64)
            .map(|c| c as i32))
    }

    pub fn per_prompt_process(&self) -> bool {
        self.one_prompt_at_a_time
    }

    pub fn steers_mid_turn(&self) -> bool {
        self.steers_mid_turn
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    list(v, key)
        .iter()
        .filter_map(|s| s.as_str().map(String::from))
        .collect()
}

fn list(v: &Value, key: &str) -> Vec<Value> {
    v.get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// One `harness/event` from the plugin, as the supervisor's vocabulary.
/// An event type this OpenRemote doesn't know is skipped.
pub fn driver_event(event: &Value) -> Option<DriverEvent> {
    let kind = event.get("type").and_then(Value::as_str)?;
    Some(match kind {
        "initialized" => DriverEvent::Initialized {
            session_ref: text(event, "session_ref")?,
            model: text(event, "model"),
            permission_mode: text(event, "permission_mode"),
        },
        "text" => DriverEvent::AssistantText {
            text: text(event, "text")?,
        },
        "text_delta" => DriverEvent::TextDelta {
            text: text(event, "text")?,
        },
        "reasoning" => DriverEvent::ReasoningText {
            text: text(event, "text")?,
        },
        "reasoning_delta" => DriverEvent::ReasoningDelta {
            text: text(event, "text")?,
        },
        "tool_started" => DriverEvent::ToolStarted {
            tool_use_id: text(event, "id").unwrap_or_default(),
            name: text(event, "name").unwrap_or_else(|| "tool".into()),
            input: event.get("input").cloned().unwrap_or(Value::Null),
        },
        "tool_result" => DriverEvent::ToolResult {
            tool_use_id: text(event, "id").unwrap_or_default(),
            name: text(event, "name").unwrap_or_else(|| "tool".into()),
            text: text(event, "text").unwrap_or_default(),
            is_error: event
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        "approval" | "question" => {
            let options = list(event, "options")
                .iter()
                .filter_map(|o| {
                    Some(DecisionOption {
                        id: text(o, "id")?,
                        label: text(o, "label").or_else(|| text(o, "id"))?,
                    })
                })
                .collect();
            DriverEvent::ApprovalRequested {
                approval: ApprovalRequest {
                    harness_ref: text(event, "ref")?,
                    request: event
                        .get("request")
                        .cloned()
                        .unwrap_or_else(|| event.clone()),
                    spec: DecisionSpec {
                        kind: if kind == "question" {
                            DecisionKind::Question
                        } else {
                            DecisionKind::Approval
                        },
                        options,
                        tool_name: text(event, "tool_name"),
                        summary: text(event, "summary"),
                        interrupts_turn: strings(event, "interrupts_turn"),
                    },
                },
            }
        }
        "turn_completed" => {
            let outcome = text(event, "outcome").unwrap_or_else(|| "completed".into());
            let coarse = match outcome.as_str() {
                "completed" => TurnOutcome::Completed,
                "interrupted" => TurnOutcome::Interrupted,
                _ => TurnOutcome::Failed,
            };
            DriverEvent::TurnCompleted {
                subtype: text(event, "subtype").unwrap_or(outcome),
                is_error: coarse == TurnOutcome::Failed,
                coarse,
                error_message: text(event, "error"),
            }
        }
        "context" => DriverEvent::ContextUsed {
            used: event.get("used").and_then(Value::as_u64)?,
            window: event.get("window").and_then(Value::as_u64),
        },
        "cost" => DriverEvent::TurnCost {
            cost_usd: event.get("usd").and_then(Value::as_f64)?,
        },
        "compacted" => DriverEvent::Compacted,
        "model" => DriverEvent::ModelReported {
            model: text(event, "model")?,
        },
        "commands" => DriverEvent::CommandsListed {
            names: strings(event, "names"),
        },
        "stderr" => DriverEvent::Stderr {
            line: text(event, "line")?,
        },
        "closed" => DriverEvent::StdoutClosed,
        _ => return None,
    })
}
