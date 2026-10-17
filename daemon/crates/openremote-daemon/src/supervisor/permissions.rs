//! The supervisor's side of the permission ladder (ladder.rs): what a
//! request's permission value becomes on a chat's harness, and the word a
//! harness is told when its process starts.

use openremote_core::Session;

use super::{Supervisor, SupervisorError};
use crate::ladder::{self, Rung};

impl Supervisor {
    /// The harness CLI's probed version - the ladder's words can depend
    /// on it (claude spells asking first `manual` from 2.1.300).
    pub(super) fn version_of(&self, harness: &str) -> Option<String> {
        self.registry
            .read()
            .expect("registry lock")
            .harnesses()
            .into_iter()
            .find(|h| h.id == harness)
            .and_then(|h| h.version)
    }

    /// A request's permission value on `harness`: a rung's id or, from a
    /// console or rule that predates the ladder, the harness's own word.
    /// Answers the rung the chat runs (the nearest safer one the harness
    /// has) and the harness's word for it. `(None, None)`: nothing was
    /// asked, or the harness has no permission setting and decides on its
    /// own. A value that is neither is refused, never guessed.
    pub(super) fn permission_for(
        &self,
        harness: &str,
        value: Option<&str>,
    ) -> Result<(Option<String>, Option<String>), SupervisorError> {
        let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
            return Ok((None, None));
        };
        let rung = ladder::normalize(harness, value).ok_or_else(|| {
            SupervisorError::Conflict(format!(
                "'{value}' is not a permission level - use one of: {}",
                ladder::ids()
            ))
        })?;
        let version = self.version_of(harness);
        Ok(match ladder::fit(harness, version.as_deref(), rung) {
            Some(fitted) => (
                Some(fitted.id().to_string()),
                ladder::word(harness, version.as_deref(), fitted).map(String::from),
            ),
            None => (None, None),
        })
    }

    /// The word a chat's harness is told at start: the stored rung read
    /// on the harness as it is now (a newer CLI may spell it anew), or a
    /// chat from before the ladder's word read as its rung. A word the
    /// ladder doesn't know rides verbatim, as it always did.
    pub(super) fn spawn_permission(&self, session: &Session) -> Option<String> {
        let harness = session.harness.as_str();
        let rung = session.permission.as_deref().and_then(Rung::parse).or_else(|| {
            session
                .permission_mode
                .as_deref()
                .and_then(|w| ladder::rung_of(harness, w))
        });
        let Some(rung) = rung else {
            return session.permission_mode.clone();
        };
        let version = self.version_of(harness);
        ladder::fit(harness, version.as_deref(), rung)
            .and_then(|fitted| ladder::word(harness, version.as_deref(), fitted))
            .map(String::from)
    }
}

/// The rung a harness's reported word stands for, as the session stores
/// it - the harness's own report is the truth of what it runs.
pub(super) fn reported_rung(harness: &str, word: Option<&str>) -> Option<String> {
    word.and_then(|w| ladder::rung_of(harness, w))
        .map(|r| r.id().to_string())
}
