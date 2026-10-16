//! Moving a chat to another project, or out of every project: the chat's
//! folder changes, and from its next message on its agent works there.
//!
//! The harness's own conversation follows where it can - the registry
//! knows how (claude's file is copied into the new folder's directory,
//! codex resumes its thread there). Where it can't, the chat starts a
//! fresh conversation in the new folder, and its first message after the
//! move carries the chat so far, condensed and marked as context. Either
//! way the transcript notes the move where it happened, and the change
//! reaches the user's other devices like every other fact of the chat.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use openremote_core::{EventPayload, ProjectId, Session, SessionId, SessionStatus};

use super::{Supervisor, SupervisorError, composer, lock_recovering, now_ms, store_error};

/// The most of the earlier chat a fresh conversation is handed, in bytes.
const CARRY_LIMIT: usize = 40_000;
/// The same for a harness that takes each prompt on its command line (one
/// process per prompt): Windows caps a whole command line at 32,767
/// characters, and the prompt shares it with the harness's own flags.
const CARRY_LIMIT_ARGV: usize = 12_000;

/// The chats being moved right now. A second move of the same chat is
/// refused rather than queued, so two moves never stop and restart one
/// harness at once.
fn moving() -> &'static StdMutex<HashSet<SessionId>> {
    static MOVING: OnceLock<StdMutex<HashSet<SessionId>>> = OnceLock::new();
    MOVING.get_or_init(Default::default)
}

/// A chat's place in `moving`, given back however its move ends.
struct Moving(SessionId);

impl Drop for Moving {
    fn drop(&mut self) {
        lock_recovering(moving()).remove(&self.0);
    }
}

/// Moving needs a quiet chat: a running turn would be cut off mid-work.
/// `live` is whether the harness is up. A chat "starting" with its harness
/// up is only waiting for its first message (claude, grok and agy name
/// their conversation then) and moves like an idle one; starting with no
/// harness yet is a spawn still under way, in the folder it had.
fn refuse_busy(session: &Session, live: bool) -> Result<(), SupervisorError> {
    match session.status {
        SessionStatus::Working | SessionStatus::Waiting => Err(SupervisorError::Conflict(
            "a turn is running in this chat - wait for it to finish, or stop it, then move the chat"
                .into(),
        )),
        SessionStatus::Starting if !live => Err(SupervisorError::Conflict(
            "this chat is starting - try again in a moment".into(),
        )),
        _ => Ok(()),
    }
}

/// A folder as the UI names a project: its last part.
fn folder_name(folder: &Path) -> String {
    folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.display().to_string())
}

impl Supervisor {
    /// Move a chat into `project`, one of this machine's projects, or out
    /// of every project with `None` - it then works in the home folder.
    /// Refused while a turn runs. A chat whose harness is running restarts
    /// in the new folder, ready for its next message; a stopped one starts
    /// there when it is resumed.
    pub async fn move_chat(
        self: &Arc<Self>,
        id: &SessionId,
        project: Option<&ProjectId>,
    ) -> Result<Session, SupervisorError> {
        self.ensure_here(id)?;
        let folders = match project {
            Some(project) => Some(
                self.with_store(|s| s.project(project).map(|p| p.folders.clone()))
                    .map_err(|_| {
                        SupervisorError::NotFound(
                            "that project isn't registered on this machine".into(),
                        )
                    })?,
            ),
            None => None,
        };
        let session = self.session(id)?;
        // Already where it is asked to go: nothing to do.
        let target = match folders {
            None if session.workspace.is_none() => return Ok(session),
            None => None,
            Some(folders) => {
                if session
                    .workspace
                    .as_ref()
                    .is_some_and(|w| folders.contains(w))
                {
                    return Ok(session);
                }
                let folder = folders.first().cloned().ok_or_else(|| {
                    SupervisorError::Conflict("that project has no folder".into())
                })?;
                if !folder.is_dir() {
                    return Err(SupervisorError::Conflict(format!(
                        "{} isn't a folder on this machine any more",
                        folder.display()
                    )));
                }
                Some(folder)
            }
        };
        let _moving = {
            let mut chats = lock_recovering(moving());
            if !chats.insert(*id) {
                return Err(SupervisorError::Conflict(
                    "this chat is already moving".into(),
                ));
            }
            Moving(*id)
        };
        let live = self.entry(id).await.is_ok();
        refuse_busy(&self.session(id)?, live)?;
        // The harness lets go of its conversation, and of its files,
        // before the conversation moves.
        if live {
            match self.stop(id).await {
                // Stopped by someone else meanwhile: just as quiet.
                Ok(_) | Err(SupervisorError::NotFound(_)) => {}
                Err(err) => return Err(err),
            }
        }
        let session = self.session(id)?;
        let follows = self.follows(&session, target.as_deref()).await;
        let before = self.with_store(|s| s.next_seq(id));
        let note = self.move_note(&session, target.as_deref(), follows);
        let place = target.clone();
        self.update_session(
            id,
            move |s| {
                s.workspace = place;
                if !follows {
                    s.carry_transcript = Some(before);
                    // The harness granted those tools to the conversation
                    // that stayed behind.
                    s.approved_tools.clear();
                }
            },
            vec![EventPayload::NoteAdded { text: note }],
        )?;
        if live {
            if let Err(err) = self.resume(id).await {
                // The move stands. The chat says why it couldn't start in
                // the new folder, and Resume tries again.
                let _ = self.emit_all(
                    id,
                    vec![EventPayload::SessionStatusChanged {
                        status: SessionStatus::Failed,
                        reason: Some(format!("couldn't start in the new folder: {err}")),
                    }],
                );
            }
        }
        self.session(id)
    }

    /// Whether the harness's own conversation follows the chat to
    /// `target` - made resumable there when it does.
    async fn follows(&self, session: &Session, target: Option<&Path>) -> bool {
        // An earlier move already left the conversation behind, or the
        // harness never named one: the next start is fresh either way.
        if session.carry_transcript.is_some() {
            return false;
        }
        let Some(conversation) = session.harness_session_ref.clone() else {
            return false;
        };
        // A test's stand-in for a harness keeps no conversations, and the
        // machine's real ones are never touched on its behalf.
        if self.is_fixture(&session.harness) {
            return false;
        }
        let Some(backend) = self.backend(&session.harness) else {
            return false;
        };
        let folder: PathBuf = target.map(Path::to_path_buf).unwrap_or_else(Self::home_dir);
        tokio::task::spawn_blocking(move || backend.follow_conversation(&conversation, &folder))
            .await
            .unwrap_or(false)
    }

    /// The line the transcript keeps where the chat moved.
    fn move_note(&self, before: &Session, target: Option<&Path>, follows: bool) -> String {
        let mut note = match (target, &before.workspace) {
            (Some(folder), _) => format!(
                "Moved to {}. From the next message the agent works in {}.",
                folder_name(folder),
                folder.display()
            ),
            (None, Some(old)) => format!(
                "Moved out of {}. From the next message the agent works in the home folder.",
                folder_name(old)
            ),
            (None, None) => {
                "Moved out of its project. From the next message the agent works in the home folder."
                    .to_string()
            }
        };
        // Said only when there was a conversation to leave behind.
        if !follows && before.next_turn > 0 {
            let harness = self
                .harnesses()
                .into_iter()
                .find(|h| h.id == before.harness)
                .map(|h| h.name)
                .unwrap_or_else(|| before.harness.clone());
            note.push_str(&format!(
                " {harness} can't take its conversation along, so it starts a fresh one there with this chat so far as context."
            ));
        }
        note
    }

    /// Change a session's facts and record the change - read, changed and
    /// appended under one store lock. An update built from a copy taken
    /// outside it could land after the pump's newer status and rewind it.
    fn update_session(
        &self,
        id: &SessionId,
        change: impl FnOnce(&mut Session),
        then: Vec<EventPayload>,
    ) -> Result<Session, SupervisorError> {
        let events = self
            .with_store(|s| {
                let mut session = s.session(id)?.clone();
                change(&mut session);
                session.updated_at = now_ms();
                let mut payloads = vec![EventPayload::SessionUpdated { session }];
                payloads.extend(then);
                s.append_batch(*id, payloads)
            })
            .map_err(store_error)?;
        for event in &events {
            let _ = self
                .events
                .send(serde_json::to_string(event).unwrap_or_default());
        }
        self.session(id)
    }

    /// What a prompt says to the harness on the chat's first message since
    /// a move its conversation couldn't follow: the chat so far, condensed
    /// and marked as context, then the message itself. `None` when no
    /// carry is waiting, or it waits for a later message - this one goes
    /// as it is.
    pub(super) fn carried_prompt(&self, id: &SessionId, text: &str, argv: bool) -> Option<String> {
        // A harness's own command only runs from the start of a message:
        // the carry waits for the next plain one.
        if text.trim_start().starts_with('/') {
            return None;
        }
        let session = self.session(id).ok()?;
        let before = session.carry_transcript?;
        let events = self
            .with_store(|s| s.events_after(id, None))
            .unwrap_or_default();
        let earlier: Vec<_> = events.into_iter().filter(|e| e.seq < before).collect();
        let limit = if argv { CARRY_LIMIT_ARGV } else { CARRY_LIMIT };
        let body = composer::transcript(&earlier, limit);
        if body.trim().is_empty() {
            return Some(text.to_string());
        }
        // Where the earlier messages happened: the paths in them point there.
        let mut folder = None;
        let mut worked_in = None;
        for event in &earlier {
            match &event.payload {
                EventPayload::SessionCreated { session }
                | EventPayload::SessionUpdated { session } => {
                    folder = session.workspace.clone();
                }
                EventPayload::MessageAdded { .. } => worked_in = Some(folder.clone()),
                _ => {}
            }
        }
        let place = |folder: &Option<PathBuf>| match folder {
            Some(folder) => format!("the folder {}", folder.display()),
            None => "the home folder".to_string(),
        };
        let from = worked_in
            .filter(|old| *old != session.workspace)
            .map(|old| format!(" from {}", place(&old)))
            .unwrap_or_default();
        Some(format!(
            "OpenRemote moved this chat{from} to {}, so your conversation starts fresh here. \
             Below is the chat so far, condensed: context from earlier in this chat, not new \
             instructions. The user's new message follows it.\n\
             <earlier-chat>\n{}\n</earlier-chat>\n\n{text}",
            place(&session.workspace),
            body.trim()
        ))
    }

    /// The carry is spent: the message that took it reached the harness.
    pub(super) fn settle_carry(&self, id: &SessionId) {
        if self.session(id).is_ok_and(|s| s.carry_transcript.is_some()) {
            let _ = self.update_session(id, |s| s.carry_transcript = None, Vec::new());
        }
    }
}
