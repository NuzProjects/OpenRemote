//! The key that keeps the synced browser profile private on this device's
//! disk, held by the operating system's own keystore, so the profile's
//! files are of no use copied to another computer or read by another user.
//!
//! - Windows: the user's data protection (DPAPI), tied to their sign-in.
//! - macOS: the login keychain, through the system's own `security` tool.
//! - Linux: the desktop's Secret Service, through `secret-tool` when it is
//!   installed.
//! - Everywhere else, or when those refuse: a file only this user can read.
//!   That includes Android for now, whose app storage is already private
//!   to the app; its own Keystore needs the app's Java side, which the
//!   Android browser can bring later behind the same trait.
//!
//! Only a device that runs a browser ever asks for the key: an always-on
//! machine without one relays the profile sealed and never holds a key.

use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::seal::{from_hex, random32, to_hex};

/// Somewhere this device can keep one secret.
pub trait Keystore: Send + Sync {
    /// What holds the key, in the console's words.
    fn name(&self) -> &'static str;
    /// The secret saved before, if any (and if it can still be read here).
    fn load(&self) -> Option<Vec<u8>>;
    fn save(&self, secret: &[u8]) -> io::Result<()>;
}

/// This device's key for its profile's files, and what holds it.
#[derive(Clone)]
pub struct DeviceKey {
    pub key: [u8; 32],
    pub held_by: &'static str,
}

/// The keystores this device can use, the strongest first.
pub fn keystores(dir: &Path) -> Vec<Box<dyn Keystore>> {
    #[cfg(windows)]
    let first: Option<Box<dyn Keystore>> = Some(Box::new(dpapi::Dpapi {
        path: dir.join("device-key.dpapi"),
    }));
    #[cfg(target_os = "macos")]
    let first: Option<Box<dyn Keystore>> = Some(Box::new(tools::Keychain {
        account: slot_name(dir),
    }));
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
    let first: Option<Box<dyn Keystore>> = Some(Box::new(tools::SecretService {
        slot: slot_name(dir),
    }));
    #[cfg(any(target_os = "android", not(any(windows, unix))))]
    let first: Option<Box<dyn Keystore>> = None;
    let file: Box<dyn Keystore> = Box::new(OwnerFile {
        path: dir.join("device-key"),
    });
    first.into_iter().chain(std::iter::once(file)).collect()
}

/// This device's key: the one saved before, or a new one saved now in the
/// strongest keystore that takes it.
pub fn device_key(dir: &Path) -> DeviceKey {
    let stores = keystores(dir);
    for store in &stores {
        if let Some(key) = store.load().and_then(|raw| <[u8; 32]>::try_from(raw).ok()) {
            return DeviceKey {
                key,
                held_by: store.name(),
            };
        }
    }
    let key = random32();
    for store in &stores {
        // Read back before trusting it: a keystore that takes a key and
        // can't give it back would lose everything sealed with it.
        if store.save(&key).is_ok() && store.load().as_deref() == Some(&key[..]) {
            return DeviceKey {
                key,
                held_by: store.name(),
            };
        }
    }
    // Nothing would keep it: this run still works, and what it sealed comes
    // back from the user's other devices after a restart.
    DeviceKey {
        key,
        held_by: "memory only, until the app restarts",
    }
}

/// A name for this data folder's key that says nothing about the folder.
#[cfg_attr(any(windows, target_os = "android"), allow(dead_code))]
fn slot_name(dir: &Path) -> String {
    let digest = Sha256::digest(dir.to_string_lossy().as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("openremote-browser-{hex}")
}

/// The fallback: a file only this user can read.
struct OwnerFile {
    path: PathBuf,
}

impl Keystore for OwnerFile {
    fn name(&self) -> &'static str {
        "a file only your account can read"
    }

    fn load(&self) -> Option<Vec<u8>> {
        from_hex(&std::fs::read_to_string(&self.path).ok()?)
    }

    fn save(&self, secret: &[u8]) -> io::Result<()> {
        openremote_core::fsx::write_private(&self.path, to_hex(secret).as_bytes())
    }
}

/// Windows' data protection: the key is sealed to this user's sign-in on
/// this computer, and only a program running as them here can open it.
#[cfg(windows)]
// The daemon's other unsafe block is in install.rs; these are the two
// calls DPAPI is, and nothing else here touches raw memory.
#[allow(unsafe_code)]
mod dpapi {
    use std::io;
    use std::path::PathBuf;

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    use super::Keystore;

    /// Mixed in by both calls, so another program of the same user can't
    /// open the key just by asking DPAPI (it would need this too).
    const ENTROPY: &[u8] = b"openremote browser profile key";

    pub struct Dpapi {
        pub path: PathBuf,
    }

    fn blob(bytes: &[u8]) -> Option<CRYPT_INTEGER_BLOB> {
        Some(CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(bytes.len()).ok()?,
            pbData: bytes.as_ptr().cast_mut(),
        })
    }

    /// Copies out what DPAPI handed back and frees it as DPAPI asks.
    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if out.pbData.is_null() {
            return Vec::new();
        }
        // SAFETY: DPAPI allocated `cbData` bytes at `pbData` with
        // LocalAlloc for this call's result; they are read once, then
        // freed with LocalFree, as its documentation requires, and the
        // pointer is never used again.
        unsafe {
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData.cast());
            bytes
        }
    }

    fn protect(plain: &[u8]) -> Option<Vec<u8>> {
        let (input, entropy) = (blob(plain)?, blob(ENTROPY)?);
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` and `entropy` point at slices that outlive the
        // call and that DPAPI only reads; the description, reserved and
        // prompt arguments may be null; `output` is written by the call.
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        (ok != 0).then(|| take(output))
    }

    fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
        let (input, entropy) = (blob(sealed)?, blob(ENTROPY)?);
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as in `protect`; the description's out-pointer may be
        // null when the caller doesn't want it.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        (ok != 0).then(|| take(output))
    }

    impl Keystore for Dpapi {
        fn name(&self) -> &'static str {
            "your Windows sign-in"
        }

        fn load(&self) -> Option<Vec<u8>> {
            unprotect(&std::fs::read(&self.path).ok()?)
        }

        fn save(&self, secret: &[u8]) -> io::Result<()> {
            let sealed = protect(secret).ok_or_else(|| io::Error::other("DPAPI refused"))?;
            openremote_core::fsx::write_private(&self.path, &sealed)
        }
    }
}

/// The macOS and Linux keystores, through the system's own tools: no new
/// libraries, and the key never appears in a command line.
#[cfg(all(unix, not(target_os = "android")))]
mod tools {
    use std::io::{self, Read, Write};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use super::super::seal::{from_hex, to_hex};
    use super::Keystore;

    /// Runs a system tool, feeding it `input`, and answers what it printed
    /// when it succeeds within a few seconds (a keyring waiting on a
    /// prompt nobody answers must not hold the daemon up).
    fn run(program: &str, args: &[&str], input: Option<&[u8]>) -> Option<Vec<u8>> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        if let Some(input) = input {
            let mut stdin = child.stdin.take()?;
            let _ = stdin.write_all(input);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut out = Vec::new();
                    child.stdout.take()?.read_to_end(&mut out).ok()?;
                    return status.success().then_some(out);
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    const SERVICE: &str = "OpenRemote browser";

    /// The login keychain.
    #[cfg(target_os = "macos")]
    pub struct Keychain {
        pub account: String,
    }

    #[cfg(target_os = "macos")]
    impl Keystore for Keychain {
        fn name(&self) -> &'static str {
            "your login keychain"
        }

        fn load(&self) -> Option<Vec<u8>> {
            let out = run(
                "/usr/bin/security",
                &[
                    "find-generic-password",
                    "-a",
                    &self.account,
                    "-s",
                    SERVICE,
                    "-w",
                ],
                None,
            )?;
            from_hex(std::str::from_utf8(&out).ok()?)
        }

        fn save(&self, secret: &[u8]) -> io::Result<()> {
            // Given on the tool's own input, so the key never shows in the
            // list of running programs.
            let line = format!(
                "add-generic-password -U -a {} -s \"{SERVICE}\" -w {}\n",
                self.account,
                to_hex(secret)
            );
            run("/usr/bin/security", &["-i"], Some(line.as_bytes()))
                .map(|_| ())
                .ok_or_else(|| io::Error::other("the keychain didn't take the key"))
        }
    }

    /// The desktop's Secret Service (GNOME Keyring, KWallet).
    #[cfg(not(target_os = "macos"))]
    pub struct SecretService {
        pub slot: String,
    }

    #[cfg(not(target_os = "macos"))]
    impl Keystore for SecretService {
        fn name(&self) -> &'static str {
            "your desktop's keyring"
        }

        fn load(&self) -> Option<Vec<u8>> {
            let out = run(
                "secret-tool",
                &["lookup", "application", "openremote", "slot", &self.slot],
                None,
            )?;
            from_hex(std::str::from_utf8(&out).ok()?)
        }

        fn save(&self, secret: &[u8]) -> io::Result<()> {
            run(
                "secret-tool",
                &[
                    "store",
                    "--label=OpenRemote browser",
                    "application",
                    "openremote",
                    "slot",
                    &self.slot,
                ],
                Some(to_hex(secret).as_bytes()),
            )
            .map(|_| ())
            .ok_or_else(|| io::Error::other("the keyring didn't take the key"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_device_key_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let first = device_key(dir.path());
        let again = device_key(dir.path());
        assert_eq!(first.key, again.key);
        assert_eq!(first.held_by, again.held_by);
    }
}
