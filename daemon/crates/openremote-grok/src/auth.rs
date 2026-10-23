//! How Grok Build is allowed to run. A browser login writes
//! `~/.grok/auth.json`. An xAI API key is the other way in: `XAI_API_KEY`,
//! or the `env_key` a model names in `config.toml`. Either one is enough.
//! The key's value is never logged.

use std::ffi::OsString;
use std::path::PathBuf;

/// `Some(true)` when `grok login` has written a session. An API key does
/// not count: the composer stays usable, and the bar offers sign-in as
/// optional. `None` when the login file cannot be read.
pub fn signed_in() -> Option<bool> {
    match read_auth() {
        Auth::Present => Some(true),
        Auth::Missing | Auth::Empty => Some(false),
        Auth::Unreadable => None,
    }
}

/// An xAI API key is set, and there is no browser login. That is enough
/// to run, and the bar says so.
pub fn using_api_key() -> bool {
    !matches!(read_auth(), Auth::Present) && api_key_names().into_iter().any(|name| env_set(&name))
}

/// Keys that live in the user environment but not in this process. The
/// caller puts them on the Grok child. Values are never logged.
pub fn missing_api_keys() -> Vec<(String, OsString)> {
    api_key_names()
        .into_iter()
        .filter(|name| std::env::var_os(name).is_none_or(|value| value.is_empty()))
        .filter_map(|name| user_env_value(&name).map(|value| (name, value)))
        .collect()
}

enum Auth {
    Present,
    Empty,
    Missing,
    Unreadable,
}

fn read_auth() -> Auth {
    let Some(home) = home() else {
        return Auth::Unreadable;
    };
    match std::fs::read_to_string(home.join(".grok").join("auth.json")) {
        Ok(text) if !text.trim().is_empty() && text.trim() != "{}" => Auth::Present,
        Ok(_) => Auth::Empty,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Auth::Missing,
        Err(_) => Auth::Unreadable,
    }
}

fn api_key_names() -> Vec<String> {
    let mut names = vec!["XAI_API_KEY".to_string()];
    let Some(home) = home() else {
        return names;
    };
    let Ok(text) = std::fs::read_to_string(home.join(".grok").join("config.toml")) else {
        return names;
    };
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("env_key") else {
            continue;
        };
        let rest = rest.trim_start().trim_start_matches('=').trim();
        for name in quoted(rest) {
            if !name.is_empty() && !names.iter().any(|have| have == name) {
                names.push(name.to_string());
            }
        }
    }
    names
}

fn quoted(line: &str) -> impl Iterator<Item = &str> {
    line.split('"')
        .enumerate()
        .filter(|(i, _)| i % 2 == 1)
        .map(|(_, text)| text)
}

fn env_set(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| !value.is_empty()) || user_env_value(name).is_some()
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn user_env_value(name: &str) -> Option<OsString> {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("reg")
            .args(["query", "HKCU\\Environment", "/v", name])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let line = line.trim();
            let Some(rest) = line.strip_prefix(name) else {
                continue;
            };
            let rest = rest.trim();
            let value = rest
                .strip_prefix("REG_SZ")
                .or_else(|| rest.strip_prefix("REG_EXPAND_SZ"))?
                .trim();
            if value.is_empty() {
                return None;
            }
            return Some(value.into());
        }
        None
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::quoted;

    #[test]
    fn env_key_names_come_out_of_the_config_line() {
        let line = r#"env_key = "XAI_API_KEY""#;
        assert_eq!(quoted(line).collect::<Vec<_>>(), vec!["XAI_API_KEY"]);
        let many = r#"env_key = ["XAI_API_KEY", "GROK_API_KEY"]"#;
        assert_eq!(
            quoted(many).collect::<Vec<_>>(),
            vec!["XAI_API_KEY", "GROK_API_KEY"]
        );
    }
}
