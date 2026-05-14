use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusSnapshot {
    pub indicator: String,   // none | minor | major | critical | maintenance
    pub description: String, // "All Systems Operational" etc
    pub fetched_at: DateTime<Utc>,
}

pub async fn fetch_status() -> Result<StatusSnapshot, reqwest::Error> {
    #[derive(Deserialize)]
    struct ApiResponse {
        status: ApiStatus,
    }
    #[derive(Deserialize)]
    struct ApiStatus {
        indicator: String,
        description: String,
    }

    let res: ApiResponse = reqwest::get("https://status.claude.com/api/v2/status.json")
        .await?
        .json()
        .await?;

    Ok(StatusSnapshot {
        indicator: res.status.indicator,
        description: res.status.description,
        fetched_at: Utc::now(),
    })
}
