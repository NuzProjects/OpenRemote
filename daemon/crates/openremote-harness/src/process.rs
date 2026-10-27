//! Ending a harness process, and the processes it started.
//!
//! A harness CLI is not one process. claude and codex start MCP servers, pi
//! starts helpers, and each of those is a child of the CLI: OpenRemote never
//! spawned it, holds no handle on it, and knows nothing about it except that
//! it runs as the same user. They inherit the environment the daemon handed
//! the chat, so a server left behind keeps whatever the CLI was given - a
//! plugin's MCP server keeps the token it reads from the data folder - and
//! nothing in OpenRemote will ever look at it again. Killing the CLI alone
//! leaves those running until a person finds them.

#[cfg(windows)]
use std::process::Stdio;

/// Ends a harness process and everything it started.
///
/// On Windows the child is spawned into its own process group
/// (`creation_flags`), but a group is a console signal scope rather than a
/// job object: nothing walks it when the child dies, and a Ctrl-C sent to it
/// is not a kill. `taskkill /T` walks the process list by parent id and ends
/// the whole tree, which is the dependency-free way to get what a job object
/// would give. Two limits are worth knowing. It can only find the tree
/// through a parent that is still alive: a CLI that already exited has
/// orphaned its helpers, and only a job object would have kept them. And it
/// is a separate process, so it is not atomic with the rest of a stop.
///
/// Everywhere else this kills the child alone, as it always did. The group
/// equivalent there is `setpgid` at spawn and `killpg` at the end, and both
/// want a libc binding this crate does not depend on.
pub async fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            // Before the child is killed, not after: taskkill finds the tree
            // through the parent's id, so a tree whose parent is already
            // gone cannot be found at all.
            let mut command = tokio::process::Command::new(taskkill_exe());
            command
                .arg("/T")
                .arg("/F")
                .arg("/PID")
                .arg(pid.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                // A console program: without this, stopping a chat flashes a
                // window on a desktop.
                .creation_flags(CREATE_NO_WINDOW);
            // A refusal here means the tree was already gone, which is the
            // answer this function wants.
            let _ = command.status().await;
        }
    }
    // The harness child itself, whether or not the tree walk could reach it.
    // A stop must not depend on a helper process being available.
    let _ = child.start_kill();
}

/// `CREATE_NO_WINDOW`, as in `creation_flags`: no console for taskkill.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `%SystemRoot%\System32\taskkill.exe`. By absolute path rather than by
/// name: this runs as the user, and a directory earlier in PATH would be
/// able to stand in for it.
#[cfg(windows)]
fn taskkill_exe() -> std::path::PathBuf {
    let root = std::env::var_os("SystemRoot")
        .filter(|root| !root.is_empty())
        .unwrap_or_else(|| "C:\\Windows".into());
    std::path::PathBuf::from(root)
        .join("System32")
        .join("taskkill.exe")
}
