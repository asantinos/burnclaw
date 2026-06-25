use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::logging;
use crate::SharedSettings;

/// Evento entrante. Acepta tanto el formato nativo de los hooks de Claude Code
/// (`hook_event_name`, `tool_input`, `prompt`) como el formato simplificado de
/// los tests manuales (`event_type`, `tool_target`, `message`).
#[derive(Debug, Clone, Deserialize)]
pub struct HookEvent {
    #[serde(alias = "hook_event_name")]
    pub event_type: String,
    pub cwd: Option<String>,
    pub tool_name: Option<String>,
    pub tool_target: Option<String>,
    pub tool_input: Option<Value>,
    pub message: Option<String>,
    pub prompt: Option<String>,
    pub session_id: Option<String>,
    /// "claude" (por defecto) o "codex" (lo envía el forwarder del notify).
    pub provider: Option<String>,
}

/// Evento normalizado que se emite al frontend (ambas ventanas).
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeEvent {
    pub event_type: String,
    pub cwd: Option<String>,
    pub tool_name: Option<String>,
    pub tool_target: Option<String>,
    pub message: Option<String>,
    pub session_id: Option<String>,
    pub provider: Option<String>,
}

#[derive(Clone)]
pub struct HookState {
    pub app: AppHandle,
}

fn normalize(raw: HookEvent) -> ClaudeEvent {
    // tool_target: explícito si viene; si no, se extrae de tool_input según la
    // tool (file_path para Edit/Write/Read, command para Bash, etc.).
    let tool_target = raw.tool_target.or_else(|| {
        raw.tool_input.as_ref().and_then(|ti| {
            ["file_path", "command", "path", "pattern", "url", "notebook_path"]
                .iter()
                .find_map(|key| ti.get(*key).and_then(|v| v.as_str()))
                .map(|s| s.to_string())
        })
    });
    // message: el campo message si viene; si no, el prompt (UserPromptSubmit).
    let message = raw.message.or(raw.prompt);

    ClaudeEvent {
        event_type: raw.event_type,
        cwd: raw.cwd,
        tool_name: raw.tool_name,
        tool_target,
        message,
        session_id: raw.session_id,
        provider: raw.provider,
    }
}

async fn handle_event(
    State(state): State<HookState>,
    Json(raw): Json<HookEvent>,
) -> Json<Value> {
    let event = normalize(raw);

    // Log del evento a hooks.log.
    logging::hook(&format!(
        "{}{}{}",
        event.event_type,
        event
            .tool_name
            .as_deref()
            .map(|t| format!(" · {}", t))
            .unwrap_or_default(),
        event
            .tool_target
            .as_deref()
            .map(|t| format!(" — {}", t))
            .unwrap_or_default(),
    ));

    // Emite a AMBAS ventanas (emit global).
    let _ = state.app.emit("claude-event", &event);

    // Notificaciones nativas solo en eventos relevantes (y si el toggle está on).
    trigger_notification(&state, &event);

    Json(json!({ "ok": true }))
}

fn trigger_notification(state: &HookState, event: &ClaudeEvent) {
    use notify_rust::Notification;

    let cfg = match state.app.try_state::<SharedSettings>() {
        Some(s) => s.lock().unwrap().clone(),
        None => return,
    };

    let name = match event.provider.as_deref() {
        Some("codex") => "Codex",
        _ => "Claude",
    };

    match event.event_type.as_str() {
        "Notification" if cfg.notify_claude_needs_you => {
            Notification::new()
                .summary(&format!("{} needs you", name))
                .body(
                    event
                        .message
                        .as_deref()
                        .unwrap_or("Waiting for your input"),
                )
                .app_id(crate::notifications::AUMID)
                .show()
                .ok();
        }
        "Stop" if cfg.notify_claude_finished => {
            let project = event
                .cwd
                .as_deref()
                .and_then(|p| p.rsplit(['/', '\\']).next())
                .filter(|s| !s.is_empty())
                .unwrap_or("session");
            Notification::new()
                .summary(&format!("{} finished", name))
                .body(&format!("Response complete · {}", project))
                .app_id(crate::notifications::AUMID)
                .show()
                .ok();
        }
        _ => {}
    }
}

pub async fn start_server(state: HookState) {
    let router = Router::new()
        .route("/event", post(handle_event))
        .with_state(state);

    // CRÍTICO: bind a 127.0.0.1, nunca 0.0.0.0. Solo localhost.
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:9876").await {
        Ok(l) => l,
        Err(e) => {
            logging::app(&format!("hook server failed to bind 127.0.0.1:9876: {}", e));
            return;
        }
    };

    logging::app("hook server listening on http://127.0.0.1:9876");
    if let Err(e) = axum::serve(listener, router).await {
        logging::app(&format!("hook server stopped: {}", e));
    }
}
