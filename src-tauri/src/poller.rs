use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::anthropic;
use crate::logging;
use crate::notifications;
use crate::status;
use crate::tray;
use crate::{ForceRefresh, SharedNotificationState, SharedSettings, SharedStatus, SharedUsage};

const STATUS_INTERVAL_SECS: u64 = 300;
/// Suelo del intervalo de polling, por si el ajuste guardado es absurdamente bajo.
const MIN_INTERVAL_SECS: u64 = 10;

pub async fn run(
    app: AppHandle,
    state: SharedUsage,
    notif_state: SharedNotificationState,
    force_refresh: ForceRefresh,
    token: String,
    settings: SharedSettings,
) {
    loop {
        match anthropic::fetch_usage(&token).await {
            Ok(snap) => {
                {
                    let mut guard = state.lock().unwrap();
                    *guard = Some(snap.clone());
                }
                if let Err(e) = app.emit("usage-updated", snap.clone()) {
                    logging::app(&format!("emit usage-updated failed: {}", e));
                }
                if let Err(e) = tray::update_tray_dynamic(&app, &snap) {
                    logging::app(&format!("tray update failed: {}", e));
                }
                {
                    let cfg = settings.lock().unwrap().clone();
                    let mut ns = notif_state.lock().unwrap();
                    notifications::check_and_notify(&mut ns, &snap, &cfg);
                }
            }
            Err(e) => {
                let msg = e.to_string();
                logging::app(&format!("fetch_usage failed: {}", msg));
                let _ = app.emit("usage-error", msg);
            }
        }

        // El intervalo se relee cada vuelta: cambiarlo en Settings surte efecto
        // en el siguiente ciclo, sin reiniciar la app.
        let interval = settings
            .lock()
            .unwrap()
            .polling_interval_secs
            .max(MIN_INTERVAL_SECS);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
            _ = force_refresh.notified() => {}
        }
    }
}

pub async fn run_status(app: AppHandle, state: SharedStatus, settings: SharedSettings) {
    let mut last_indicator: Option<String> = None;
    loop {
        match status::fetch_status().await {
            Ok(snap) => {
                // Notificación de incidente: al pasar a un estado problemático
                // (indicator != "none") por primera vez, si el toggle está on.
                let is_incident = snap.indicator != "none";
                let changed =
                    last_indicator.as_deref() != Some(snap.indicator.as_str());
                if is_incident && changed && settings.lock().unwrap().notify_service_incidents
                {
                    notifications::notify_service_incident(&snap);
                }
                last_indicator = Some(snap.indicator.clone());

                {
                    let mut guard = state.lock().unwrap();
                    *guard = Some(snap.clone());
                }
                let _ = app.emit("status-updated", snap);
            }
            Err(e) => {
                logging::app(&format!("fetch_status failed: {}", e));
            }
        }
        tokio::time::sleep(Duration::from_secs(STATUS_INTERVAL_SECS)).await;
    }
}
