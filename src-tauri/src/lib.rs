mod anthropic;
mod commands;
mod credentials;
mod hook_server;
mod notifications;
mod poller;
mod setup_state;
mod status;
mod tray;

use std::sync::{Arc, Mutex};

use anthropic::UsageSnapshot;
use notifications::NotificationState;
use status::StatusSnapshot;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

pub type SharedUsage = Arc<Mutex<Option<UsageSnapshot>>>;
pub type SharedStatus = Arc<Mutex<Option<StatusSnapshot>>>;
pub type ForceRefresh = Arc<Notify>;
pub type SharedNotificationState = Arc<Mutex<NotificationState>>;
/// Última posición (top-left, physical px) de la ventana al ocultarla, para
/// restaurarla en el siguiente show en vez de reposicionar junto al tray.
pub type LastWindowPos = Arc<Mutex<Option<(i32, i32)>>>;

/// Arranca el modo normal de la app: tray icon, poller de uso, poller de
/// status y servidor de hooks. Se llama al arrancar (si el setup ya está
/// completo y hay credenciales) o desde `complete_setup` al cerrar el wizard.
pub fn init_tray_and_pill(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Idempotente: complete_setup puede llamarlo de nuevo (p. ej. al reabrir
    // Settings y darle a Done otra vez). Si el tray ya existe, no re-inicializa.
    if tray::is_initialized(app) {
        return Ok(());
    }
    tray::setup(app)?;

    // Poller de uso — necesita el token OAuth.
    match credentials::load() {
        Ok(oauth) => {
            let interval = setup_state::SetupState::load()
                .polling_interval_secs
                .max(10);
            let handle = app.clone();
            let usage = app.state::<SharedUsage>().inner().clone();
            let notif = app.state::<SharedNotificationState>().inner().clone();
            let force_refresh = app.state::<ForceRefresh>().inner().clone();
            let token = oauth.access_token.clone();
            tauri::async_runtime::spawn(async move {
                poller::run(handle, usage, notif, force_refresh, token, interval).await;
            });
        }
        Err(e) => {
            eprintln!("ERR: credentials load failed in init_tray_and_pill: {}", e);
        }
    }

    // Poller de status — no necesita credenciales.
    let status_handle = app.clone();
    let status = app.state::<SharedStatus>().inner().clone();
    tauri::async_runtime::spawn(async move {
        poller::run_status(status_handle, status).await;
    });

    // Servidor de hooks de Claude Code.
    let hook_state = hook_server::HookState { app: app.clone() };
    tauri::async_runtime::spawn(hook_server::start_server(hook_state));

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let usage_state: SharedUsage = Arc::new(Mutex::new(None));
    let status_state: SharedStatus = Arc::new(Mutex::new(None));
    let force_refresh: ForceRefresh = Arc::new(Notify::new());
    let notification_state: SharedNotificationState =
        Arc::new(Mutex::new(NotificationState::new()));
    let last_window_pos: LastWindowPos = Arc::new(Mutex::new(None));

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
            commands::check_credentials,
            commands::run_claude_login,
            commands::refresh_oauth_token,
            commands::check_hooks_status,
            commands::install_hooks,
            commands::remove_hooks,
            commands::set_auto_start,
            commands::complete_setup,
            commands::exit_app,
        ])
        .setup(|app| {
            let setup = setup_state::SetupState::load();
            let creds_ok = credentials::load().is_ok();

            if !setup.completed || !creds_ok {
                // Primer arranque o credenciales rotas: mostrar el wizard.
                // NO se arranca tray/pill todavía — eso lo hace complete_setup.
                if let Some(win) = app.get_webview_window("setup") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            } else {
                // Flujo normal.
                init_tray_and_pill(app.handle())?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
