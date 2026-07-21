use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type SharedSessions = Arc<Mutex<HashMap<String, AgentSession>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSession {
    pub id: String,
    pub provider: String,
    pub project: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub state: String,
    pub event_type: String,
    pub tool_name: Option<String>,
    pub tool_target: Option<String>,
    pub tool_input: Option<Value>,
    pub message: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
    pub owner_pid: Option<u32>,
    pub active_subagents: u32,
    #[serde(skip)]
    subagent_ids: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct AgentSessionEvent {
    pub id: String,
    pub provider: String,
    pub cwd: Option<String>,
    pub event_type: String,
    pub tool_name: Option<String>,
    pub tool_target: Option<String>,
    pub tool_input: Option<Value>,
    pub message: Option<String>,
    pub owner_pid: Option<u32>,
    pub agent_id: Option<String>,
}

fn project_name(cwd: Option<&str>) -> String {
    cwd.and_then(|path| path.rsplit(['/', '\\']).find(|part| !part.is_empty()))
        .unwrap_or("session")
        .to_string()
}

fn state_for_event(event_type: &str) -> &'static str {
    match event_type {
        "PermissionRequest" | "AskUserQuestion" | "CodexQuestion" | "Notification" => "awaiting",
        "Stop" | "agent-turn-complete" => "finished",
        // A subagent finishing is still part of the root turn. Treating it as
        // a root Stop made live sessions disappear while Codex/Claude worked.
        "SubagentStart" | "SubagentStop" => "working",
        "SessionEnd" => "closed",
        _ => "working",
    }
}

fn clipped(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let clipped: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{}…", clipped.trim_end())
    } else {
        clipped
    }
}

pub fn apply_event(sessions: &SharedSessions, event: AgentSessionEvent) -> AgentSession {
    let now = Utc::now().timestamp_millis();
    let mut guard = sessions.lock().unwrap();
    let entry = guard
        .entry(event.id.clone())
        .or_insert_with(|| AgentSession {
            id: event.id.clone(),
            provider: event.provider.clone(),
            project: project_name(event.cwd.as_deref()),
            cwd: event.cwd.clone(),
            title: None,
            state: "working".into(),
            event_type: event.event_type.clone(),
            tool_name: None,
            tool_target: None,
            tool_input: None,
            message: None,
            started_at: now,
            updated_at: now,
            finished_at: None,
            owner_pid: event.owner_pid,
            active_subagents: 0,
            subagent_ids: HashSet::new(),
        });

    entry.provider = event.provider;
    if event.cwd.is_some() {
        entry.project = project_name(event.cwd.as_deref());
        entry.cwd = event.cwd;
    }
    if event.owner_pid.is_some() {
        entry.owner_pid = event.owner_pid;
    }
    match event.event_type.as_str() {
        "SubagentStart" => {
            if let Some(agent_id) = event.agent_id.as_deref() {
                entry.subagent_ids.insert(agent_id.to_string());
                entry.active_subagents = entry.subagent_ids.len() as u32;
            } else {
                entry.active_subagents = entry.active_subagents.saturating_add(1);
            }
        }
        "SubagentStop" => {
            if let Some(agent_id) = event.agent_id.as_deref() {
                entry.subagent_ids.remove(agent_id);
                entry.active_subagents = entry.subagent_ids.len() as u32;
            } else {
                entry.active_subagents = entry.active_subagents.saturating_sub(1);
            }
        }
        _ => {}
    }
    if event.event_type == "UserPromptSubmit" {
        if let Some(message) = event.message.as_deref() {
            entry.title = Some(clipped(message, 72));
        }
    }
    entry.state = state_for_event(&event.event_type).into();
    entry.event_type = event.event_type;
    entry.tool_name = event.tool_name;
    entry.tool_target = event.tool_target;
    entry.tool_input = event.tool_input;
    if event.message.is_some() {
        entry.message = event.message;
    }
    entry.updated_at = now;
    entry.finished_at = (entry.state == "finished" || entry.state == "closed").then_some(now);

    entry.clone()
}

pub fn list(sessions: &SharedSessions) -> Vec<AgentSession> {
    let mut values: Vec<_> = sessions.lock().unwrap().values().cloned().collect();
    values.sort_by(|a, b| {
        let rank = |state: &str| match state {
            "awaiting" => 0,
            "working" => 1,
            "finished" => 2,
            _ => 3,
        };
        rank(&a.state)
            .cmp(&rank(&b.state))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    values
}

pub fn dismiss(sessions: &SharedSessions, id: &str) -> bool {
    sessions.lock().unwrap().remove(id).is_some()
}

pub fn resume(sessions: &SharedSessions, id: &str) -> Option<AgentSession> {
    let mut guard = sessions.lock().unwrap();
    let session = guard.get_mut(id)?;
    session.state = "working".into();
    session.finished_at = None;
    session.updated_at = Utc::now().timestamp_millis();
    Some(session.clone())
}

pub fn owned_sessions(sessions: &SharedSessions) -> Vec<(String, String, u32)> {
    sessions
        .lock()
        .unwrap()
        .values()
        .filter_map(|session| {
            session
                .owner_pid
                .map(|pid| (session.id.clone(), session.provider.clone(), pid))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(event_type: &str, agent_id: Option<&str>) -> AgentSessionEvent {
        AgentSessionEvent {
            id: "session-1".into(),
            provider: "codex".into(),
            cwd: Some("C:/work/burnclaw".into()),
            event_type: event_type.into(),
            tool_name: None,
            tool_target: None,
            tool_input: None,
            message: None,
            owner_pid: Some(42),
            agent_id: agent_id.map(str::to_string),
        }
    }

    #[test]
    fn subagent_stop_keeps_root_session_working() {
        let sessions: SharedSessions = Arc::new(Mutex::new(HashMap::new()));
        let started = apply_event(&sessions, event("SubagentStart", Some("agent-1")));
        assert_eq!(started.state, "working");
        assert_eq!(started.active_subagents, 1);

        let stopped = apply_event(&sessions, event("SubagentStop", Some("agent-1")));
        assert_eq!(stopped.state, "working");
        assert_eq!(stopped.active_subagents, 0);
    }

    #[test]
    fn stop_finishes_only_the_root_turn() {
        let sessions: SharedSessions = Arc::new(Mutex::new(HashMap::new()));
        let stopped = apply_event(&sessions, event("Stop", None));
        assert_eq!(stopped.state, "finished");
    }
}
