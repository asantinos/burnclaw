use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::anthropic;
use crate::notifications;
use crate::status;
use crate::tray;
use crate::{ForceRefresh, SharedNotificationState, SharedStatus, SharedUsage};

const STATUS_INTERVAL_SECS: u64 = 300;

pub async fn run(
    app: AppHandle,
    state: SharedUsage,
    notif_state: SharedNotificationState,
    force_refresh: ForceRefresh,
    token: String,
    interval_secs: u64,
) {
    loop {
        match anthropic::fetch_usage(&token).await {
            Ok(snap) => {
                {
                    let mut guard = state.lock().unwrap();
                    *guard = Some(snap.clone());
                }
                if let Err(e) = app.emit("usage-updated", snap.clone()) {
                    eprintln!("ERR: emit usage-updated failed: {}", e);
                }
                if let Err(e) = tray::update_tray_dynamic(&app, &snap) {
                    eprintln!("ERR: tray update failed: {}", e);
                }
                {
                    let mut ns = notif_state.lock().unwrap();
                    notifications::check_and_notify(&mut ns, &snap);
                }
            }
            Err(e) => {
                let msg = e.to_string();
                eprintln!("ERR: fetch_usage failed: {}", msg);
                let _ = app.emit("usage-error", msg);
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(interval_secs)) => {}
            _ = force_refresh.notified() => {}
        }
    }
}

pub async fn run_status(app: AppHandle, state: SharedStatus) {
    loop {
        match status::fetch_status().await {
            Ok(snap) => {
                {
                    let mut guard = state.lock().unwrap();
                    *guard = Some(snap.clone());
                }
                if let Err(e) = app.emit("status-updated", snap) {
                    eprintln!("ERR: emit status-updated failed: {}", e);
                }
            }
            Err(e) => {
                eprintln!("ERR: fetch_status failed: {}", e);
            }
        }
        tokio::time::sleep(Duration::from_secs(STATUS_INTERVAL_SECS)).await;
    }
}
