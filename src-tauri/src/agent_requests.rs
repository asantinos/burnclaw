use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::oneshot;

pub type SharedAgentRequests = Arc<Mutex<HashMap<String, PendingAgentRequest>>>;

#[derive(Debug, Clone, Serialize)]
pub struct AgentRequestInfo {
    pub id: String,
    pub session_id: String,
    pub provider: String,
    pub kind: String,
    pub tool_name: String,
    pub tool_input: Value,
    pub created_at: i64,
}

#[derive(Debug)]
pub struct AgentResponse {
    pub action: String,
    pub answers: Option<HashMap<String, String>>,
    pub permission_suggestions: Option<Value>,
}

pub struct PendingAgentRequest {
    pub info: AgentRequestInfo,
    pub permission_suggestions: Option<Value>,
    sender: oneshot::Sender<AgentResponse>,
}

pub fn register(
    requests: &SharedAgentRequests,
    session_id: String,
    provider: String,
    kind: String,
    tool_name: String,
    tool_input: Value,
    permission_suggestions: Option<Value>,
) -> (AgentRequestInfo, oneshot::Receiver<AgentResponse>) {
    let created_at = Utc::now().timestamp_millis();
    let id = format!("{}:{}", session_id, Utc::now().timestamp_micros());
    let info = AgentRequestInfo {
        id: id.clone(),
        session_id,
        provider,
        kind,
        tool_name,
        tool_input,
        created_at,
    };
    let (sender, receiver) = oneshot::channel();
    requests.lock().unwrap().insert(
        id,
        PendingAgentRequest {
            info: info.clone(),
            permission_suggestions,
            sender,
        },
    );
    (info, receiver)
}

pub fn list(requests: &SharedAgentRequests) -> Vec<AgentRequestInfo> {
    let mut values: Vec<_> = requests
        .lock()
        .unwrap()
        .values()
        .map(|request| request.info.clone())
        .collect();
    values.sort_by_key(|request| request.created_at);
    values
}

pub fn respond(
    requests: &SharedAgentRequests,
    id: &str,
    response: AgentResponse,
) -> Result<AgentRequestInfo, String> {
    let request = requests
        .lock()
        .unwrap()
        .remove(id)
        .ok_or("request is no longer pending")?;
    let info = request.info.clone();
    request
        .sender
        .send(response)
        .map_err(|_| "agent session stopped waiting".to_string())?;
    Ok(info)
}

pub fn take_suggestion(requests: &SharedAgentRequests, id: &str) -> Option<Value> {
    requests
        .lock()
        .unwrap()
        .get(id)
        .and_then(|request| request.permission_suggestions.clone())
}

pub fn expire(requests: &SharedAgentRequests, id: &str) {
    requests.lock().unwrap().remove(id);
}

/// Drop every waiter owned by a session and return their public ids so the UI
/// can clear them too. Dropping the oneshot sender releases the hook process.
pub fn expire_session(requests: &SharedAgentRequests, session_id: &str) -> Vec<String> {
    let mut guard = requests.lock().unwrap();
    let ids: Vec<_> = guard
        .iter()
        .filter(|(_, request)| request.info.session_id == session_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &ids {
        guard.remove(id);
    }
    ids
}
