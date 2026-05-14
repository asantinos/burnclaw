use chrono::{DateTime, Utc};
use notify_rust::Notification;

use crate::anthropic::UsageSnapshot;
use crate::setup_state::SetupState;
use crate::status::StatusSnapshot;
use crate::tray::format_countdown;

/// Memoria entre polls: qué umbrales ya se han notificado en la ventana actual,
/// para no repetir la notificación cada 60s.
pub struct NotificationState {
    pub session_warn_notified: bool,
    pub session_crit_notified: bool,
    pub weekly_warn_notified: bool,
    pub weekly_crit_notified: bool,
    pub current_session_window: Option<DateTime<Utc>>,
    pub current_weekly_window: Option<DateTime<Utc>>,
}

impl NotificationState {
    pub fn new() -> Self {
        Self {
            session_warn_notified: false,
            session_crit_notified: false,
            weekly_warn_notified: false,
            weekly_crit_notified: false,
            current_session_window: None,
            current_weekly_window: None,
        }
    }
}

/// Comprueba los umbrales de uso y notifica una vez por ventana. Los umbrales
/// y el toggle vienen de los ajustes (`cfg`), así que cambiarlos en Settings
/// surte efecto en el siguiente poll.
pub fn check_and_notify(
    state: &mut NotificationState,
    snap: &UsageSnapshot,
    cfg: &SetupState,
) {
    // Reset de flags al cambiar de ventana (nuevo reset_at) — siempre, aunque
    // las notificaciones estén desactivadas, para no quedar en estado raro.
    if state.current_session_window != Some(snap.session_5h_reset_at) {
        state.session_warn_notified = false;
        state.session_crit_notified = false;
        state.current_session_window = Some(snap.session_5h_reset_at);
    }
    if state.current_weekly_window != Some(snap.weekly_reset_at) {
        state.weekly_warn_notified = false;
        state.weekly_crit_notified = false;
        state.current_weekly_window = Some(snap.weekly_reset_at);
    }

    if !cfg.notify_usage_thresholds {
        return;
    }

    let warn = cfg.warning_threshold as f64;
    let crit = cfg.critical_threshold as f64;

    // --- Session 5h ---
    if snap.session_5h_pct >= crit && !state.session_crit_notified {
        notify(
            "BurnClaw — Session critical",
            &format!(
                "Session at {}%. Resets in {}",
                snap.session_5h_pct.round() as i64,
                format_countdown(&snap.session_5h_reset_at),
            ),
        );
        state.session_crit_notified = true;
    } else if snap.session_5h_pct >= warn
        && !state.session_warn_notified
        && !state.session_crit_notified
    {
        notify(
            "BurnClaw — Session warning",
            &format!(
                "Session at {}%. Resets in {}",
                snap.session_5h_pct.round() as i64,
                format_countdown(&snap.session_5h_reset_at),
            ),
        );
        state.session_warn_notified = true;
    }

    // --- Weekly 7d ---
    if snap.weekly_pct >= crit && !state.weekly_crit_notified {
        notify(
            "BurnClaw — Weekly critical",
            &format!(
                "Weekly at {}%. Resets in {}",
                snap.weekly_pct.round() as i64,
                format_countdown(&snap.weekly_reset_at),
            ),
        );
        state.weekly_crit_notified = true;
    } else if snap.weekly_pct >= warn
        && !state.weekly_warn_notified
        && !state.weekly_crit_notified
    {
        notify(
            "BurnClaw — Weekly warning",
            &format!(
                "Weekly at {}%. Resets in {}",
                snap.weekly_pct.round() as i64,
                format_countdown(&snap.weekly_reset_at),
            ),
        );
        state.weekly_warn_notified = true;
    }
}

/// Notificación de incidente del servicio (status.claude.com). El poller la
/// llama solo si el toggle `notify_service_incidents` está activo.
pub fn notify_service_incident(snap: &StatusSnapshot) {
    notify("BurnClaw — Claude service incident", &snap.description);
}

fn notify(title: &str, body: &str) {
    let _ = Notification::new()
        .summary(title)
        .body(body)
        .timeout(notify_rust::Timeout::Default)
        .show();
}
