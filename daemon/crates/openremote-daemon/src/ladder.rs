//! The permission ladder: OpenRemote's own words for what an agent may do
//! without asking, one set for every harness. Each harness keeps its own
//! setting under its own name - claude's and grok's `--permission-mode`,
//! codex's approval policy and sandbox, Antigravity's `--mode`, OpenCode's
//! permission config - so the user picks a rung, and this file is the one
//! place that knows what each rung means to each harness. A harness with
//! no setting for a rung doesn't offer it; a chat that asks for one gets
//! the nearest safer rung the harness has, never a looser one.

use openremote_core::RungOffer;

/// One rung, safest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Rung {
    /// Reads and plans; changes nothing.
    Plan,
    /// Asks before it edits a file or runs a command.
    Ask,
    /// Edits files without asking; asks before commands.
    Edits,
    /// Edits files and runs commands without asking.
    Auto,
    /// Never asks.
    Full,
}

impl Rung {
    pub const ALL: [Rung; 5] = [Rung::Plan, Rung::Ask, Rung::Edits, Rung::Auto, Rung::Full];

    /// The rung's id on the wire and in `/permissions <id>`.
    pub fn id(self) -> &'static str {
        match self {
            Rung::Plan => "plan",
            Rung::Ask => "ask",
            Rung::Edits => "edits",
            Rung::Auto => "auto",
            Rung::Full => "full",
        }
    }

    pub fn parse(id: &str) -> Option<Rung> {
        let id = id.trim();
        Rung::ALL
            .into_iter()
            .find(|rung| rung.id().eq_ignore_ascii_case(id))
    }
}

/// Claude Code spells its asking mode `manual` from 2.1.300 on (it still
/// takes `default` there without listing it, and older builds know only
/// `default`). Its `auto` mode is offered from the same build, the first
/// one checked to list it.
const CLAUDE_MANUAL: (u64, u64, u64) = (2, 1, 300);

/// OpenCode reads a permission config from `OPENCODE_PERMISSION` when it
/// starts, merged over the user's own: each rung is the config that says
/// it. Its own default lets everything run (it still asks before touching
/// folders outside the chat's), which is the `auto` rung's meaning.
const OPENCODE_ASK: &str = r#"{"edit":"ask","bash":"ask","webfetch":"ask"}"#;
const OPENCODE_EDITS: &str = r#"{"edit":"allow","bash":"ask","webfetch":"ask"}"#;
const OPENCODE_AUTO: &str = r#"{"edit":"allow","bash":"allow","webfetch":"allow"}"#;
const OPENCODE_FULL: &str =
    r#"{"*":"allow","read":"allow","external_directory":"allow","doom_loop":"allow"}"#;

fn modern_claude(version: Option<&str>) -> bool {
    // An unprobed CLI is taken to be current: the probe only misses a
    // version when the CLI was slow to answer, not when it is old.
    version.is_none_or(|v| crate::registry::version_at_least(v, CLAUDE_MANUAL))
}

/// The harness's own word for a rung, or None where it has no setting
/// for it. `version` is the harness CLI's probed version.
pub fn word(harness: &str, version: Option<&str>, rung: Rung) -> Option<&'static str> {
    match (harness, rung) {
        ("claude", Rung::Plan) => Some("plan"),
        ("claude", Rung::Ask) if modern_claude(version) => Some("manual"),
        ("claude", Rung::Ask) => Some("default"),
        ("claude", Rung::Edits) => Some("acceptEdits"),
        ("claude", Rung::Auto) if modern_claude(version) => Some("auto"),
        ("claude", Rung::Full) => Some("bypassPermissions"),
        // Codex: the approval policy word. Its sandbox follows from it in
        // the driver - `never` is codex's own Full Access, which lifts
        // the sandbox too; the others keep it on the workspace.
        ("codex", Rung::Ask) => Some("untrusted"),
        ("codex", Rung::Auto) => Some("on-request"),
        ("codex", Rung::Full) => Some("never"),
        // Grok's print mode has no channel to ask through, so what it
        // would ask about is its own to settle; these are its words.
        ("grok", Rung::Plan) => Some("plan"),
        ("grok", Rung::Ask) => Some("default"),
        ("grok", Rung::Edits) => Some("acceptEdits"),
        ("grok", Rung::Auto) => Some("auto"),
        ("grok", Rung::Full) => Some("bypassPermissions"),
        // Antigravity: its `--mode` words, and its own flag for skipping
        // every check. Its default mode is left unnamed - which flag it
        // stands for in print mode isn't known, so Ask first isn't
        // offered rather than guessed.
        ("agy", Rung::Plan) => Some("plan"),
        ("agy", Rung::Edits) => Some("accept-edits"),
        ("agy", Rung::Auto) => Some("auto"),
        ("agy", Rung::Full) => Some("dangerously-skip-permissions"),
        ("opencode", Rung::Ask) => Some(OPENCODE_ASK),
        ("opencode", Rung::Edits) => Some(OPENCODE_EDITS),
        ("opencode", Rung::Auto) => Some(OPENCODE_AUTO),
        ("opencode", Rung::Full) => Some(OPENCODE_FULL),
        // Pi has no permission setting at all: it runs every step
        // without asking, by its own design.
        _ => None,
    }
}

/// The rungs a harness offers, safest first, each with its own word.
pub fn offers(harness: &str, version: Option<&str>) -> Vec<(Rung, &'static str)> {
    Rung::ALL
        .into_iter()
        .filter_map(|rung| word(harness, version, rung).map(|w| (rung, w)))
        .collect()
}

/// The ladder as the capabilities carry it.
pub fn offer_list(harness: &str, version: Option<&str>) -> Vec<RungOffer> {
    offers(harness, version)
        .into_iter()
        .map(|(rung, word)| RungOffer {
            id: rung.id().to_string(),
            word: word.to_string(),
        })
        .collect()
}

/// The rung a harness runs when none is picked, where its own default is
/// known: claude and grok ask first, codex's default is its workspace
/// sandbox with asking on request, OpenCode lets everything run.
pub fn default_rung(harness: &str) -> Option<Rung> {
    match harness {
        "claude" | "grok" => Some(Rung::Ask),
        "codex" | "opencode" => Some(Rung::Auto),
        _ => None,
    }
}

/// The words a console from before the ladder offers: the harnesses it
/// had words for (claude, codex, grok), in the ladder's order.
pub fn legacy_words(harness: &str, version: Option<&str>) -> Vec<String> {
    if !matches!(harness, "claude" | "codex" | "grok") {
        return Vec::new();
    }
    offers(harness, version)
        .into_iter()
        .map(|(_, word)| word.to_string())
        .collect()
}

/// The default word such a console marks.
pub fn legacy_default(harness: &str, version: Option<&str>) -> Option<String> {
    if !matches!(harness, "claude" | "codex" | "grok") {
        return None;
    }
    default_rung(harness)
        .and_then(|rung| word(harness, version, rung))
        .map(String::from)
}

/// What a harness's own word means on the ladder: chats and rules saved
/// before it, consoles that predate it, and the word a harness reports it
/// runs all name words. Retired words land on their nearest rung.
pub fn rung_of(harness: &str, word: &str) -> Option<Rung> {
    let word = word.trim();
    match harness {
        "claude" | "grok" => match word {
            "plan" => Some(Rung::Plan),
            // dontAsk refuses whatever it would have asked about - closer
            // to asking first than to anything that lets more run.
            "default" | "manual" | "dontAsk" => Some(Rung::Ask),
            "acceptEdits" => Some(Rung::Edits),
            "auto" => Some(Rung::Auto),
            "bypassPermissions" => Some(Rung::Full),
            _ => None,
        },
        "codex" => match word {
            "untrusted" => Some(Rung::Ask),
            // on-failure was codex's own word until it retired it: run in
            // the sandbox, ask when that fails - its on-request today.
            "on-request" | "on-failure" => Some(Rung::Auto),
            "never" => Some(Rung::Full),
            _ => None,
        },
        "agy" => match word {
            "plan" => Some(Rung::Plan),
            "accept-edits" => Some(Rung::Edits),
            "auto" => Some(Rung::Auto),
            "dangerously-skip-permissions" => Some(Rung::Full),
            _ => None,
        },
        "opencode" => match word {
            OPENCODE_ASK => Some(Rung::Ask),
            OPENCODE_EDITS => Some(Rung::Edits),
            OPENCODE_AUTO => Some(Rung::Auto),
            OPENCODE_FULL => Some(Rung::Full),
            _ => None,
        },
        _ => None,
    }
}

/// Any permission value a request carries: a rung's id, or the harness's
/// own word from a console or a rule that predates the ladder.
pub fn normalize(harness: &str, value: &str) -> Option<Rung> {
    Rung::parse(value).or_else(|| rung_of(harness, value))
}

/// The rung a chat at `rung` runs on this harness: the rung itself where
/// the harness offers it, else the nearest safer rung it has. Plan only
/// is never that stand-in - it changes nothing, so it would quietly stop
/// the work - except for itself, where asking before every change is the
/// closest. None: the harness has none of them, and decides on its own.
pub fn fit(harness: &str, version: Option<&str>, rung: Rung) -> Option<Rung> {
    let has = |r: Rung| word(harness, version, r).is_some();
    if has(rung) {
        return Some(rung);
    }
    let safer: &[Rung] = match rung {
        Rung::Plan => &[Rung::Ask],
        Rung::Ask => &[],
        Rung::Edits => &[Rung::Ask],
        Rung::Auto => &[Rung::Edits, Rung::Ask],
        Rung::Full => &[Rung::Auto, Rung::Edits, Rung::Ask],
    };
    safer.iter().copied().find(|r| has(*r))
}

/// The plain list a refusal names.
pub fn ids() -> String {
    Rung::ALL
        .iter()
        .map(|r| r.id())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_speaks_manual_from_2_1_300_and_default_before() {
        assert_eq!(word("claude", Some("2.1.300"), Rung::Ask), Some("manual"));
        assert_eq!(word("claude", Some("2.1.287"), Rung::Ask), Some("default"));
        assert_eq!(word("claude", None, Rung::Ask), Some("manual"));
        // auto arrives with the same build; an older one falls to edits
        assert_eq!(word("claude", Some("2.1.287"), Rung::Auto), None);
        assert_eq!(fit("claude", Some("2.1.287"), Rung::Auto), Some(Rung::Edits));
        // both spellings read back as asking first
        assert_eq!(rung_of("claude", "default"), Some(Rung::Ask));
        assert_eq!(rung_of("claude", "manual"), Some(Rung::Ask));
    }

    #[test]
    fn every_offered_word_reads_back_as_its_own_rung() {
        for harness in ["claude", "codex", "grok", "agy", "opencode", "pi"] {
            for (rung, w) in offers(harness, Some("9.9.9")) {
                assert_eq!(rung_of(harness, w), Some(rung), "{harness} {w}");
                assert_eq!(normalize(harness, rung.id()), Some(rung));
            }
        }
    }

    #[test]
    fn a_missing_rung_falls_to_the_nearest_safer_one_never_to_plan() {
        // codex has no edits-only setting: Allow edits asks first there
        assert_eq!(fit("codex", None, Rung::Edits), Some(Rung::Ask));
        assert_eq!(fit("codex", None, Rung::Plan), Some(Rung::Ask));
        assert_eq!(fit("codex", None, Rung::Full), Some(Rung::Full));
        // agy has no named asking mode: asking first leaves agy to decide
        assert_eq!(fit("agy", None, Rung::Ask), None);
        assert_eq!(fit("agy", None, Rung::Edits), Some(Rung::Edits));
        // pi has no ladder at all
        assert_eq!(fit("pi", None, Rung::Full), None);
        assert!(offers("pi", None).is_empty());
    }

    #[test]
    fn retired_and_foreign_words_land_on_their_nearest_rung() {
        assert_eq!(rung_of("codex", "on-failure"), Some(Rung::Auto));
        assert_eq!(rung_of("grok", "dontAsk"), Some(Rung::Ask));
        assert_eq!(normalize("claude", "EDITS"), Some(Rung::Edits));
        assert_eq!(normalize("claude", "nonsense"), None);
    }

    #[test]
    fn older_consoles_keep_their_words_for_the_harnesses_they_knew() {
        assert_eq!(
            legacy_words("claude", Some("2.1.300")),
            ["plan", "manual", "acceptEdits", "auto", "bypassPermissions"]
        );
        assert_eq!(legacy_default("claude", Some("2.1.300")).as_deref(), Some("manual"));
        assert_eq!(legacy_words("codex", None), ["untrusted", "on-request", "never"]);
        assert_eq!(legacy_default("codex", None).as_deref(), Some("on-request"));
        assert!(legacy_words("opencode", None).is_empty());
        assert!(legacy_words("agy", None).is_empty());
    }
}
