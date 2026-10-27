//! The one line `opencode serve` prints when it is ready.
//!
//! v1 prints `opencode server listening on http://127.0.0.1:<port>`.
//! v2 dropped the product name: `server listening on http://127.0.0.1:<port>`.
//! The v1 prefix is tried first: a line that names the product is a v1
//! server's.

/// Which serve generation produced the listening line. The HTTP bodies
/// diverged with it (v2 prompts are `{text}`, not `{prompt:{text}}`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Wire {
    V1,
    V2,
}

pub(crate) fn parse_listen_line(line: &str) -> Option<(Wire, u16)> {
    let line = line.trim();
    // The v1 prefix first: it ends with the v2 one, so a test that only
    // looked for the shorter prefix could not tell a v1 line from a v2 one,
    // and reading a v1 server as Wire::V2 sends it v2 bodies. The port is no
    // clue either way: both lines leave the same `127.0.0.1:<port>` tail and
    // the last segment is read from it.
    let (wire, rest) = if let Some(rest) = line.strip_prefix("opencode server listening on ") {
        (Wire::V1, rest)
    } else {
        (Wire::V2, line.strip_prefix("server listening on ")?)
    };
    let port = rest.rsplit(':').next()?.trim().parse().ok()?;
    Some((wire, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_and_v2_listen_lines() {
        assert_eq!(
            parse_listen_line("opencode server listening on http://127.0.0.1:4096\r"),
            Some((Wire::V1, 4096))
        );
        assert_eq!(
            parse_listen_line("server listening on http://127.0.0.1:58914"),
            Some((Wire::V2, 58914))
        );
        assert!(parse_listen_line("Database is not empty and has no session table").is_none());
    }
}
