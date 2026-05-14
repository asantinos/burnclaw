mod anthropic;
mod commands;
mod credentials;
mod hook_server;
mod notifications;
mod poller;
mod status;
mod tray;

use std::sync::{Arc, Mutex};

use anthropic::UsageSnapshot;
use notifications::NotificationState;
use status::StatusSnapshot;
use tokio::sync::Notify;

pub type SharedUsage = Arc<Mutex<Option<UsageSnapshot>>>;
pub type SharedStatus = Arc<Mutex<Option<StatusSnapshot>>>;
pub type ForceRefresh = Arc<Notify>;
pub type SharedNotificationState = Arc<Mutex<NotificationState>>;
/// Última posición (top-left, physical px) de la ventana al ocultarla, para
/// restaurarla en el siguiente show en vez de reposicionar junto al tray.
pub type LastWindowPos = Arc<Mutex<Option<(i32, i32)>>>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let oauth = match credentials::load() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("ERR: Failed to load credentials: {}", e);
            std::process::exit(1);
        }
    };

    let usage_state: SharedUsage = Arc::new(Mutex::new(None));
    let status_state: SharedStatus = Arc::new(Mutex::new(None));
    let force_refresh: ForceRefresh = Arc::new(Notify::new());
    let notification_state: SharedNotificationState =
        Arc::new(Mutex::new(NotificationState::new()));
    let last_window_pos: LastWindowPos = Arc::new(Mutex::new(None));

    let usage_for_setup = usage_state.clone();
    let status_for_setup = status_state.clone();
    let notify_for_setup = force_refresh.clone();
    let notif_for_setup = notification_state.clone();
    let access_token = oauth.access_token.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(usage_state)
        .manage(status_state)
        .manage(force_refresh)
        .manage(notification_state)
        .manage(last_window_pos)
        .invoke_handler(tauri::generate_handler![
            commands::get_current_usage,
            commands::get_current_status,
            commands::resize_shell_window,
            commands::force_refresh,
        ])
        .setup(move |app| {
            tray::setup(app.handle())?;

            let handle = app.handle().clone();
            let usage = usage_for_setup.clone();
            let notify = notify_for_setup.clone();
            let notif = notif_for_setup.clone();
            let token = access_token.clone();
            tauri::async_runtime::spawn(async move {
                poller::run(handle, usage, notif, notify, token).await;
            });

            let status_handle = app.handle().clone();
            let status = status_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                poller::run_status(status_handle, status).await;
            });

            let hook_state = hook_server::HookState {
                app: app.handle().clone(),
            };
            tauri::async_runtime::spawn(hook_server::start_server(hook_state));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
