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
    // --- Providers a trackear (elegidos en el wizard) ---
    /// true una vez el usuario eligió proveedores en el wizard. Si es false en
    /// un setup ya completado (instalación anterior a esta feature), el gateo
    /// cae a auto-detección para no romper el tracking existente.
    pub providers_chosen: bool,
    pub track_claude: bool,
    pub track_codex: bool,
    // --- Behavior ---
    pub auto_start: bool,
    pub start_minimized: bool,
    pub polling_interval_secs: u64,
    // --- Activity hooks (feedback visual) ---
    /// Panel-notificación que se desliza bajo la pill al haber actividad.
    pub pill_activity_enabled: bool,
    /// Qué proveedores disparan el panel (separable Claude / Codex).
    pub pill_activity_claude: bool,
    pub pill_activity_codex: bool,
    pub pill_activity_working: bool,
    pub pill_activity_awaiting: bool,
    pub pill_activity_finished: bool,
    /// Segundos hasta auto-ocultar el panel; 0 = no se oculta solo.
    pub pill_activity_dismiss_secs: u64,
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
            providers_chosen: false,
            track_claude: true,
            track_codex: false,
            auto_start: true,
            start_minimized: true,
            polling_interval_secs: 60,
            pill_activity_enabled: true,
            pill_activity_claude: true,
            pill_activity_codex: true,
            pill_activity_working: false,
            pill_activity_awaiting: true,
            pill_activity_finished: true,
            pill_activity_dismiss_secs: 6,
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
