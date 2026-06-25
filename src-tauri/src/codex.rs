//! Tracking de uso de OpenAI Codex (plan ChatGPT).
//!
//! Análogo a `anthropic.rs` + `credentials.rs` pero para Codex. Diferencias
//! clave con el lado Claude:
//!
//! - El token vive en `~/.codex/auth.json` (`tokens.access_token`), no en
//!   `.credentials.json`.
//! - El uso NO viene en headers de una llamada de inferencia: hay un endpoint
//!   dedicado de solo lectura, `GET https://chatgpt.com/backend-api/wham/usage`,
//!   que devuelve el % directamente en el body JSON. Ventaja: NO consume cuota
//!   (no hay inferencia), a diferencia de `anthropic::fetch_usage`.
//!
//! RIESGO (igual que el OAuth de Claude Code, ver CLAUDE.md §4): `wham/usage`
//! NO es API pública de OpenAI — es el endpoint interno que usan los clientes
//! de Codex y puede cambiar sin aviso.
//!
//! FASE 1: los nombres de campo internos de la respuesta no están documentados
//! públicamente, así que el parser es DEFENSIVO (alias serde + todo opcional) y
//! volcamos el JSON crudo por consola/log en cada fetch — el mismo patrón que
//! `anthropic.rs` usó para confirmar el formato de los headers. Una vez Alex
//! confirme los campos contra su cuenta real, se puede endurecer y quitar el
//! volcado.

use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use thiserror::Error;

const ENDPOINT: &str = "https://chatgpt.com/backend-api/wham/usage";

/// Duraciones de ventana confirmadas vía proyectos OSS (codex-widget): el
/// objeto de rate limit trae `limit_window_seconds` y así distinguimos cuál es
/// la ventana de 5h y cuál la semanal, sin depender del orden primary/secondary.
const WINDOW_5H_SECS: i64 = 18_000; // 5 * 3600
const WINDOW_WEEKLY_SECS: i64 = 604_800; // 7 * 24 * 3600

#[derive(Debug, Error)]
pub enum CodexError {
    #[error("home directory not found")]
    NoHome,
    #[error("codex auth file not found at {0}")]
    NotFound(String),
    #[error("json parse: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("auth failed (401), token may be expired — open Codex to refresh it")]
    Unauthorized,
    #[error("rate limited (429)")]
    RateLimited,
    #[error("bad response ({0}): {1}")]
    BadResponse(u16, String),
    #[error("usage response missing rate_limit data")]
    NoRateLimit,
}

// ---------------------------------------------------------------------------
// auth.json
// ---------------------------------------------------------------------------

/// Bloque `tokens` de `~/.codex/auth.json`. Defensivo: distintas versiones del
/// CLI han usado snake_case y otros nombres, así que aceptamos alias y todo es
/// opcional salvo lo que validamos a mano.
#[derive(Debug, Clone, Deserialize)]
pub struct CodexTokens {
    #[serde(alias = "accessToken")]
    pub access_token: Option<String>,
    // Base para el refresh OAuth de una fase posterior (aún no se usa).
    #[allow(dead_code)]
    #[serde(alias = "refreshToken")]
    pub refresh_token: Option<String>,
    #[serde(alias = "accountId", alias = "account_id")]
    pub account_id: Option<String>,
    #[serde(alias = "idToken", alias = "id_token")]
    pub id_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CodexAuth {
    pub tokens: Option<CodexTokens>,
    /// Si el usuario usa una API key (`sk-...`) en vez de login ChatGPT, no hay
    /// cuota de plan que medir. Lo detectamos para avisar.
    #[serde(rename = "OPENAI_API_KEY")]
    pub openai_api_key: Option<String>,
}

impl CodexAuth {
    pub fn access_token(&self) -> Option<&str> {
        self.tokens.as_ref()?.access_token.as_deref()
    }

    /// account_id para el header `chatgpt-account-id`. Primero el campo suelto;
    /// si falta, se intenta extraer del claim del `id_token` (JWT).
    pub fn account_id(&self) -> Option<String> {
        let tokens = self.tokens.as_ref()?;
        if let Some(id) = &tokens.account_id {
            return Some(id.clone());
        }
        let id_token = tokens.id_token.as_ref()?;
        account_id_from_jwt(id_token)
    }

    /// Email de la cuenta, extraído del claim del `id_token` (JWT).
    pub fn email(&self) -> Option<String> {
        let id_token = self.tokens.as_ref()?.id_token.as_ref()?;
        email_from_jwt(id_token)
    }
}

/// `~/.codex/auth.json`, respetando `$CODEX_HOME` si está definido.
fn path() -> Result<PathBuf, CodexError> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        if !codex_home.is_empty() {
            return Ok(PathBuf::from(codex_home).join("auth.json"));
        }
    }
    let home = dirs::home_dir().ok_or(CodexError::NoHome)?;
    Ok(home.join(".codex").join("auth.json"))
}

/// Lee y parsea `auth.json` sin validar caducidad (el campo de caducidad no es
/// fiable entre versiones; nos apoyamos en el 401 del endpoint).
pub fn load_raw() -> Result<CodexAuth, CodexError> {
    let path = path()?;
    let content = fs::read_to_string(&path)
        .map_err(|_| CodexError::NotFound(path.display().to_string()))?;
    let parsed: CodexAuth = serde_json::from_str(&content)?;
    Ok(parsed)
}

/// ¿Hay un auth.json de Codex con login ChatGPT (no solo API key)? Lo usa el
/// wiring para decidir si arrancar el poller de Codex y la auto-detección.
pub fn auth_exists() -> bool {
    matches!(load_raw(), Ok(auth) if auth.access_token().is_some())
}

/// Decodifica el payload (claims) de un JWT.
fn jwt_payload(jwt: &str) -> Option<serde_json::Value> {
    let payload_b64 = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Busca el `chatgpt_account_id` en el JWT. Puede estar suelto o anidado bajo
/// `https://api.openai.com/auth`.
fn account_id_from_jwt(jwt: &str) -> Option<String> {
    let claims = jwt_payload(jwt)?;
    if let Some(id) = claims.get("chatgpt_account_id").and_then(|v| v.as_str()) {
        return Some(id.to_string());
    }
    claims
        .get("https://api.openai.com/auth")
        .and_then(|auth| auth.get("chatgpt_account_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Busca el `email` en el JWT (suelto o bajo `https://api.openai.com/profile`).
fn email_from_jwt(jwt: &str) -> Option<String> {
    let claims = jwt_payload(jwt)?;
    if let Some(e) = claims.get("email").and_then(|v| v.as_str()) {
        return Some(e.to_string());
    }
    claims
        .get("https://api.openai.com/profile")
        .and_then(|p| p.get("email"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Snapshot expuesto al frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CodexUsageSnapshot {
    pub session_5h_pct: f64,
    pub session_5h_reset_at: Option<DateTime<Utc>>,
    pub weekly_pct: f64,
    pub weekly_reset_at: Option<DateTime<Utc>>,
    pub fetched_at: DateTime<Utc>,
    /// Tipo de plan ChatGPT ("plus", "pro", …), tal cual lo reporta el endpoint.
    pub plan_type: Option<String>,
}

// ---------------------------------------------------------------------------
// Respuesta de wham/usage (parseo defensivo)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct UsageResponse {
    rate_limit: Option<RateLimit>,
    /// Tipo de plan ("plus", "pro", …).
    plan_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RateLimit {
    primary_window: Option<RateWindow>,
    secondary_window: Option<RateWindow>,
}

/// Una ventana de rate limit. Campos confirmados contra la respuesta real de
/// `wham/usage` (plan Plus). Se mantienen opcionales (+ algún alias) por si el
/// endpoint —que es interno y sin contrato público— cambia.
#[derive(Debug, Deserialize)]
struct RateWindow {
    /// Porcentaje de uso, entero 0–100 (confirmado: ej. 12, 19).
    #[serde(alias = "usage_percent")]
    used_percent: Option<f64>,
    #[serde(alias = "window_seconds")]
    limit_window_seconds: Option<i64>,
    /// Unix segundos del próximo reset.
    #[serde(alias = "resets_at")]
    reset_at: Option<i64>,
    /// Segundos hasta el reset (fallback si falta `reset_at`).
    #[serde(alias = "resets_in_seconds")]
    reset_after_seconds: Option<i64>,
}

impl RateWindow {
    /// % de uso (0–100, tal cual lo da el endpoint).
    fn pct(&self) -> f64 {
        self.used_percent.unwrap_or(0.0)
    }

    fn reset_at(&self) -> Option<DateTime<Utc>> {
        if let Some(at) = self.reset_at {
            return DateTime::from_timestamp(at, 0);
        }
        if let Some(secs) = self.reset_after_seconds {
            return Some(Utc::now() + chrono::Duration::seconds(secs));
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/// Obtiene el uso actual de Codex. Relee `auth.json` en cada llamada (así
/// recoge las rotaciones que hace el propio CLI de Codex, igual que el lado
/// Claude). Sin refresh propio todavía: en un 401 devuelve `Unauthorized` para
/// que el usuario lo renueve abriendo Codex (`codex login`). El refresh OAuth
/// real queda para una fase posterior, una vez confirmados endpoint y client_id
/// (no inventamos valores OAuth — CLAUDE.md §4).
pub async fn fetch_usage() -> Result<CodexUsageSnapshot, CodexError> {
    let auth = load_raw()?;
    let token = auth
        .access_token()
        .ok_or(CodexError::Unauthorized)?
        .to_string();

    let client = reqwest::Client::new();
    let mut req = client
        .get(ENDPOINT)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json");
    if let Some(account_id) = auth.account_id() {
        req = req.header("chatgpt-account-id", account_id);
    }

    let res = req.send().await?;

    match res.status().as_u16() {
        200 => {}
        401 => return Err(CodexError::Unauthorized),
        429 => return Err(CodexError::RateLimited),
        other => {
            let text = res.text().await.unwrap_or_default();
            return Err(CodexError::BadResponse(other, text));
        }
    }

    let parsed: UsageResponse = res.json().await?;
    let rate = parsed.rate_limit.ok_or(CodexError::NoRateLimit)?;

    // Mapear ventanas a 5h / semanal por `limit_window_seconds`; si no viene,
    // caer al orden convencional primary=5h, secondary=semanal.
    let mut session: Option<&RateWindow> = None;
    let mut weekly: Option<&RateWindow> = None;
    for w in [rate.primary_window.as_ref(), rate.secondary_window.as_ref()]
        .into_iter()
        .flatten()
    {
        match w.limit_window_seconds {
            Some(s) if (s - WINDOW_5H_SECS).abs() <= 60 => session = Some(w),
            Some(s) if (s - WINDOW_WEEKLY_SECS).abs() <= 3600 => weekly = Some(w),
            _ => {}
        }
    }
    if session.is_none() && weekly.is_none() {
        session = rate.primary_window.as_ref();
        weekly = rate.secondary_window.as_ref();
    }

    Ok(CodexUsageSnapshot {
        session_5h_pct: session.map(RateWindow::pct).unwrap_or(0.0),
        session_5h_reset_at: session.and_then(RateWindow::reset_at),
        weekly_pct: weekly.map(RateWindow::pct).unwrap_or(0.0),
        weekly_reset_at: weekly.and_then(RateWindow::reset_at),
        fetched_at: Utc::now(),
        plan_type: parsed.plan_type,
    })
}
