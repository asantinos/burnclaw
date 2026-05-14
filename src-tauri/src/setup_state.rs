use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Estado persistido de BurnClaw: marca de setup completado + todos los
/// ajustes editables desde la ventana de Settings. Se guarda en
/// %APPDATA%/burnclaw/setup.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SetupState {
    pub completed: bool,
    // --- Behavior ---
    pub auto_start: bool,
    pub start_minimized: bool,
    pub polling_interval_secs: u64,
    // --- Activity hooks (feedback visual) ---
    pub orange_border: bool,
    pub console_banner: bool,
    // --- Advanced: umbrales de notificación de uso ---
    pub warning_threshold: u32,
    pub critical_threshold: u32,
    // --- Advanced: toggles de notificaciones ---
    pub notify_usage_thresholds: bool,
    pub notify_claude_finished: bool,
    pub notify_claude_needs_you: bool,
    pub notify_service_incidents: bool,
}

impl Default for SetupState {
    fn default() -> Self {
        Self {
            completed: false,
            auto_start: true,
            start_minimized: true,
            polling_interval_secs: 60,
            orange_border: true,
            console_banner: true,
            warning_threshold: 80,
            critical_threshold: 95,
            notify_usage_thresholds: true,
            notify_claude_finished: true,
            notify_claude_needs_you: true,
            notify_service_incidents: false,
        }
    }
}

impl SetupState {
    pub fn defaults() -> Self {
        Self::default()
    }

    pub fn path() -> Result<PathBuf, Box<dyn std::error::Error>> {
        let mut path = dirs::config_dir().ok_or("config_dir unavailable")?;
        path.push("burnclaw");
        fs::create_dir_all(&path)?;
        path.push("setup.json");
        Ok(path)
    }

    /// Carga desde disco. Con `#[serde(default)]` los campos que falten (p. ej.
    /// un setup.json viejo) se rellenan con los valores por defecto sin perder
    /// los que sí están.
    pub fn load() -> Self {
        match Self::path().and_then(|p| Ok(fs::read_to_string(p)?)) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| Self::defaults()),
            Err(_) => Self::defaults(),
        }
    }

    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let path = Self::path()?;
        fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}
