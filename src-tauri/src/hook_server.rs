use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_requests::{self, AgentResponse, SharedAgentRequests};
use crate::logging;
use crate::sessions::{self, AgentSessionEvent, SharedSessions};
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
    pub permission_suggestions: Option<Value>,
    pub message: Option<String>,
    pub prompt: Option<String>,
    #[serde(alias = "last-assistant-message")]
    pub last_assistant_message: Option<String>,
    pub session_id: Option<String>,
    #[serde(alias = "thread-id")]
    pub thread_id: Option<String>,
    /// "claude" (por defecto) o "codex" (lo envía el forwarder del notify).
    pub provider: Option<String>,
    /// PID of the long-lived Claude/Codex process, added by BurnClaw's bridge.
    pub owner_pid: Option<u32>,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub tool_use_id: Option<String>,
    pub turn_id: Option<String>,
    pub source: Option<String>,
    pub reason: Option<String>,
    pub notification_type: Option<String>,
    pub tool_response: Option<Value>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub error: Option<String>,
}

/// Evento normalizado que se emite al frontend (ambas ventanas).
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeEvent {
    pub event_type: String,
    pub cwd: Option<String>,
    pub tool_name: Option<String>,
    pub tool_target: Option<String>,
    pub tool_input: Option<Value>,
    pub permission_suggestions: Option<Value>,
    pub message: Option<String>,
    pub session_id: Option<String>,
    pub provider: Option<String>,
    pub owner_pid: Option<u32>,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub tool_use_id: Option<String>,
    pub turn_id: Option<String>,
    pub source: Option<String>,
    pub reason: Option<String>,
    pub notification_type: Option<String>,
    pub tool_response: Option<Value>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct HookState {
    pub app: AppHandle,
    pub sessions: SharedSessions,
    pub requests: SharedAgentRequests,
}

fn normalize(raw: HookEvent) -> ClaudeEvent {
    // tool_target: explícito si viene; si no, se extrae de tool_input según la
    // tool (file_path para Edit/Write/Read, command para Bash, etc.).
    let tool_target = raw.tool_target.or_else(|| {
        raw.tool_input.as_ref().and_then(|ti| {
            [
                "file_path",
                "command",
                "path",
                "pattern",
                "url",
                "notebook_path",
            ]
            .iter()
            .find_map(|key| ti.get(*key).and_then(|v| v.as_str()))
            .map(|s| s.to_string())
        })
    });
    // message: el campo message si viene; si no, el prompt (UserPromptSubmit).
    let message = raw.message.or(raw.prompt).or(raw.last_assistant_message);
    let session_id = raw.session_id.or(raw.thread_id);

    ClaudeEvent {
        event_type: raw.event_type,
        cwd: raw.cwd,
        tool_name: raw.tool_name,
        tool_target,
        tool_input: raw.tool_input,
        permission_suggestions: raw.permission_suggestions,
        message,
        session_id,
        provider: raw.provider,
        owner_pid: raw.owner_pid,
        agent_id: raw.agent_id,
        agent_type: raw.agent_type,
        tool_use_id: raw.tool_use_id,
        turn_id: raw.turn_id,
        source: raw.source,
        reason: raw.reason,
        notification_type: raw.notification_type,
        tool_response: raw.tool_response,
        model: raw.model,
        permission_mode: raw.permission_mode,
        error: raw.error,
    }
}

fn remove_session(state: &HookState, session_id: &str, reason: &str) {
    let removed = sessions::dismiss(&state.sessions, session_id);
    for request_id in agent_requests::expire_session(&state.requests, session_id) {
        let _ = state
            .app
            .emit("agent-request-resolved", json!({ "id": request_id }));
    }
    if removed {
        let _ = state.app.emit(
            "agent-session-removed",
            json!({ "id": session_id, "reason": reason }),
        );
    }
}

fn notification_needs_attention(event: &ClaudeEvent) -> bool {
    if event.event_type != "Notification" {
        return false;
    }
    match event.notification_type.as_deref() {
        Some("auth_success") => false,
        Some("permission_prompt" | "idle_prompt" | "elicitation_dialog") | None => true,
        Some(_) => false,
    }
}

async fn handle_event(State(state): State<HookState>, Json(raw): Json<HookEvent>) -> Json<Value> {
    let event = normalize(raw);
    let provider = event.provider.as_deref().unwrap_or("claude").to_string();
    let session_id = event.session_id.clone().unwrap_or_else(|| {
        let project = event.cwd.as_deref().unwrap_or("global");
        format!("{}:{}", provider, project)
    });

    if event.event_type == "SessionEnd" {
        logging::hook(&format!("{} · {}", event.event_type, provider));
        remove_session(
            &state,
            &session_id,
            event.reason.as_deref().unwrap_or("session_end"),
        );
        return Json(json!({}));
    }

    // Claude's AskUserQuestion can be answered by rewriting the tool input.
    // Codex request_user_input uses a separate response channel, so an
    // externally-started Codex CLI must keep handling that prompt natively.
    let is_question = provider == "claude"
        && event.event_type == "PreToolUse"
        && event.tool_name.as_deref() == Some("AskUserQuestion");
    let is_codex_question = provider == "codex"
        && event.event_type == "PreToolUse"
        && event.tool_name.as_deref() == Some("request_user_input");
    let is_permission = event.event_type == "PermissionRequest";
    let pending = if is_question || is_permission {
        let kind = if is_question {
            "question"
        } else {
            "permission"
        };
        Some(agent_requests::register(
            &state.requests,
            session_id.clone(),
            provider.clone(),
            kind.into(),
            event.tool_name.clone().unwrap_or_else(|| "Tool".into()),
            event.tool_input.clone().unwrap_or_else(|| json!({})),
            event.permission_suggestions.clone(),
        ))
    } else {
        None
    };

    let session_event_type = if is_question {
        "AskUserQuestion".to_string()
    } else if is_codex_question {
        "CodexQuestion".to_string()
    } else if event.event_type == "Notification" && !notification_needs_attention(&event) {
        "NotificationInfo".to_string()
    } else {
        event.event_type.clone()
    };
    let session = sessions::apply_event(
        &state.sessions,
        AgentSessionEvent {
            id: session_id,
            provider: provider.clone(),
            cwd: event.cwd.clone(),
            event_type: session_event_type,
            tool_name: event.tool_name.clone(),
            tool_target: event.tool_target.clone(),
            tool_input: event.tool_input.clone(),
            message: event.message.clone(),
            owner_pid: event.owner_pid,
            agent_id: event.agent_id.clone(),
        },
    );

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
    let _ = state.app.emit("agent-session-updated", &session);
    if let Some((info, _)) = pending.as_ref() {
        let _ = state.app.emit("agent-request-pending", info);
    }

    // Notificaciones nativas solo en eventos relevantes (y si el toggle está on).
    trigger_notification(&state, &event);

    let Some((info, receiver)) = pending else {
        return Json(json!({ "ok": true }));
    };

    let response = tokio::time::timeout(std::time::Duration::from_secs(300), receiver).await;
    match response {
        Ok(Ok(agent_response)) => Json(response_json(
            &provider,
            &info.kind,
            &info.tool_input,
            agent_response,
        )),
        _ => {
            agent_requests::expire(&state.requests, &info.id);
            let _ = state
                .app
                .emit("agent-request-resolved", json!({ "id": info.id }));
            if let Some(session) = sessions::resume(&state.sessions, &info.session_id) {
                let _ = state.app.emit("agent-session-updated", session);
            }
            Json(json!({}))
        }
    }
}

async fn handle_codex_event(
    State(state): State<HookState>,
    Json(mut raw): Json<HookEvent>,
) -> Json<Value> {
    raw.provider = Some("codex".to_string());
    handle_event(State(state), Json(raw)).await
}

fn response_json(
    provider: &str,
    kind: &str,
    original_input: &Value,
    response: AgentResponse,
) -> Value {
    if kind == "question" {
        if response.action == "deny" {
            return json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "User dismissed the question in BurnClaw"
                }
            });
        }
        let mut updated_input = original_input.clone();
        if let (Some(object), Some(answers)) = (updated_input.as_object_mut(), response.answers) {
            object.insert("answers".into(), json!(answers));
        }
        return json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": updated_input
            }
        });
    }

    if response.action == "deny" {
        return json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "deny",
                    "message": "User denied the request in BurnClaw"
                }
            }
        });
    }

    let mut decision = json!({ "behavior": "allow" });
    // Codex PermissionRequest only supports allow/deny today. In particular,
    // updatedPermissions is reserved and fails closed, so session-wide grants
    // remain exclusive to Claude Code.
    if provider != "codex" && response.action == "allow_session" {
        if let Some(suggestions) = response.permission_suggestions {
            decision["updatedPermissions"] = suggestions;
        }
    }
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision
        }
    })
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
        "Notification" if cfg.notify_claude_needs_you && notification_needs_attention(event) => {
            Notification::new()
                .summary(&format!("{} needs you", name))
                .body(event.message.as_deref().unwrap_or("Waiting for your input"))
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
    tauri::async_runtime::spawn(monitor_session_owners(state.clone()));
    let router = Router::new()
        .route("/event", post(handle_event))
        .route("/event/claude", post(handle_event))
        .route("/event/codex", post(handle_codex_event))
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

async fn monitor_session_owners(state: HookState) {
    let mut missing_checks: HashMap<String, u8> = HashMap::new();
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3));
    loop {
        ticker.tick().await;
        let owned = sessions::owned_sessions(&state.sessions);
        if owned.is_empty() {
            missing_checks.clear();
            continue;
        }

        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let live_ids: std::collections::HashSet<_> =
            owned.iter().map(|(id, _, _)| id.clone()).collect();
        missing_checks.retain(|id, _| live_ids.contains(id));

        for (session_id, _, owner_pid) in owned {
            if system.process(Pid::from_u32(owner_pid)).is_some() {
                missing_checks.remove(&session_id);
                continue;
            }
            let misses = missing_checks.entry(session_id.clone()).or_default();
            *misses = misses.saturating_add(1);
            // Two consecutive misses avoid removing a session during a brief
            // process-list refresh race on Windows.
            if *misses >= 2 {
                remove_session(&state, &session_id, "process_exited");
                missing_checks.remove(&session_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn claude_question_response_preserves_input_and_adds_answers() {
        let output = response_json(
            "claude",
            "question",
            &json!({ "questions": [{ "question": "Theme?" }] }),
            AgentResponse {
                action: "allow".into(),
                answers: Some(HashMap::from([("Theme?".into(), "Dark".into())])),
                permission_suggestions: None,
            },
        );
        assert_eq!(
            output["hookSpecificOutput"]["updatedInput"]["answers"]["Theme?"],
            "Dark"
        );
        assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "allow");
    }

    #[test]
    fn codex_session_allow_does_not_emit_reserved_permissions() {
        let output = response_json(
            "codex",
            "permission",
            &json!({}),
            AgentResponse {
                action: "allow_session".into(),
                answers: None,
                permission_suggestions: Some(json!([{ "type": "addRules" }])),
            },
        );
        assert!(output["hookSpecificOutput"]["decision"]
            .get("updatedPermissions")
            .is_none());
    }
}
