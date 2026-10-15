//! @ file suggestions: the files and folders of a workspace on this
//! machine as the chat would see them. In a git repository that is what
//! git tracks plus the untracked files it doesn't ignore, so .gitignore
//! keeps node_modules and build output out; anywhere else, a bounded
//! walk. A listing is kept a few seconds, so typing doesn't re-list on
//! every key, and ranked by a fuzzy match on the query.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long a listing serves before the workspace is listed again.
const FRESH_FOR: Duration = Duration::from_secs(10);
/// A walk outside git stops here: a home folder is not a project.
const WALK_LIMIT: usize = 20_000;
/// At most this many suggestions per query.
pub const RESULTS: usize = 50;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FileEntry {
    /// Relative to the workspace, forward slashes.
    pub path: String,
    /// `file` or `dir`.
    pub kind: &'static str,
}

struct Listing {
    at: Instant,
    entries: Arc<Vec<FileEntry>>,
    truncated: bool,
}

#[derive(Default)]
pub struct FileIndex {
    listings: StdMutex<HashMap<PathBuf, Listing>>,
}

impl FileIndex {
    /// The best matches for `query` in `root`, and whether the listing was
    /// cut short (a walk past its limit).
    pub async fn search(&self, root: &Path, query: &str) -> Result<(Vec<FileEntry>, bool), String> {
        if !root.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        let cached = self
            .listings
            .lock()
            .expect("listings lock")
            .get(root)
            .filter(|l| l.at.elapsed() < FRESH_FOR)
            .map(|l| (Arc::clone(&l.entries), l.truncated));
        let (entries, truncated) = match cached {
            Some(hit) => hit,
            None => {
                let owned = root.to_path_buf();
                let (entries, truncated) = tokio::task::spawn_blocking(move || list(&owned))
                    .await
                    .map_err(|e| e.to_string())?;
                let entries = Arc::new(entries);
                self.listings.lock().expect("listings lock").insert(
                    root.to_path_buf(),
                    Listing {
                        at: Instant::now(),
                        entries: Arc::clone(&entries),
                        truncated,
                    },
                );
                (entries, truncated)
            }
        };
        Ok((rank(&entries, query), truncated))
    }
}

/// Every file and folder of the workspace: git's view when it is a
/// repository, a bounded walk otherwise.
fn list(root: &Path) -> (Vec<FileEntry>, bool) {
    if let Some(files) = git_files(root) {
        return (with_folders(files), false);
    }
    walk(root)
}

/// `git ls-files`: tracked, plus untracked-but-not-ignored. None when this
/// is not a repository or git is missing.
fn git_files(root: &Path) -> Option<Vec<String>> {
    let mut command = std::process::Command::new("git");
    command
        .args(["ls-files", "-co", "--exclude-standard", "-z"])
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(openremote_harness::creation_flags());
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(String::from)
            .collect(),
    )
}

/// The files, plus every folder that holds one.
fn with_folders(files: Vec<String>) -> Vec<FileEntry> {
    let mut folders = BTreeSet::new();
    for file in &files {
        let mut end = 0;
        while let Some(at) = file[end..].find('/') {
            end += at;
            folders.insert(file[..end].to_string());
            end += 1;
        }
    }
    let mut entries: Vec<FileEntry> = folders
        .into_iter()
        .map(|path| FileEntry { path, kind: "dir" })
        .collect();
    entries.extend(
        files
            .into_iter()
            .map(|path| FileEntry { path, kind: "file" }),
    );
    entries
}

/// A breadth-first walk that leaves out `.git` and stops at the limit.
fn walk(root: &Path) -> (Vec<FileEntry>, bool) {
    let mut entries = Vec::new();
    let mut queue = std::collections::VecDeque::from([PathBuf::new()]);
    while let Some(relative) = queue.pop_front() {
        let Ok(read) = std::fs::read_dir(root.join(&relative)) else {
            continue;
        };
        let mut children: Vec<_> = read.flatten().collect();
        children.sort_by_key(|e| e.file_name());
        for child in children {
            let name = child.file_name();
            if name == ".git" {
                continue;
            }
            let Ok(kind) = child.file_type() else {
                continue;
            };
            let path = relative.join(&name);
            let shown = path.to_string_lossy().replace('\\', "/");
            if kind.is_dir() {
                entries.push(FileEntry {
                    path: shown,
                    kind: "dir",
                });
                queue.push_back(path);
            } else if kind.is_file() {
                entries.push(FileEntry {
                    path: shown,
                    kind: "file",
                });
            }
            if entries.len() >= WALK_LIMIT {
                return (entries, true);
            }
        }
    }
    (entries, false)
}

/// The best `RESULTS` entries for a query. An empty query lists the top
/// level, folders first.
pub fn rank(entries: &[FileEntry], query: &str) -> Vec<FileEntry> {
    let query = query.trim().to_lowercase().replace('\\', "/");
    if query.is_empty() {
        let mut top: Vec<FileEntry> = entries
            .iter()
            .filter(|e| !e.path.contains('/'))
            .cloned()
            .collect();
        top.sort_by(|a, b| (a.kind != "dir", &a.path).cmp(&(b.kind != "dir", &b.path)));
        top.truncate(RESULTS);
        return top;
    }
    let mut scored: Vec<(i64, &FileEntry)> = entries
        .iter()
        .filter_map(|e| score(&query, &e.path.to_lowercase()).map(|s| (s, e)))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.path.len().cmp(&b.1.path.len())));
    scored
        .into_iter()
        .take(RESULTS)
        .map(|(_, e)| e.clone())
        .collect()
}

/// How well `path` matches `query`: every query character in order, more
/// for runs, for the start of a segment, for the file name, and for the
/// query whole; less for long paths. None when it doesn't match.
fn score(query: &str, path: &str) -> Option<i64> {
    let name_start = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let chars: Vec<char> = path.chars().collect();
    let mut total: i64 = 0;
    let mut at = 0;
    let mut previous: Option<usize> = None;
    let mut byte = 0;
    let offsets: Vec<usize> = chars
        .iter()
        .map(|c| {
            let start = byte;
            byte += c.len_utf8();
            start
        })
        .collect();
    for q in query.chars() {
        let found = (at..chars.len()).find(|&i| chars[i] == q)?;
        total += 10;
        if previous == Some(found.wrapping_sub(1)) {
            total += 15;
        }
        if found == 0 || matches!(chars[found - 1], '/' | '-' | '_' | '.') {
            total += 20;
        }
        if offsets[found] >= name_start {
            total += 10;
        }
        previous = Some(found);
        at = found + 1;
    }
    let name = &path[name_start..];
    if name.starts_with(query) {
        total += 50;
    } else if path.contains(query) {
        total += 30;
    }
    Some(total - path.len() as i64 / 4)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(paths: &[&str]) -> Vec<FileEntry> {
        with_folders(paths.iter().map(|p| p.to_string()).collect())
    }

    #[test]
    fn the_file_named_by_the_query_ranks_first() {
        let list = entries(&[
            "src/state/console.jsx",
            "src/supervisor_notes.md",
            "daemon/crates/openremote-daemon/src/supervisor.rs",
            "README.md",
        ]);
        let found = rank(&list, "supervisor.rs");
        assert_eq!(
            found[0].path,
            "daemon/crates/openremote-daemon/src/supervisor.rs"
        );
        assert!(rank(&list, "zzz").is_empty());
        // folders come from the files' paths
        assert!(
            list.iter()
                .any(|e| e.path == "src/state" && e.kind == "dir")
        );
    }

    #[test]
    fn an_empty_query_lists_the_top_level_folders_first() {
        let list = entries(&["README.md", "src/a.js", "daemon/x.rs"]);
        let top: Vec<String> = rank(&list, "").into_iter().map(|e| e.path).collect();
        assert_eq!(top, vec!["daemon", "src", "README.md"]);
    }

    #[test]
    fn a_folder_outside_git_is_walked_without_its_git_history() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("notes/.git")).unwrap();
        std::fs::write(dir.path().join("notes/todo.md"), "x").unwrap();
        let (found, truncated) = walk(dir.path());
        assert!(!truncated);
        let paths: Vec<&str> = found.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["notes", "notes/todo.md"]);
    }
}
