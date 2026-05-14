use chrono::{DateTime, Utc};
use serde::Serialize;
use thiserror::Error;

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const MODEL: &str = "claude-haiku-4-5-20251001";
const USER_AGENT: &str = "claude-cli/2.1.119 (external, cli)";
const ANTHROPIC_BETA: &str = "claude-code-20250219,oauth-2025-04-20";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const SYSTEM_PROMPT: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

#[derive(Debug, Clone, Serialize)]
pub struct UsageSnapshot {
    pub session_5h_pct: f64,
    pub session_5h_reset_at: DateTime<Utc>,
    pub weekly_pct: f64,
    pub weekly_reset_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
    pub unified_status: String,
    pub session_5h_status: String,
    pub weekly_7d_status: String,
    pub representative_claim: String,
    pub overage_status: String,
    pub overage_disabled_reason: Option<String>,
}

#[derive(Debug, Error)]
pub enum AnthropicError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("auth failed (401), token may be expired")]
    Unauthorized,
    #[error("bad request (400): {0}")]
    BadRequest(String),
    #[error("rate limited (429)")]
    RateLimited,
    #[error("missing header: {0}")]
    MissingHeader(&'static str),
    #[error("invalid header value: {0}")]
    InvalidHeaderValue(String),
}

#[derive(Serialize)]
struct RequestBody {
    model: &'static str,
    max_tokens: u32,
    system: Vec<SystemBlock>,
    messages: Vec<Msg>,
}

#[derive(Serialize)]
struct SystemBlock {
    #[serde(rename = "type")]
    block_type: &'static str,
    text: &'static str,
}

#[derive(Serialize)]
struct Msg {
    role: &'static str,
    content: &'static str,
}

pub async fn fetch_usage(access_token: &str) -> Result<UsageSnapshot, AnthropicError> {
    let client = reqwest::Client::new();
    let body = RequestBody {
        model: MODEL,
        max_tokens: 1,
        system: vec![SystemBlock {
            block_type: "text",
            text: SYSTEM_PROMPT,
        }],
        messages: vec![Msg {
            role: "user",
            content: "hi",
        }],
    };

    let res = client
        .post(ENDPOINT)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", ANTHROPIC_BETA)
        .header("user-agent", USER_AGENT)
        .header("x-app", "cli")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    match res.status().as_u16() {
        200 => {}
        401 => return Err(AnthropicError::Unauthorized),
        400 => {
            let text = res.text().await?;
            return Err(AnthropicError::BadRequest(text));
        }
        429 => return Err(AnthropicError::RateLimited),
        other => {
            let text = res.text().await.unwrap_or_default();
            return Err(AnthropicError::BadRequest(format!("{}: {}", other, text)));
        }
    }

    let headers = res.headers().clone();

    println!("--- RAW HEADERS ---");
    for (name, value) in headers.iter() {
        if name.as_str().starts_with("anthropic-") {
            println!("  {}: {:?}", name, value);
        }
    }
    println!("--- END HEADERS ---");

    // Helper para extraer headers
    let get = |name: &'static str| -> Result<String, AnthropicError> {
        headers
            .get(name)
            .ok_or(AnthropicError::MissingHeader(name))?
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| AnthropicError::InvalidHeaderValue(e.to_string()))
    };

    let session_pct_raw = get("anthropic-ratelimit-unified-5h-utilization")?;
    let session_reset_raw = get("anthropic-ratelimit-unified-5h-reset")?;
    let weekly_pct_raw = get("anthropic-ratelimit-unified-7d-utilization")?;
    let weekly_reset_raw = get("anthropic-ratelimit-unified-7d-reset")?;

    let get_opt = |name: &str| -> Option<String> {
        headers.get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
    };

    let unified_status = get_opt("anthropic-ratelimit-unified-status").unwrap_or_default();
    let session_5h_status = get_opt("anthropic-ratelimit-unified-5h-status").unwrap_or_default();
    let weekly_7d_status = get_opt("anthropic-ratelimit-unified-7d-status").unwrap_or_default();
    let representative_claim = get_opt("anthropic-ratelimit-unified-representative-claim").unwrap_or_default();
    let overage_status = get_opt("anthropic-ratelimit-unified-overage-status").unwrap_or_default();
    let overage_disabled_reason = get_opt("anthropic-ratelimit-unified-overage-disabled-reason");

    // Consumir body para liberar conexión
    let _ = res.bytes().await?;

    // IMPORTANTE: en Fase 1 imprimir estos raw values y confirmar formato.
    // Ajustar parsers tras ver primer response real.
    let session_5h_pct = parse_utilization(&session_pct_raw)?;
    let weekly_pct = parse_utilization(&weekly_pct_raw)?;
    let session_5h_reset_at = parse_reset_timestamp(&session_reset_raw)?;
    let weekly_reset_at = parse_reset_timestamp(&weekly_reset_raw)?;

    Ok(UsageSnapshot {
        session_5h_pct,
        session_5h_reset_at,
        weekly_pct,
        weekly_reset_at,
        fetched_at: Utc::now(),
        unified_status,
        session_5h_status,
        weekly_7d_status,
        representative_claim,
        overage_status,
        overage_disabled_reason,
    })
}

fn parse_utilization(raw: &str) -> Result<f64, AnthropicError> {
    // Confirmado vía issue Hermes: viene como float 0.0–1.0 (ej. "0.03")
    let v: f64 = raw.parse()
        .map_err(|_| AnthropicError::InvalidHeaderValue(raw.to_string()))?;
    Ok(v * 100.0)
}

fn parse_reset_timestamp(raw: &str) -> Result<DateTime<Utc>, AnthropicError> {
    // Probar Unix timestamp primero (segundos)
    if let Ok(unix) = raw.parse::<i64>() {
        if let Some(dt) = DateTime::from_timestamp(unix, 0) {
            return Ok(dt);
        }
    }
    // Probar ISO 8601
    DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|_| AnthropicError::InvalidHeaderValue(raw.to_string()))
}
