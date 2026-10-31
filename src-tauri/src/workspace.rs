//! Open a chat's folder, and commit the files that chat reported changing.
//!
//! Commit is git's own commit, of those paths only. It does not stage the
//! rest of the tree, and it does not push.

use std::path::{Component, Path, PathBuf};
use std::process::Command;

/// Open a folder in the system file manager.
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err("that folder is not here".into());
    }
    hide_window(Command::new(opener()).arg(&path))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// `git add` the given paths, then `git commit` them. Paths outside the
/// folder are refused. An empty message is refused. Git's own sentence
/// comes back when the commit does not land.
#[tauri::command]
pub fn workspace_commit(
    workspace: String,
    message: String,
    paths: Vec<String>,
) -> Result<String, String> {
    let workspace = PathBuf::from(workspace.trim());
    if !workspace.is_absolute() || !workspace.is_dir() {
        return Err("this chat has no folder to commit in".into());
    }
    let message = message.trim();
    if message.is_empty() {
        return Err("a commit needs a message".into());
    }
    if message.len() > 2000 || message.contains('\0') {
        return Err("that commit message cannot be used".into());
    }
    if paths.is_empty() {
        return Err("this chat has not reported a file to commit".into());
    }
    let mut args = Vec::with_capacity(paths.len());
    for raw in &paths {
        args.push(path_in(&workspace, raw)?);
    }

    let inside = git(&workspace, &["rev-parse", "--is-inside-work-tree"])?;
    if inside.trim() != "true" {
        return Err("this folder is not a git repository".into());
    }

    let mut add = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
    add.extend(args);
    let add_args: Vec<&str> = add.iter().map(String::as_str).collect();
    git(&workspace, &add_args)?;

    let committed = git(&workspace, &["commit", "-m", message])?;
    let line = committed.lines().next().unwrap_or("").trim();
    Ok(if line.is_empty() {
        "Committed.".into()
    } else {
        line.to_string()
    })
}

fn opener() -> &'static str {
    if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    }
}

fn path_in(workspace: &Path, raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err("a path in this commit is not usable".into());
    }
    let path = PathBuf::from(raw);
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("a path in this commit leaves the folder".into());
    }
    if path.is_absolute() && !path.starts_with(workspace) {
        return Err("a path in this commit is outside the folder".into());
    }
    Ok(raw.to_string())
}

fn git(workspace: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null());
    let output = hide_window(&mut command)
        .output()
        .map_err(|_| "git is not available".to_string())?;
    let text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(if out.is_empty() { text } else { out });
    }
    Err(if text.is_empty() {
        "git refused the commit".into()
    } else {
        text.lines()
            .next()
            .unwrap_or("git refused the commit")
            .to_string()
    })
}

fn hide_window(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
