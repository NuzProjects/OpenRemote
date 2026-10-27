//! Which address the sign-in's in-app browser may be pointed at.
//!
//! The in-app browser is the trusted frame for the account sign-in: the page
//! it shows is the authorization page of the account service, and the page can
//! hand the app's own return address back to itself. That trust belongs to the
//! account service and nowhere else, so the address has to be on it before the
//! frame is granted; otherwise any page could wear the sign-in's clothes for a
//! caller that names it.

use tauri::Url;

/// Whether `url` is the same origin as `issuer`, the account service this
/// build signs in to.
///
/// Same origin, not same host: a different scheme or port is a different
/// endpoint, and a subdomain or a lookalike suffix is a different service.
/// Anything that does not parse, or is not http(s), is not the sign-in.
pub fn trusted_sign_in_page(url: &str, issuer: &str) -> bool {
    let (Ok(url), Ok(issuer)) = (Url::parse(url), Url::parse(issuer)) else {
        return false;
    };
    let web = |url: &Url| matches!(url.scheme(), "http" | "https");
    web(&url) && web(&issuer) && url.origin() == issuer.origin()
}

#[cfg(test)]
mod tests {
    use super::trusted_sign_in_page;

    const ISSUER: &str = "https://auth.moreweb.space/v1/auth";

    #[test]
    fn the_sign_in_page_on_the_issuer_is_the_one() {
        assert!(trusted_sign_in_page(
            "https://auth.moreweb.space/v1/auth/oauth/authorize?client_id=openremote",
            ISSUER
        ));
        // Hosts are compared case-folded, as the URL parser folds them.
        assert!(trusted_sign_in_page(
            "https://AUTH.moreweb.space/v1/auth/",
            ISSUER
        ));
    }

    #[test]
    fn another_service_does_not_borrow_the_sign_in_frame() {
        for url in [
            // A subdomain is another service.
            "https://evil.auth.moreweb.space/v1/auth/oauth/authorize",
            // A lookalike suffix is another service.
            "https://auth.moreweb.space.example/v1/auth/oauth/authorize",
            // The right host on the wrong scheme, or on another port.
            "http://auth.moreweb.space/v1/auth/oauth/authorize",
            "https://auth.moreweb.space:8443/v1/auth/oauth/authorize",
            // The account's API is not the authorization page.
            "https://api.moreweb.space/v1/openremote/cloud/signin",
            "not a url",
        ] {
            assert!(
                !trusted_sign_in_page(url, ISSUER),
                "{url} must not borrow the sign-in frame"
            );
        }
    }

    #[test]
    fn a_build_against_a_local_stand_in_signs_in_there() {
        // fake-cloud prints an http loopback issuer; the frame follows the
        // service the build was made against, not the release one.
        assert!(trusted_sign_in_page(
            "http://127.0.0.1:8787/v1/auth/oauth/authorize?state=x",
            "http://127.0.0.1:8787/v1/auth"
        ));
        assert!(!trusted_sign_in_page(
            "http://127.0.0.1:9999/v1/auth/oauth/authorize",
            "http://127.0.0.1:8787/v1/auth"
        ));
    }
}
