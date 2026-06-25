use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusSnapshot {
    pub indicator: String,   // none | minor | major | critical | maintenance
    pub description: String, // "All Systems Operational" etc
    pub fetched_at: DateTime<Utc>,
}

/// Página de estado de Claude (formato Statuspage). El indicador global vale
/// porque toda la página es de Claude.
pub const CLAUDE_STATUS_URL: &str = "https://status.claude.com/api/v2/status.json";

pub async fn fetch_status(url: &str) -> Result<StatusSnapshot, reqwest::Error> {
    #[derive(Deserialize)]
    struct ApiResponse {
        status: ApiStatus,
    }
    #[derive(Deserialize)]
    struct ApiStatus {
        indicator: String,
        description: String,
    }

    let res: ApiResponse = reqwest::get(url).await?.json().await?;

    Ok(StatusSnapshot {
        indicator: res.status.indicator,
        description: res.status.description,
        fetched_at: Utc::now(),
    })
}

/// Estado de Codex en OpenAI. El indicador GLOBAL de status.openai.com agrega
/// todos los componentes (APIs, ChatGPT, FedRAMP, Ads…), así que mirarlo da
/// falsos "degraded" cuando lo que falla no es Codex. En su lugar miramos solo
/// los componentes cuyo nombre contiene "Codex" y tomamos el peor.
pub async fn fetch_codex_status() -> Result<StatusSnapshot, reqwest::Error> {
    #[derive(Deserialize)]
    struct ComponentsResponse {
        components: Vec<Component>,
    }
    #[derive(Deserialize)]
    struct Component {
        name: String,
        status: String,
    }

    let res: ComponentsResponse =
        reqwest::get("https://status.openai.com/api/v2/components.json")
            .await?
            .json()
            .await?;

    // Severidad de cada estado de componente (Statuspage).
    let rank = |s: &str| match s {
        "operational" => 0,
        "under_maintenance" => 1,
        "degraded_performance" => 2,
        "partial_outage" => 3,
        "major_outage" => 4,
        _ => 0,
    };

    let worst = res
        .components
        .iter()
        .filter(|c| c.name.to_lowercase().contains("codex"))
        .max_by_key(|c| rank(&c.status));

    let (indicator, description) = match worst {
        None => ("none".to_string(), "Operational".to_string()),
        Some(c) => {
            let indicator = match c.status.as_str() {
                "operational" => "none",
                "under_maintenance" => "maintenance",
                "degraded_performance" => "minor",
                "partial_outage" => "major",
                "major_outage" => "critical",
                _ => "none",
            };
            let description = if indicator == "none" {
                "Operational".to_string()
            } else {
                format!("{} — {}", c.name, c.status.replace('_', " "))
            };
            (indicator.to_string(), description)
        }
    };

    Ok(StatusSnapshot {
        indicator,
        description,
        fetched_at: Utc::now(),
    })
}
