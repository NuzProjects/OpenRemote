//! Sealing for the synced browser profile: XChaCha20-Poly1305 with a fresh
//! random nonce per message (24 bytes, so random nonces never repeat in
//! practice), and the place a message belongs bound in as associated data,
//! so a sealed message moved to another place fails to open instead of
//! being read as something it isn't.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use sha2::{Digest, Sha256};

const NONCE: usize = 24;
const TAG: usize = 16;

/// 32 bytes from the operating system's own randomness.
pub fn random32() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the system's randomness");
    bytes
}

/// `plain`, sealed under `key` for `place`: base64 of the nonce and the
/// ciphertext.
pub fn seal(key: &[u8; 32], place: &[u8], plain: &[u8]) -> String {
    let mut nonce = [0u8; NONCE];
    getrandom::fill(&mut nonce).expect("the system's randomness");
    let cipher = XChaCha20Poly1305::new(&Key::from(*key));
    let sealed = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: plain,
                aad: place,
            },
        )
        .expect("sealing takes any length");
    let mut out = Vec::with_capacity(NONCE + sealed.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    BASE64.encode(out)
}

/// What `seal` sealed, if `key` and `place` are the ones it was sealed
/// with and nothing in it changed.
pub fn open(key: &[u8; 32], place: &[u8], sealed: &str) -> Option<Vec<u8>> {
    let raw = BASE64.decode(sealed).ok()?;
    if raw.len() < NONCE + TAG {
        return None;
    }
    let (nonce, body) = raw.split_at(NONCE);
    let nonce: [u8; NONCE] = nonce.try_into().ok()?;
    XChaCha20Poly1305::new(&Key::from(*key))
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: body,
                aad: place,
            },
        )
        .ok()
}

/// A key's public name: the start of its SHA-256 in hex. Telling keys
/// apart this way reveals nothing about them.
pub fn key_id(key: &[u8; 32]) -> String {
    let digest = Sha256::digest(key);
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

pub fn to_base64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

pub fn from_base64(text: &str) -> Option<Vec<u8>> {
    BASE64.decode(text).ok()
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sealed_message_opens_only_with_its_key_in_its_place() {
        let key = random32();
        let sealed = seal(&key, b"cookie|a", b"secret");
        assert_eq!(
            open(&key, b"cookie|a", &sealed).as_deref(),
            Some(&b"secret"[..])
        );
        assert_eq!(open(&key, b"cookie|b", &sealed), None);
        assert_eq!(open(&random32(), b"cookie|a", &sealed), None);
        assert_ne!(sealed, seal(&key, b"cookie|a", b"secret"), "a fresh nonce");
        assert_eq!(from_hex(&to_hex(&key)).as_deref(), Some(&key[..]));
        assert_eq!(key_id(&key).len(), 16);
    }
}
