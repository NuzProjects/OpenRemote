//! The parts of the browser profile that live in the browser engine itself
//! (cookies and sites' local storage), as the daemon and a device's browser
//! trade them so one profile can be shared by all of the user's devices.
//! Everything else the profile holds (history, bookmarks, settings, site
//! permissions, open tabs) already lives in the daemon.
//!
//! The browser reports what changed in its profile ([`ProfileNews`]) and
//! makes the changes that happened elsewhere ([`ProfileApply`]); the daemon
//! keeps the merged truth, seals it for the user's other devices, and works
//! out what each side is missing. Also here, so every engine leaves the same
//! things out: the cookies that never leave a device ([`NEVER_SYNCED`]), the
//! hosts that are a computer's own ([`local_host`]), and the matching behind
//! the per-site "don't sync" switch ([`site_of`], [`skipped`]).
//!
//! Saved passwords are deliberately not part of this: they belong to the
//! password manager, which keeps and syncs them itself.

use serde::{Deserialize, Serialize};

/// Cookies that never leave the device that got them, whatever the site.
/// Each is tied to the device it was issued to (its address, its TLS
/// fingerprint, or a key that never leaves its hardware), so a copy on
/// another device is refused or, worse, gets the account flagged.
pub const NEVER_SYNCED: &[&str] = &[
    // Cloudflare's bot checks and load balancing: bound to the client.
    "cf_clearance",
    "__cf_bm",
    "_cfuvid",
    "__cflb",
    "__cfwaitingroom",
    // Device-bound session credentials (Google's): the short-lived
    // halves are renewed by proving a key held in this device's hardware.
    "__Secure-1PSIDTS",
    "__Secure-3PSIDTS",
    "__Secure-1PSIDRTS",
    "__Secure-3PSIDRTS",
];

/// A site's local storage entry larger than this stays on its device.
pub const MAX_STORAGE_VALUE: usize = 64 * 1024;
/// Past this much of one site's local storage, further entries stay on
/// their device.
pub const MAX_STORAGE_SITE: usize = 1024 * 1024;

/// One cookie, with everything a browser needs to set it again elsewhere.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    /// A bare host for a cookie only that host gets; a leading dot for one
    /// its whole domain shares (`.example.com`).
    pub domain: String,
    #[serde(default = "root")]
    pub path: String,
    /// When it expires, in seconds since 1970; none for a session cookie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub secure: bool,
    /// `lax`, `strict` or `none`.
    #[serde(default = "lax")]
    pub same_site: String,
}

fn root() -> String {
    "/".into()
}

fn lax() -> String {
    "lax".into()
}

impl Cookie {
    /// Where the cookie sits: a browser holds one cookie per domain, path
    /// and name.
    pub fn slot(&self) -> CookieSlot {
        CookieSlot {
            name: self.name.clone(),
            domain: self.domain.clone(),
            path: self.path.clone(),
        }
    }

    pub fn key(&self) -> String {
        self.slot().key()
    }

    pub fn expired(&self, now_secs: f64) -> bool {
        self.expires.is_some_and(|at| at <= now_secs)
    }

    /// The host the cookie belongs to, without the leading dot.
    pub fn host(&self) -> &str {
        self.domain.trim_start_matches('.')
    }

    /// The same cookie as any engine would hand it back: the expiry to the
    /// whole second (engines keep different precision) and the same-site
    /// word in lower case. Two devices compare cookies in this form.
    pub fn normalized(&self) -> Cookie {
        Cookie {
            expires: self.expires.map(f64::trunc),
            same_site: match self.same_site.to_ascii_lowercase().as_str() {
                "strict" => "strict".into(),
                "none" | "no_restriction" => "none".into(),
                _ => "lax".into(),
            },
            path: if self.path.is_empty() {
                "/".into()
            } else {
                self.path.clone()
            },
            ..self.clone()
        }
    }
}

/// A cookie's place in the profile: what removing one takes.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CookieSlot {
    pub name: String,
    pub domain: String,
    #[serde(default = "root")]
    pub path: String,
}

/// Between the parts of a key: a control character, which no domain, path
/// or cookie name may hold.
const SEP: char = '\u{1f}';

impl CookieSlot {
    /// One string per slot, for the daemon's keyed records.
    pub fn key(&self) -> String {
        format!("{}{SEP}{}{SEP}{}", self.domain, self.path, self.name)
    }

    pub fn from_key(key: &str) -> Option<CookieSlot> {
        let mut parts = key.splitn(3, SEP);
        let (domain, path, name) = (parts.next()?, parts.next()?, parts.next()?);
        Some(CookieSlot {
            name: name.into(),
            domain: domain.into(),
            path: path.into(),
        })
    }
}

/// One entry of a site's local storage. No value: the entry was removed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StorageItem {
    /// The site's origin, `https://example.com` (a port when there is one).
    pub origin: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

impl StorageItem {
    /// One string per entry, for the daemon's keyed records.
    pub fn slot(&self) -> String {
        storage_slot(&self.origin, &self.key)
    }
}

pub fn storage_slot(origin: &str, key: &str) -> String {
    format!("{origin}{SEP}{key}")
}

/// An entry's origin and key back from its slot.
pub fn split_storage_slot(slot: &str) -> Option<(&str, &str)> {
    slot.split_once(SEP)
}

/// What a browser tells the daemon about its profile. While sync is off on
/// the device, it says nothing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileNews {
    /// Every cookie the profile holds now. Sent when sync starts watching
    /// (the browser's first page, or sync turned on), so the daemon can
    /// tell what changed while nobody watched from what changed elsewhere.
    AllCookies { cookies: Vec<Cookie> },
    /// Cookies set or changed since the last report, and the ones gone.
    Cookies {
        #[serde(default)]
        set: Vec<Cookie>,
        #[serde(default)]
        removed: Vec<CookieSlot>,
    },
    /// Local storage entries pages changed.
    Storage { items: Vec<StorageItem> },
    /// Everything one site keeps in local storage now, the first time a
    /// page of the site opened since sync started watching.
    AllStorage {
        origin: String,
        items: Vec<StorageItem>,
    },
}

/// What the daemon asks a browser to do to its profile.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileApply {
    /// Whether the profile syncs on this device, and the sites the user
    /// keeps out of it. Sent after every hello and whenever either changes.
    Watch {
        on: bool,
        #[serde(default)]
        skip: Vec<String>,
    },
    /// Cookies another device set or removed.
    Cookies {
        #[serde(default)]
        set: Vec<Cookie>,
        #[serde(default)]
        removed: Vec<CookieSlot>,
    },
    /// Local storage entries another device set or removed.
    Storage { items: Vec<StorageItem> },
}

/// A host as the per-site switch names it: lower case, without a leading
/// dot, a port or `www.`.
pub fn site_of(host: &str) -> String {
    let host = host.trim().trim_start_matches('.').to_ascii_lowercase();
    let host = match host.rsplit_once(':') {
        // A port: digits after the last colon, where the colon ends a name
        // or a bracketed IPv6 address (a bare one's colons are its own).
        Some((name, port))
            if !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit())
                && (name.ends_with(']') || !name.contains(':')) =>
        {
            name.to_string()
        }
        _ => host,
    };
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

/// Whether a host belongs to one of these sites: the site itself, or a
/// name under it (`mail.example.com` belongs to `example.com`).
pub fn skipped(host: &str, sites: &[String]) -> bool {
    let host = site_of(host);
    sites.iter().any(|site| {
        let site = site_of(site);
        !site.is_empty() && (host == site || host.ends_with(&format!(".{site}")))
    })
}

/// A host that is this computer's own: a page there is a dev server, and
/// its cookies and storage mean nothing on another device.
pub fn local_host(host: &str) -> bool {
    let host = site_of(host);
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || bare == "::1"
        || bare == "0.0.0.0"
        || bare.starts_with("127.")
}

/// Whether a cookie may leave this device.
pub fn cookie_syncs(cookie: &Cookie, skip: &[String]) -> bool {
    !NEVER_SYNCED.contains(&cookie.name.as_str())
        && !cookie.host().is_empty()
        && !local_host(cookie.host())
        && !skipped(cookie.host(), skip)
}

/// The host of a web origin (`https://example.com:8443` gives
/// `example.com:8443`); none for anything that isn't http or https.
pub fn origin_host(origin: &str) -> Option<&str> {
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    (!host.is_empty()).then_some(host)
}

/// Whether a site's local storage may leave this device.
pub fn origin_syncs(origin: &str, skip: &[String]) -> bool {
    origin_host(origin).is_some_and(|host| !local_host(host) && !skipped(host, skip))
}

/// Whether one local storage entry is small enough to sync.
pub fn storage_value_syncs(value: &str) -> bool {
    value.len() <= MAX_STORAGE_VALUE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(name: &str, domain: &str) -> Cookie {
        Cookie {
            name: name.into(),
            value: "v".into(),
            domain: domain.into(),
            path: "/".into(),
            expires: Some(1_900_000_000.25),
            http_only: true,
            secure: true,
            same_site: "Lax".into(),
        }
    }

    #[test]
    fn a_cookie_slot_survives_its_key() {
        let c = cookie("sid|odd=name", ".example.com");
        assert_eq!(CookieSlot::from_key(&c.key()), Some(c.slot()));
        assert_eq!(c.normalized().expires, Some(1_900_000_000.0));
        assert_eq!(c.normalized().same_site, "lax");
    }

    #[test]
    fn some_cookies_never_leave_the_device() {
        assert!(cookie_syncs(&cookie("sid", ".example.com"), &[]));
        assert!(!cookie_syncs(&cookie("cf_clearance", ".example.com"), &[]));
        assert!(!cookie_syncs(
            &cookie("__Secure-1PSIDTS", ".google.com"),
            &[]
        ));
        assert!(!cookie_syncs(&cookie("sid", "localhost"), &[]));
        assert!(!cookie_syncs(&cookie("sid", "127.0.0.1"), &[]));
        assert!(!cookie_syncs(&cookie("sid", "app.localhost"), &[]));
        let skip = vec!["example.com".to_string()];
        assert!(!cookie_syncs(&cookie("sid", ".mail.example.com"), &skip));
        assert!(cookie_syncs(&cookie("sid", ".notexample.com"), &skip));
    }

    #[test]
    fn sites_are_named_the_way_people_say_them() {
        assert_eq!(site_of("WWW.Example.com:443"), "example.com");
        assert_eq!(site_of(".example.com"), "example.com");
        assert_eq!(site_of("[::1]:3000"), "[::1]");
        assert!(origin_syncs("https://example.com", &[]));
        assert!(!origin_syncs("http://localhost:5173", &[]));
        assert!(!origin_syncs("file:///C:/x.html", &[]));
        assert!(!origin_syncs(
            "https://www.example.com",
            &["example.com".to_string()]
        ));
        let item = StorageItem {
            origin: "https://example.com".into(),
            key: "theme".into(),
            value: Some("dark".into()),
        };
        assert_eq!(
            split_storage_slot(&item.slot()),
            Some(("https://example.com", "theme"))
        );
    }
}
