use crate::{
    data::Agent,
    error::{AppError, Result},
    parse::string,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};

const SERVICE: &str = "com.joeychilson.overwatch.accounts";
pub struct Credential {
    pub token: String,
    pub account_id: Option<String>,
    pub identity: String,
    pub plan: Option<String>,
}
pub fn fingerprint(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn invalid(message: &str) -> AppError {
    AppError::Credentials(message.into())
}

pub fn validate(token: &str, account: Option<&str>, plan: Option<&str>) -> Result<Credential> {
    let token = token.trim();
    if token.is_empty() || token.len() > 32_768 || token.bytes().any(|b| b <= 32 || b >= 127) {
        return Err(invalid(
            "Enter a valid access token without spaces or control characters.",
        ));
    }
    let claims = token
        .split('.')
        .nth(1)
        .and_then(|part| URL_SAFE_NO_PAD.decode(part).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    if claims["exp"]
        .as_i64()
        .is_some_and(|expires| expires <= chrono::Utc::now().timestamp())
    {
        return Err(AppError::Unauthorized(
            "The access token has expired. Sign in to the provider again.".into(),
        ));
    }
    let account = account.or(claims["https://api.openai.com/auth"]["chatgpt_account_id"].as_str());
    let identity = account.or(claims["sub"].as_str()).unwrap_or(token);
    Ok(Credential {
        token: token.into(),
        account_id: account.map(str::to_owned),
        identity: fingerprint(identity),
        plan: plan.map(str::to_owned),
    })
}
pub fn save(agent: Agent, token: Option<&str>) -> Result<()> {
    if agent == Agent::Pi {
        return Err(AppError::Unsupported(
            "Pi has no subscription usage endpoint.".into(),
        ));
    }
    let entry = keyring::Entry::new(SERVICE, agent.id())
        .map_err(|_| invalid("The OS credential store is unavailable."))?;
    if let Some(token) = token {
        let credential = validate(token, None, None)?;
        entry
            .set_password(&credential.token)
            .map_err(|_| invalid("Could not save the access token in the OS credential store."))
    } else {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(invalid("Could not remove the saved credential.")),
        }
    }
}
#[cfg(target_os = "macos")]
fn native_secret(
    service: &str,
    account: Option<&str>,
    interactive: bool,
) -> Result<Option<Vec<u8>>> {
    use security_framework::item::{ItemClass, ItemSearchOptions, SearchResult};
    let mut query = ItemSearchOptions::new();
    query
        .class(ItemClass::generic_password())
        .service(service)
        .load_data(true)
        .skip_authenticated_items(!interactive);
    if let Some(account) = account {
        query.account(account);
    }
    match query.search() {
        Ok(items) => Ok(items.into_iter().find_map(|item| match item {
            SearchResult::Data(bytes) => Some(bytes),
            _ => None,
        })),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err(invalid(
            "Keychain access was denied. Refresh manually to grant access.",
        )),
    }
}
#[cfg(not(target_os = "macos"))]
fn native_secret(service: &str, account: Option<&str>, _: bool) -> Result<Option<Vec<u8>>> {
    if service != SERVICE {
        return Ok(None);
    }
    let entry = keyring::Entry::new(service, account.unwrap_or_default())
        .map_err(|_| invalid("The OS credential store is unavailable."))?;
    match entry.get_secret() {
        Ok(bytes) => Ok(Some(bytes)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(invalid("Could not read the saved credential.")),
    }
}
pub fn load(agent: Agent, root: &Path, interactive: bool) -> Result<Credential> {
    if let Some(bytes) = native_secret(SERVICE, Some(agent.id()), interactive)? {
        return validate(
            std::str::from_utf8(&bytes).map_err(|_| invalid("The saved token is invalid."))?,
            None,
            None,
        );
    }
    let variable = match agent {
        Agent::Codex => "OVERWATCH_CODEX_TOKEN",
        Agent::Claude => "CLAUDE_CODE_OAUTH_TOKEN",
        Agent::Opencode => "OPENCODE_API_KEY",
        Agent::Grok => "GROK_OAUTH_TOKEN",
        Agent::Antigravity => "ANTIGRAVITY_ACCESS_TOKEN",
        Agent::Pi => {
            return Err(AppError::Unsupported(
                "Pi has no subscription usage endpoint.".into(),
            ));
        }
    };
    if let Ok(token) = std::env::var(variable) {
        return validate(&token, None, None);
    }
    if agent != Agent::Antigravity {
        let path = root.join(if agent == Agent::Claude {
            ".credentials.json"
        } else {
            "auth.json"
        });
        match std::fs::File::open(path) {
            Ok(file) => {
                let mut bytes = vec![];
                file.take(1_048_577)
                    .read_to_end(&mut bytes)
                    .map_err(|_| invalid("Cannot read the provider sign-in file."))?;
                if bytes.len() > 1_048_576 {
                    return Err(invalid("The provider sign-in file exceeds the size limit."));
                }
                return parse(
                    agent,
                    &serde_json::from_slice::<Value>(&bytes)
                        .map_err(|_| invalid("The provider sign-in file contains invalid JSON."))?,
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(invalid(
                    "Cannot read the provider sign-in file. Check folder permissions.",
                ));
            }
        }
    }
    let service = match agent {
        Agent::Codex => Some("Codex Auth"),
        Agent::Claude if dirs::home_dir().is_some_and(|home| root == home.join(".claude")) => {
            Some("Claude Code-credentials")
        }
        _ => None,
    };
    if let Some(service) = service {
        let canonical = root.canonicalize()?;
        let account = format!("cli|{}", &fingerprint(&canonical.to_string_lossy())[..16]);
        if let Some(bytes) = native_secret(
            service,
            (agent == Agent::Codex).then_some(account.as_str()),
            interactive,
        )? {
            return parse(
                agent,
                &serde_json::from_slice::<Value>(&bytes)
                    .map_err(|_| invalid("The provider Keychain entry is invalid."))?,
            );
        }
    }
    Err(invalid(
        "No sign-in found. Sign in to the provider or connect an access token.",
    ))
}
pub fn parse(agent: Agent, value: &Value) -> Result<Credential> {
    match agent {
        Agent::Codex => validate(
            string(&value["tokens"]["access_token"]),
            value["tokens"]["account_id"].as_str(),
            None,
        ),
        Agent::Claude => {
            let oauth = &value["claudeAiOauth"];
            if oauth["scopes"]
                .as_array()
                .is_some_and(|scopes| !scopes.iter().any(|scope| scope == "user:profile"))
            {
                return Err(invalid(
                    "This Claude sign-in needs the user:profile scope to read usage.",
                ));
            }
            if oauth["expiresAt"]
                .as_i64()
                .is_some_and(|n| n <= chrono::Utc::now().timestamp_millis())
            {
                return Err(AppError::Unauthorized(
                    "Claude sign-in expired. Sign in again.".into(),
                ));
            }
            validate(
                string(&oauth["accessToken"]),
                None,
                oauth["subscriptionType"].as_str(),
            )
        }
        Agent::Opencode => validate(
            string(&value["opencode-go"]["key"]),
            None,
            Some("OpenCode Go"),
        ),
        Agent::Grok => {
            let entry = if value["access_token"].is_string() || value["key"].is_string() {
                value
            } else {
                let mut entries = value
                    .as_object()
                    .into_iter()
                    .flat_map(|o| o.values())
                    .filter(|v| v["key"].is_string());
                let entry = entries
                    .next()
                    .ok_or_else(|| invalid("No Grok sign-in found."))?;
                if entries.next().is_some() {
                    return Err(invalid(
                        "Multiple Grok accounts found. Connect the intended account with its access token.",
                    ));
                }
                entry
            };
            if entry["principal_type"] == "team" {
                return Err(AppError::Unsupported(
                    "Grok team quota is unavailable through this endpoint.".into(),
                ));
            }
            validate(
                entry["access_token"]
                    .as_str()
                    .unwrap_or(string(&entry["key"])),
                entry["user_id"].as_str(),
                None,
            )
        }
        _ => Err(invalid("Connect this provider with an access token.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_reject_expiration_controls_and_ambiguous_accounts() {
        let claims = URL_SAFE_NO_PAD.encode(br#"{"exp":1,"sub":"fixture"}"#);
        assert!(matches!(
            validate(&format!("header.{claims}.signature"), None, None),
            Err(AppError::Unauthorized(_))
        ));
        assert!(validate("bad\r\nheader", None, None).is_err());
        assert!(
            parse(
                Agent::Grok,
                &json!({"one":{"key":"first"},"two":{"key":"second"}})
            )
            .is_err()
        );
        assert!(
            parse(
                Agent::Claude,
                &json!({"claudeAiOauth":{"accessToken":"fixture","scopes":["chat:write"]}})
            )
            .is_err()
        );
    }

    #[test]
    fn identity_survives_access_token_rotation_without_exposing_account_id() -> Result<()> {
        let first = parse(
            Agent::Codex,
            &json!({"tokens":{"access_token":"first-token","account_id":"account-123"}}),
        )?;
        let next = parse(
            Agent::Codex,
            &json!({"tokens":{"access_token":"second-token","account_id":"account-123"}}),
        )?;
        assert_eq!(first.identity, next.identity);
        assert!(!first.identity.contains("account-123"));
        assert_ne!(first.identity, next.token);
        Ok(())
    }
}
