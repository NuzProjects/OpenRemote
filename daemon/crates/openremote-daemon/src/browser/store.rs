//! The browser's own data on this device: bookmarks, history, settings,
//! site permissions, the tiles of the new tab page and the tabs to bring
//! back at the next start.
//!
//! Kept as an append-only log of operations under `<data_dir>/browser/`,
//! one file per device, each operation stamped with a hybrid logical clock.
//! The value of a key is the one with the latest stamp (deleting writes an
//! empty value), so logs from several devices can be merged in any order and
//! agree. Syncing the profile between the user's devices exchanges these
//! operations (`profile`): this device's own stay in its log here, the
//! others' arrive sealed and are merged in memory.
//!
//! Cookies and sites' storage are secrets (a cookie is a signed-in
//! session), so their values are sealed in the log with this device's key,
//! which the operating system's keystore holds (`keystore`).

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::keystore::{self, DeviceKey};
use super::seal;

/// History older than this is dropped when the log is compacted (Chrome
/// keeps 90 days too).
const HISTORY_DAYS: i64 = 90;
/// The log is rewritten with only what is still true once it holds this
/// many superseded operations.
const COMPACT_AFTER: usize = 20_000;
/// Collections whose values are sealed in the log: a cookie is a signed-in
/// session, and sites keep sign-ins in their storage too.
pub const SEALED: &[&str] = &["cookie", "storage"];

/// A hybrid logical clock stamp: wall-clock milliseconds, a counter for
/// operations within one millisecond, and the device as the tie-break.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Stamp {
    pub ms: i64,
    pub n: u32,
    pub dev: String,
}

impl Stamp {
    /// The stamp as one short string (`ms.n.device`), for records that
    /// only compare stamps.
    pub fn short(&self) -> String {
        format!("{}.{}.{}", self.ms, self.n, self.dev)
    }
}

/// One write: a key of a collection set to a value (null deletes it).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Op {
    pub at: Stamp,
    pub col: String,
    pub key: String,
    #[serde(default)]
    pub val: Value,
}

/// An operation as a line of the log: the value sealed with this device's
/// key for the collections that hold secrets.
#[derive(Serialize, Deserialize)]
struct Line {
    at: Stamp,
    col: String,
    key: String,
    #[serde(default)]
    val: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sealed: Option<String>,
}

/// What a sealed value is bound to: its slot, so it can't be moved to
/// another one.
fn rest_place(col: &str, key: &str) -> Vec<u8> {
    format!("rest\u{1f}{col}\u{1f}{key}").into_bytes()
}

/// One page in history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Visit {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub title: String,
    pub at: i64,
}

/// One bookmark.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bookmark {
    /// Empty for a new bookmark: the store gives it one.
    #[serde(default)]
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub title: String,
    /// Where it sits: `bar` (the bookmarks bar) or `other`.
    #[serde(default = "bar")]
    pub folder: String,
    #[serde(default)]
    pub position: f64,
    #[serde(default)]
    pub added: i64,
}

fn bar() -> String {
    "bar".into()
}

/// A suggestion for the address bar.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Suggestion {
    pub url: String,
    pub title: String,
    pub bookmarked: bool,
    pub visits: usize,
}

/// A tile on the new tab page.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Tile {
    pub url: String,
    pub title: String,
    /// The user added it themselves (it stays put).
    pub pinned: bool,
}

pub struct BrowserStore {
    dir: PathBuf,
    device: String,
    last: Stamp,
    /// (collection, key) -> the latest operation's stamp and value.
    state: HashMap<(String, String), (Stamp, Value)>,
    ops_written: usize,
    /// This device's key for sealed values, fetched from the keystore the
    /// first time one is read or written (a machine without a browser never
    /// needs it).
    key: Option<DeviceKey>,
    /// This device's operations since the profile's sync last took them,
    /// kept only while it takes them.
    fresh: Vec<Op>,
    collecting: bool,
}

impl BrowserStore {
    /// Opens (or starts) the browser's data in `<data_dir>/browser/`.
    pub fn open(data_dir: &Path) -> Self {
        let dir = data_dir.join("browser");
        let _ = std::fs::create_dir_all(&dir);
        let device = device_id(&dir);
        let mut store = Self {
            dir,
            last: Stamp {
                ms: 0,
                n: 0,
                dev: device.clone(),
            },
            device,
            state: HashMap::new(),
            ops_written: 0,
            key: None,
            fresh: Vec::new(),
            collecting: false,
        };
        store.load();
        store
    }

    /// This device's id in the browser's logs.
    pub fn device(&self) -> &str {
        &self.device
    }

    /// The folder the browser's data lives in.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// This device's key for what rests sealed on its disk.
    pub fn device_key(&mut self) -> [u8; 32] {
        if self.key.is_none() {
            self.key = Some(keystore::device_key(&self.dir));
        }
        self.key.as_ref().map(|k| k.key).unwrap_or_default()
    }

    /// What holds this device's key, once it was needed.
    pub fn key_holder(&self) -> Option<&'static str> {
        self.key.as_ref().map(|k| k.held_by)
    }

    fn line_for(&mut self, op: &Op) -> String {
        let sealed = (SEALED.contains(&op.col.as_str()) && !op.val.is_null()).then(|| {
            let key = self.device_key();
            seal::seal(&key, &rest_place(&op.col, &op.key), op.val.to_string().as_bytes())
        });
        let line = Line {
            at: op.at.clone(),
            col: op.col.clone(),
            key: op.key.clone(),
            val: if sealed.is_some() {
                Value::Null
            } else {
                op.val.clone()
            },
            sealed,
        };
        serde_json::to_string(&line).expect("an op serializes")
    }

    fn op_from(&mut self, line: Line) -> Option<Op> {
        let val = match line.sealed {
            Some(sealed) => {
                let key = self.device_key();
                // A value sealed under another key (the folder came from
                // another computer, or the keystore lost the key) can't be
                // read here: it is skipped, and the user's other devices
                // send it again.
                let plain = seal::open(&key, &rest_place(&line.col, &line.key), &sealed)?;
                serde_json::from_slice(&plain).ok()?
            }
            None => line.val,
        };
        Some(Op {
            at: line.at,
            col: line.col,
            key: line.key,
            val,
        })
    }

    fn log_path(&self, device: &str) -> PathBuf {
        self.dir.join(format!("ops-{device}.jsonl"))
    }

    fn load(&mut self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("ops-") && name.ends_with(".jsonl")) {
                continue;
            }
            let Ok(file) = std::fs::File::open(entry.path()) else {
                continue;
            };
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                // A line cut short by a crash is skipped, not fatal.
                let Ok(line) = serde_json::from_str::<Line>(&line) else {
                    continue;
                };
                if line.at.dev == self.device {
                    self.ops_written += 1;
                }
                if let Some(op) = self.op_from(line) {
                    self.apply(op);
                }
            }
        }
    }

    /// Takes an operation in; true when it is now the key's value.
    fn apply(&mut self, op: Op) -> bool {
        if op.at > self.last {
            self.last = Stamp {
                ms: op.at.ms,
                n: op.at.n,
                dev: self.device.clone(),
            };
        }
        let slot = (op.col, op.key);
        match self.state.get(&slot) {
            Some((at, _)) if *at >= op.at => false,
            _ => {
                self.state.insert(slot, (op.at, op.val));
                true
            }
        }
    }

    /// Another device's operation, arrived through the profile's sync: kept
    /// in memory only (its sealed copy stays in that device's log here).
    /// True when it changed the key's value.
    pub fn merge(&mut self, op: Op) -> bool {
        if op.at.dev == self.device {
            // This device's own operations come from its own log alone.
            return false;
        }
        self.apply(op)
    }

    /// Starts or stops keeping this device's new operations for the
    /// profile's sync.
    pub fn collect(&mut self, on: bool) {
        self.collecting = on;
        if !on {
            self.fresh.clear();
        }
    }

    /// This device's operations since the last take.
    pub fn take_fresh(&mut self) -> Vec<Op> {
        std::mem::take(&mut self.fresh)
    }

    /// A key's latest operation, a deletion included.
    pub fn entry(&self, col: &str, key: &str) -> Option<(&Stamp, &Value)> {
        self.state
            .get(&(col.to_string(), key.to_string()))
            .map(|(at, val)| (at, val))
    }

    /// Every key of a collection with its latest operation, deletions
    /// included.
    pub fn entries<'a>(
        &'a self,
        col: &'a str,
    ) -> impl Iterator<Item = (&'a str, &'a Stamp, &'a Value)> + 'a {
        self.state
            .iter()
            .filter(move |((c, _), _)| c == col)
            .map(|((_, k), (at, val))| (k.as_str(), at, val))
    }

    /// Everything this device wrote that is still true (deletions
    /// included): what a fresh start of its synced log carries.
    pub fn own_ops(&self) -> Vec<Op> {
        self.state
            .iter()
            .filter(|(_, (at, _))| at.dev == self.device)
            .map(|((col, key), (at, val))| Op {
                at: at.clone(),
                col: col.clone(),
                key: key.clone(),
                val: val.clone(),
            })
            .collect()
    }

    fn stamp(&mut self, now: i64) -> Stamp {
        let stamp = if now > self.last.ms {
            Stamp {
                ms: now,
                n: 0,
                dev: self.device.clone(),
            }
        } else {
            Stamp {
                ms: self.last.ms,
                n: self.last.n + 1,
                dev: self.device.clone(),
            }
        };
        self.last = stamp.clone();
        stamp
    }

    /// Writes one key (an empty value deletes it); answers the write's
    /// stamp.
    pub fn put(&mut self, col: &str, key: &str, val: Value) -> Stamp {
        let op = Op {
            at: self.stamp(openremote_core::now_ms()),
            col: col.into(),
            key: key.into(),
            val,
        };
        let line = self.line_for(&op);
        let path = self.log_path(&self.device);
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(file, "{line}");
        }
        self.ops_written += 1;
        let stamp = op.at.clone();
        if self.collecting {
            self.fresh.push(op.clone());
        }
        self.apply(op);
        if self.ops_written > self.live_count() + COMPACT_AFTER {
            self.compact();
        }
        stamp
    }

    fn live_count(&self) -> usize {
        self.state.len()
    }

    pub fn get(&self, col: &str, key: &str) -> Option<&Value> {
        self.state
            .get(&(col.to_string(), key.to_string()))
            .map(|(_, v)| v)
            .filter(|v| !v.is_null())
    }

    fn all<'a>(&'a self, col: &'a str) -> impl Iterator<Item = (&'a str, &'a Value)> + 'a {
        self.state
            .iter()
            .filter(move |((c, _), (_, v))| c == col && !v.is_null())
            .map(|((_, k), (_, v))| (k.as_str(), v))
    }

    /// Rewrites this device's log with only what is still true, and drops
    /// history past its keeping time.
    fn compact(&mut self) {
        let horizon = openremote_core::now_ms() - HISTORY_DAYS * 24 * 3600 * 1000;
        self.state.retain(|(col, _), (_, val)| {
            !(col == "visit" && val.get("at").and_then(Value::as_i64).unwrap_or(0) < horizon)
        });
        let mut lines = String::new();
        let mut kept = 0;
        for op in self.own_ops() {
            lines.push_str(&self.line_for(&op));
            lines.push('\n');
            kept += 1;
        }
        let path = self.log_path(&self.device);
        let fresh = path.with_extension("jsonl.new");
        if std::fs::write(&fresh, lines).is_ok() && std::fs::rename(&fresh, &path).is_ok() {
            self.ops_written = kept;
        }
    }

    // ---- history ----

    /// Records a visit; answers its id, so a title that arrives later can
    /// land on the same entry.
    pub fn visit(&mut self, url: &str, title: &str, at: i64) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.put("visit", &id, json!({"url": url, "title": title, "at": at}));
        id
    }

    pub fn retitle_visit(&mut self, id: &str, title: &str) {
        if let Some(mut visit) = self.get("visit", id).cloned() {
            if visit["title"] != title {
                visit["title"] = json!(title);
                self.put("visit", id, visit);
            }
        }
    }

    fn visits(&self) -> Vec<Visit> {
        self.all("visit")
            .filter_map(|(id, v)| {
                Some(Visit {
                    id: id.to_string(),
                    url: v.get("url")?.as_str()?.to_string(),
                    title: v
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    at: v.get("at").and_then(Value::as_i64).unwrap_or(0),
                })
            })
            .collect()
    }

    /// History, newest first: matching `query` (in the address or title),
    /// older than `before` when given.
    pub fn history(&self, query: &str, before: Option<i64>, limit: usize) -> Vec<Visit> {
        let query = query.trim().to_lowercase();
        let mut visits: Vec<Visit> = self
            .visits()
            .into_iter()
            .filter(|v| before.is_none_or(|b| v.at < b))
            .filter(|v| {
                query.is_empty()
                    || v.url.to_lowercase().contains(&query)
                    || v.title.to_lowercase().contains(&query)
            })
            .collect();
        visits.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.id.cmp(&b.id)));
        visits.truncate(limit);
        visits
    }

    pub fn forget_visits(&mut self, ids: &[String]) {
        for id in ids {
            self.put("visit", id, Value::Null);
        }
    }

    /// Clears history from `since` on (all of it when None).
    pub fn clear_history(&mut self, since: Option<i64>) {
        let doomed: Vec<String> = self
            .visits()
            .into_iter()
            .filter(|v| since.is_none_or(|s| v.at >= s))
            .map(|v| v.id)
            .collect();
        self.forget_visits(&doomed);
    }

    /// What the address bar offers for what's typed: pages visited and
    /// bookmarked whose address or title match, the most used first.
    pub fn suggest(&self, typed: &str, limit: usize) -> Vec<Suggestion> {
        let typed = typed.trim().to_lowercase();
        if typed.is_empty() {
            return Vec::new();
        }
        let mut pages: HashMap<String, (String, usize, i64, bool)> = HashMap::new();
        for visit in self.visits() {
            let page = pages
                .entry(visit.url.clone())
                .or_insert((String::new(), 0, 0, false));
            page.1 += 1;
            if visit.at >= page.2 {
                page.2 = visit.at;
                if !visit.title.is_empty() {
                    page.0 = visit.title;
                }
            }
        }
        for mark in self.bookmarks() {
            let page = pages
                .entry(mark.url.clone())
                .or_insert((String::new(), 0, 0, false));
            page.3 = true;
            if page.0.is_empty() {
                page.0 = mark.title;
            }
        }
        let mut hits: Vec<(i64, Suggestion)> = pages
            .into_iter()
            .filter_map(|(url, (title, visits, last, bookmarked))| {
                let bare = bare_address(&url);
                let score = if bare.starts_with(&typed) {
                    3
                } else if bare
                    .split(['/', '.', '?', '-'])
                    .any(|part| part.starts_with(&typed))
                    || title
                        .to_lowercase()
                        .split_whitespace()
                        .any(|w| w.starts_with(&typed))
                {
                    2
                } else if url.to_lowercase().contains(&typed)
                    || title.to_lowercase().contains(&typed)
                {
                    1
                } else {
                    return None;
                };
                let rank = score * 1_000_000
                    + (visits as i64).min(999) * 1000
                    + i64::from(bookmarked) * 500
                    + (last / 86_400_000) % 1000;
                Some((
                    rank,
                    Suggestion {
                        url,
                        title,
                        bookmarked,
                        visits,
                    },
                ))
            })
            .collect();
        hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.url.cmp(&b.1.url)));
        hits.into_iter().take(limit).map(|(_, s)| s).collect()
    }

    /// The new tab page's tiles: the user's own first, then the most
    /// visited pages of the last 30 days, without the ones removed.
    pub fn tiles(&self, limit: usize) -> Vec<Tile> {
        let mut tiles: Vec<(f64, Tile)> = self
            .all("tile")
            .filter(|(_, v)| v.get("pinned").and_then(Value::as_bool) == Some(true))
            .map(|(url, v)| {
                (
                    v.get("position").and_then(Value::as_f64).unwrap_or(0.0),
                    Tile {
                        url: url.to_string(),
                        title: v
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        pinned: true,
                    },
                )
            })
            .collect();
        tiles.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut out: Vec<Tile> = tiles.into_iter().map(|(_, t)| t).collect();
        let since = openremote_core::now_ms() - 30 * 86_400_000;
        let mut counts: HashMap<String, (usize, String)> = HashMap::new();
        for visit in self.visits().into_iter().filter(|v| v.at >= since) {
            let site = site_of(&visit.url);
            let entry = counts.entry(site).or_insert((0, String::new()));
            entry.0 += 1;
            if entry.1.is_empty() && !visit.title.is_empty() {
                entry.1 = visit.title;
            }
        }
        let mut frequent: Vec<(String, (usize, String))> = counts.into_iter().collect();
        frequent.sort_by(|a, b| b.1.0.cmp(&a.1.0).then_with(|| a.0.cmp(&b.0)));
        for (url, (_, title)) in frequent {
            if out.len() >= limit {
                break;
            }
            let removed = self
                .get("tile", &url)
                .and_then(|v| v.get("removed"))
                .and_then(Value::as_bool)
                == Some(true);
            if removed || out.iter().any(|t| t.url == url) {
                continue;
            }
            out.push(Tile {
                url,
                title,
                pinned: false,
            });
        }
        out.truncate(limit);
        out
    }

    /// Adds a tile of the user's own, or renames one.
    pub fn pin_tile(&mut self, url: &str, title: &str) {
        let position = self
            .all("tile")
            .filter_map(|(_, v)| v.get("position").and_then(Value::as_f64))
            .fold(0.0, f64::max)
            + 1.0;
        let position = self
            .get("tile", url)
            .and_then(|v| v.get("position"))
            .and_then(Value::as_f64)
            .unwrap_or(position);
        self.put(
            "tile",
            url,
            json!({"pinned": true, "title": title, "position": position}),
        );
    }

    /// Takes a tile off the new tab page (a frequent site stays off).
    pub fn remove_tile(&mut self, url: &str) {
        self.put("tile", url, json!({"removed": true}));
    }

    // ---- bookmarks ----

    pub fn bookmarks(&self) -> Vec<Bookmark> {
        let mut marks: Vec<Bookmark> = self
            .all("bookmark")
            .filter_map(|(id, v)| {
                let mut v = v.clone();
                v["id"] = json!(id);
                serde_json::from_value(v).ok()
            })
            .collect();
        marks.sort_by(|a, b| {
            a.folder
                .cmp(&b.folder)
                .then(a.position.total_cmp(&b.position))
                .then_with(|| a.id.cmp(&b.id))
        });
        marks
    }

    /// Adds or changes a bookmark (a new one goes last in its folder).
    pub fn save_bookmark(&mut self, mut mark: Bookmark) -> Bookmark {
        if mark.id.is_empty() {
            mark.id = uuid::Uuid::new_v4().to_string();
        }
        if mark.added == 0 {
            mark.added = openremote_core::now_ms();
        }
        if self.get("bookmark", &mark.id).is_none() && mark.position == 0.0 {
            mark.position = self
                .bookmarks()
                .iter()
                .filter(|b| b.folder == mark.folder)
                .map(|b| b.position)
                .fold(0.0, f64::max)
                + 1.0;
        }
        let mut val = serde_json::to_value(&mark).expect("a bookmark serializes");
        if let Some(map) = val.as_object_mut() {
            map.remove("id");
        }
        self.put("bookmark", &mark.id, val);
        mark
    }

    pub fn remove_bookmark(&mut self, id: &str) {
        self.put("bookmark", id, Value::Null);
    }

    // ---- settings, permissions, the tabs to restore ----

    /// Every setting the user changed (the console knows the defaults).
    pub fn settings(&self) -> serde_json::Map<String, Value> {
        self.all("setting")
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    pub fn set_setting(&mut self, key: &str, val: Value) {
        self.put("setting", key, val);
    }

    /// Remembered answers to sites' requests: `origin|kind` -> allow/deny.
    pub fn permissions(&self) -> serde_json::Map<String, Value> {
        self.all("permission")
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    pub fn set_permission(&mut self, origin: &str, kind: &str, state: Option<&str>) {
        let val = state.map_or(Value::Null, |s| json!(s));
        self.put("permission", &format!("{origin}|{kind}"), val);
    }

    /// The tabs this device had open, for the next start.
    pub fn session(&self) -> Value {
        self.get("session", &self.device)
            .cloned()
            .unwrap_or(Value::Null)
    }

    pub fn save_session(&mut self, session: Value) {
        if self.get("session", &self.device) != Some(&session) {
            let device = self.device.clone();
            self.put("session", &device, session);
        }
    }
}

/// This device's id for the browser's logs: made once, kept in the folder.
fn device_id(dir: &Path) -> String {
    let path = dir.join("device");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return id;
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let _ = std::fs::write(&path, &id);
    id
}

/// An address without its scheme and `www.`, as people type it.
fn bare_address(url: &str) -> String {
    let lower = url.to_lowercase();
    let rest = lower.split_once("://").map_or(lower.as_str(), |(_, r)| r);
    rest.strip_prefix("www.").unwrap_or(rest).to_string()
}

/// A page's site: scheme and host, so a site's pages count as one tile.
fn site_of(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    format!("{scheme}://{host}/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> (tempfile::TempDir, BrowserStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = BrowserStore::open(dir.path());
        (dir, store)
    }

    #[test]
    fn what_is_written_survives_a_restart_and_the_latest_write_wins() {
        let (dir, mut store) = fresh();
        let mark = store.save_bookmark(Bookmark {
            id: String::new(),
            url: "https://example.com/".into(),
            title: "Example".into(),
            folder: "bar".into(),
            position: 0.0,
            added: 0,
        });
        store.set_setting("search", json!("duckduckgo"));
        store.set_setting("search", json!("google"));
        store.set_permission("https://a.test", "camera", Some("allow"));
        let gone = store.save_bookmark(Bookmark {
            id: String::new(),
            url: "https://gone.test/".into(),
            title: "Gone".into(),
            folder: "bar".into(),
            position: 0.0,
            added: 0,
        });
        store.remove_bookmark(&gone.id);
        drop(store);

        let store = BrowserStore::open(dir.path());
        assert_eq!(store.bookmarks(), vec![mark]);
        assert_eq!(store.settings()["search"], "google");
        assert_eq!(store.permissions()["https://a.test|camera"], "allow");
    }

    #[test]
    fn history_searches_newest_first_and_clears() {
        let (_dir, mut store) = fresh();
        store.visit("https://docs.rs/serde", "serde - Rust", 1_000);
        let id = store.visit("https://example.com/", "", 2_000);
        store.retitle_visit(&id, "Example Domain");
        store.visit("https://docs.rs/tokio", "tokio - Rust", 3_000);
        let all = store.history("", None, 10);
        assert_eq!(
            all.iter().map(|v| v.at).collect::<Vec<_>>(),
            vec![3_000, 2_000, 1_000]
        );
        assert_eq!(all[1].title, "Example Domain");
        assert_eq!(store.history("rust", None, 10).len(), 2);
        assert_eq!(store.history("", Some(3_000), 1)[0].at, 2_000);
        store.clear_history(Some(2_000));
        assert_eq!(store.history("", None, 10).len(), 1);
    }

    #[test]
    fn the_address_bar_suggests_what_was_used_most() {
        let (_dir, mut store) = fresh();
        for at in 0..3 {
            store.visit("https://github.com/tauri-apps/tauri", "Tauri", at);
        }
        store.visit("https://gitlab.com/", "GitLab", 10);
        store.visit("https://example.com/git", "A page about git", 11);
        let hits = store.suggest("git", 5);
        assert_eq!(hits[0].url, "https://github.com/tauri-apps/tauri");
        assert_eq!(hits[1].url, "https://gitlab.com/");
        assert_eq!(hits.len(), 3);
        assert!(store.suggest("zzz", 5).is_empty());
    }

    #[test]
    fn tiles_put_the_users_own_first_and_forget_removed_sites() {
        let (_dir, mut store) = fresh();
        let now = openremote_core::now_ms();
        store.visit("https://news.test/a", "News", now);
        store.visit("https://news.test/b", "News", now);
        store.visit("https://shop.test/", "Shop", now);
        store.pin_tile("https://mine.test/", "Mine");
        let tiles = store.tiles(8);
        assert_eq!(tiles[0].url, "https://mine.test/");
        assert!(tiles[0].pinned);
        assert_eq!(tiles[1].url, "https://news.test/");
        store.remove_tile("https://news.test/");
        let urls: Vec<String> = store.tiles(8).into_iter().map(|t| t.url).collect();
        assert_eq!(urls, vec!["https://mine.test/", "https://shop.test/"]);
    }

    #[test]
    fn compaction_keeps_what_is_true() {
        let (dir, mut store) = fresh();
        for n in 0..50 {
            store.set_setting("zoom", json!(n));
        }
        store.compact();
        let lines = std::fs::read_to_string(store.log_path(&store.device)).unwrap();
        assert_eq!(lines.lines().count(), 1);
        drop(store);
        assert_eq!(BrowserStore::open(dir.path()).settings()["zoom"], 49);
    }
}
