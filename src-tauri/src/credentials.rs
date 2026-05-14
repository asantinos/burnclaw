use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use thiserror::Error;

/// Endpoint y client_id del flujo OAuth de Claude Code. El client_id es público
/// (va embebido en el CLI, idéntico para todas las instalaciones); confirmado
/// vía análisis del binario de Claude Code y proyectos OSS que integran este
/// flujo. NO inventar este valor: refrescar con un client_id distinto al que
/// emitió el token falla.
const OAUTH_TOKEN_ENDPOINT: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USER_AGENT: &str = "claude-cli/2.1.119 (external, cli)";

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
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
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
    /// Unix milliseconds.
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
    #[serde(rename = "subscriptionType")]
    pub subscription_type: String,
}

fn path() -> Result<PathBuf, CredentialsError> {
    let home = dirs::home_dir().ok_or(CredentialsError::NoHome)?;
    Ok(home.join(".claude").join(".credentials.json"))
}

/// Lee y parsea el archivo SIN comprobar caducidad. Lo usa el flujo de refresh,
/// que necesita el `refresh_token` aunque el `access_token` ya haya caducado.
pub fn load_raw() -> Result<Oauth, CredentialsError> {
    let path = path()?;
    let content = fs::read_to_string(&path)
        .map_err(|_| CredentialsError::NotFound(path.display().to_string()))?;
    let parsed: CredentialsFile = serde_json::from_str(&content)?;
    Ok(parsed.oauth)
}

/// Como `load_raw`, pero devuelve `Expired` si el `access_token` ya caducó.
pub fn load() -> Result<Oauth, CredentialsError> {
    let oauth = load_raw()?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    if oauth.expires_at <= now_ms {
        return Err(CredentialsError::Expired);
    }
    Ok(oauth)
}

#[derive(Serialize)]
struct RefreshRequest<'a> {
    grant_type: &'a str,
    refresh_token: &'a str,
    client_id: &'a str,
}

#[derive(Deserialize)]
struct RefreshResponse {
    access_token: String,
    /// No todos los servidores OAuth rotan el refresh_token; si falta, se
    /// conserva el anterior.
    refresh_token: Option<String>,
    /// Segundos hasta caducar.
    expires_in: i64,
}

/// Refresca el token OAuth contra el endpoint de Claude Code y persiste el
/// resultado en `.credentials.json`. El body va form-urlencoded — el endpoint
/// puede dar timeout con JSON.
pub async fn refresh_token(oauth: &Oauth) -> Result<Oauth, CredentialsError> {
    let body = RefreshRequest {
        grant_type: "refresh_token",
        refresh_token: &oauth.refresh_token,
        client_id: OAUTH_CLIENT_ID,
    };

    let resp: RefreshResponse = reqwest::Client::new()
        .post(OAUTH_TOKEN_ENDPOINT)
        .header("user-agent", USER_AGENT)
        .form(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let now_ms = chrono::Utc::now().timestamp_millis();
    let refreshed = Oauth {
        access_token: resp.access_token,
        refresh_token: resp
            .refresh_token
            .unwrap_or_else(|| oauth.refresh_token.clone()),
        expires_at: now_ms + resp.expires_in * 1000,
        subscription_type: oauth.subscription_type.clone(),
    };

    save_credentials(&refreshed)?;
    Ok(refreshed)
}

/// Sobrescribe `.credentials.json` con el token refrescado. Hace backup `.bak`
/// y MERGEA sobre el JSON existente: Claude Code guarda más campos en ese
/// archivo (p. ej. `mcpOAuth`) que no debemos perder, así que solo se tocan los
/// tres campos del bloque `claudeAiOauth`.
pub fn save_credentials(oauth: &Oauth) -> Result<(), CredentialsError> {
    let path = path()?;

    if path.exists() {
        let backup = path.with_extension("json.bak");
        fs::copy(&path, &backup)?;
    }

    let content = fs::read_to_string(&path)?;
    let mut json: serde_json::Value = serde_json::from_str(&content)?;

    let block = &mut json["claudeAiOauth"];
    block["accessToken"] = serde_json::json!(oauth.access_token);
    block["refreshToken"] = serde_json::json!(oauth.refresh_token);
    block["expiresAt"] = serde_json::json!(oauth.expires_at);

    fs::write(&path, serde_json::to_string_pretty(&json)?)?;
    Ok(())
}
