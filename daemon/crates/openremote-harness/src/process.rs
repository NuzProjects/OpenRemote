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
#[cfg(windows)]
use std::time::Duration;

/// How long the tree walk may take. The drivers kill and then wait five
/// seconds for the child to go, so this has to fit inside a stop rather than
/// hold it open; a walk that overruns is abandoned and the child is killed on
/// its own.
#[cfg(windows)]
const TREE_WALK_TIMEOUT: Duration = Duration::from_secs(5);

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
            // answer this function wants. The deadline is not about taskkill
            // being slow: a process enumeration can hang behind an endpoint
            // protection driver or a stopped process, and the callers await
            // this before their own timed wait, so an unbounded wait here
            // would let one stuck walk hang a stop forever. Timing out means
            // the tree walk was abandoned, not that the tree is dead - the
            // child itself is still killed below.
            let _ = tokio::time::timeout(TREE_WALK_TIMEOUT, command.status()).await;
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
///
/// `SystemRoot` itself has to be absolute before it is joined, or this hands
/// back a path that is resolved against the daemon's current directory:
/// `SystemRoot=foo` would mean `foo\System32\taskkill.exe` there, and a value
/// of `..\somewhere` would point at whatever that folder holds. The daemon's
/// environment is not a remote input, but `HKCU\Environment` makes it a
/// cheap way to plant one, so the value is checked rather than trusted.
#[cfg(windows)]
fn taskkill_exe() -> std::path::PathBuf {
    taskkill_under(std::env::var_os("SystemRoot").as_deref())
}

/// The same choice, from a value the caller supplies, so the rule can be
/// checked without touching the process environment: a test that set it
/// would be changing a global every other test in the binary can see.
#[cfg(windows)]
fn taskkill_under(root: Option<&std::ffi::OsStr>) -> std::path::PathBuf {
    let root = root
        .map(std::path::PathBuf::from)
        .filter(|root| root.is_absolute())
        .unwrap_or_else(|| std::path::PathBuf::from("C:\\Windows"));
    root.join("System32").join("taskkill.exe")
}

#[cfg(all(test, windows))]
mod tests {
    use std::ffi::OsStr;
    use std::path::Path;

    use super::taskkill_under;

    #[test]
    fn a_system_root_that_is_not_absolute_is_not_used_for_the_tree_walk() {
        let expected = Path::new("C:\\Windows\\System32\\taskkill.exe");
        // A relative value would be resolved against whatever folder the
        // daemon happens to run in, which is how a planted one would choose
        // the program.
        assert_eq!(taskkill_under(Some(OsStr::new("foo"))), expected);
        assert_eq!(taskkill_under(Some(OsStr::new("..\\elsewhere"))), expected);
        assert_eq!(taskkill_under(Some(OsStr::new(".\\Windows"))), expected);
        assert_eq!(taskkill_under(Some(OsStr::new(""))), expected);
        assert_eq!(taskkill_under(None), expected);
        // An absolute one is honoured: Windows is not always on C:.
        assert_eq!(
            taskkill_under(Some(OsStr::new("D:\\Windows"))),
            Path::new("D:\\Windows\\System32\\taskkill.exe")
        );
    }
}
