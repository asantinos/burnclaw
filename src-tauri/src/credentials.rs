use serde::Deserialize;
use std::fs;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CredentialsError {
    #[error("home directory not found")]
    NoHome,
    #[error("credentials file not found at {0}")]
    NotFound(String),
    #[error("token expired")]
    Expired,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json parse: {0}")]
    Parse(#[from] serde_json::Error),
}

#[derive(Deserialize)]
struct CredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    oauth: Oauth,
}

#[derive(Deserialize, Clone)]
pub struct Oauth {
    #[serde(rename = "accessToken")]
    pub access_token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
    #[serde(rename = "subscriptionType")]
    pub subscription_type: String,
}

pub fn load() -> Result<Oauth, CredentialsError> {
    let home = dirs::home_dir().ok_or(CredentialsError::NoHome)?;
    let path = home.join(".claude").join(".credentials.json");
    let content = fs::read_to_string(&path)
        .map_err(|_| CredentialsError::NotFound(path.display().to_string()))?;
    let parsed: CredentialsFile = serde_json::from_str(&content)?;

    let now_ms = chrono::Utc::now().timestamp_millis();
    if parsed.oauth.expires_at <= now_ms {
        return Err(CredentialsError::Expired);
    }

    Ok(parsed.oauth)
}
