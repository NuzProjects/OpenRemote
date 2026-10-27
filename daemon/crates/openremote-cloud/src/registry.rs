//! The registry client: the contract moreweb serves under `/v1/openremote`
//! (and the test double serves the same). A 401 means sign in again and is
//! never a reason to delete anything; only a 410, this device was removed,
//! is.

use serde_json::{Value, json};

use crate::https::{Http, HttpError, Response};
use crate::identity::Account;

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error(transparent)]
    Http(#[from] HttpError),
    #[error("sign in to OpenRemote Cloud again")]
    Unauthorized,
    #[error("this device was removed from your account")]
    Revoked,
    #[error("{message}")]
    Refused {
        status: u16,
        code: String,
        message: String,
    },
}

pub struct Registered {
    pub device: Value,
    pub credential: String,
    pub account: Account,
}

#[derive(Clone)]
pub struct Registry {
    http: Http,
    base: String,
}

/// What to say when the registry answers with a code and no sentence of its
/// own. `invalid_code` is the one a person meets first - a typo, a code that
/// expired, or one another device already spent - and a wire word is not a
/// sentence. Anything else keeps the generic refusal plus the status, so an
/// unknown failure is still identified by the number.
fn refusal_sentence(status: u16, code: &str) -> String {
    match code {
        "invalid_code" => "That code is not valid. Codes are single use and expire after five minutes; mint a new one from the machine list.".to_string(),
        other => format!("OpenRemote Cloud refused the request ({other}, HTTP {status})"),
    }
}

fn check(response: Response) -> Result<Value, RegistryError> {
    let body = response.json();
    match response.status {
        200..=299 => Ok(body),
        401 => Err(RegistryError::Unauthorized),
        410 => Err(RegistryError::Revoked),
        status => {
            let code = body["error"].as_str().unwrap_or("refused").to_string();
            // The registry's own words when it sent some that say more than the
            // code does: the test double repeats the code in both fields, and a
            // real answer may carry only a token.
            let message = match body["message"].as_str().map(str::trim) {
                Some(words) if !words.is_empty() && words != code => words.to_string(),
                _ => refusal_sentence(status, &code),
            };
            Err(RegistryError::Refused {
                status,
                code,
                message,
            })
        }
    }
}

fn registered(body: Value) -> Result<Registered, RegistryError> {
    let refused = || RegistryError::Refused {
        status: 502,
        code: "bad_answer".into(),
        message: "OpenRemote Cloud answered without a device credential".into(),
    };
    let credential = body["credential"].as_str().ok_or_else(refused)?.to_string();
    let account: Account =
        serde_json::from_value(body["account"].clone()).map_err(|_| refused())?;
    Ok(Registered {
        device: body["device"].clone(),
        credential,
        account,
    })
}

/// What a device says about itself when it joins.
pub struct DeviceInfo<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub platform: &'a str,
    pub noise_pubkey: &'a str,
    pub app_version: &'a str,
}

impl Registry {
    pub fn new(http: Http, base: &str) -> Self {
        Self {
            http,
            base: base.trim_end_matches('/').to_string(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// A desktop joins (or re-joins, same id and key) with an account token.
    pub async fn register(
        &self,
        account_token: &str,
        device: &DeviceInfo<'_>,
    ) -> Result<Registered, RegistryError> {
        let body = json!({
            "id": device.id,
            "name": device.name,
            "platform": device.platform,
            "noise_pubkey": device.noise_pubkey,
            "app_version": device.app_version,
        });
        let response = self
            .http
            .json(
                "POST",
                &self.url("/devices"),
                Some(account_token),
                Some(&body),
            )
            .await?;
        registered(check(response)?)
    }

    /// A machine joins by spending an install code.
    pub async fn redeem(
        &self,
        code: &str,
        device: &DeviceInfo<'_>,
    ) -> Result<Registered, RegistryError> {
        let body = json!({
            "code": code,
            "device": {
                "id": device.id,
                "name": device.name,
                "platform": device.platform,
                "noise_pubkey": device.noise_pubkey,
                "app_version": device.app_version,
            },
        });
        let response = self
            .http
            .json("POST", &self.url("/enrollments/redeem"), None, Some(&body))
            .await?;
        registered(check(response)?)
    }

    /// The account's devices, with who is online and the preferences.
    pub async fn devices(&self, bearer: &str) -> Result<Value, RegistryError> {
        let response = self
            .http
            .json("GET", &self.url("/devices"), Some(bearer), None)
            .await?;
        check(response)
    }

    pub async fn patch(
        &self,
        bearer: &str,
        id: &str,
        body: &Value,
    ) -> Result<Value, RegistryError> {
        let response = self
            .http
            .json(
                "PATCH",
                &self.url(&format!("/devices/{id}")),
                Some(bearer),
                Some(body),
            )
            .await?;
        check(response)
    }

    pub async fn delete(&self, bearer: &str, id: &str) -> Result<(), RegistryError> {
        let response = self
            .http
            .json(
                "DELETE",
                &self.url(&format!("/devices/{id}")),
                Some(bearer),
                None,
            )
            .await?;
        check(response).map(|_| ())
    }

    pub async fn create_enrollment(
        &self,
        account_token: &str,
        body: &Value,
    ) -> Result<Value, RegistryError> {
        let response = self
            .http
            .json(
                "POST",
                &self.url("/enrollments"),
                Some(account_token),
                Some(body),
            )
            .await?;
        check(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(status: u16, body: &str) -> RegistryError {
        check(Response {
            status,
            headers: http::HeaderMap::new(),
            body: body.as_bytes().to_vec(),
        })
        .unwrap_err()
    }

    #[test]
    fn a_code_the_registry_only_names_is_said_in_words_a_person_can_act_on() {
        // The first failure on a new server: the fake (and the real contract)
        // answers 400 invalid_code with the code repeated as the message.
        let err = refused(400, r#"{"error":"invalid_code","message":"invalid_code"}"#);
        let why = err.to_string();
        assert!(why.contains("not valid"), "{why}");
        assert!(why.contains("five minutes"), "{why}");
        assert!(why.contains("mint a new one"), "{why}");
        assert!(
            !why.contains("invalid_code"),
            "the wire word is not the sentence: {why}"
        );

        // No message at all is the same sentence, not the old generic one.
        let err = refused(400, r#"{"error":"invalid_code"}"#);
        assert!(err.to_string().contains("not valid"), "{err}");
    }

    #[test]
    fn the_registrys_own_words_are_kept_when_it_sends_some() {
        let err = refused(
            403,
            r#"{"error":"seat_limit","message":"This account already has three machines."}"#,
        );
        assert_eq!(err.to_string(), "This account already has three machines.");
    }

    #[test]
    fn an_unknown_refusal_keeps_the_generic_sentence_and_its_status() {
        let err = refused(500, r#"{"error":"boom","message":"boom"}"#);
        let why = err.to_string();
        assert!(why.contains("refused the request"), "{why}");
        assert!(why.contains("boom"), "{why}");
        assert!(why.contains("HTTP 500"), "{why}");
        // A body that is not JSON at all still names the status.
        let err = refused(502, "<html>Bad Gateway</html>");
        assert!(err.to_string().contains("HTTP 502"), "{err}");
    }
}
