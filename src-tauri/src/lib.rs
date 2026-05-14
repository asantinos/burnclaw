mod anthropic;
mod commands;
mod credentials;
mod hook_server;
mod logging;
mod notifications;
mod poller;
mod setup_state;
mod status;
mod tray;

use std::sync::{Arc, Mutex};

use anthropic::UsageSnapshot;
use notifications::NotificationState;
use setup_state::SetupState;
use status::StatusSnapshot;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

pub type SharedUsage = Arc<Mutex<Option<UsageSnapshot>>>;
pub type SharedStatus = Arc<Mutex<Option<StatusSnapshot>>>;
pub type ForceRefresh = Arc<Notify>;
pub type SharedNotificationState = Arc<Mutex<NotificationState>>;
/// Última posición (top-left, physical px) de la ventana al ocultarla, para
/// restaurarla en el siguiente show en vez de reposicionar.
pub type LastWindowPos = Arc<Mutex<Option<(i32, i32)>>>;
/// Ajustes vivos de la app, compartidos: el poller lee el intervalo cada vuelta,
/// notifications lee umbrales/toggles, y `save_settings` los actualiza.
pub type SharedSettings = Arc<Mutex<SetupState>>;

/// Arranca el modo normal de la app: tray icon, poller de uso, poller de
/// status y servidor de hooks. Se llama al arrancar (si el setup ya está
/// completo y hay credenciales) o desde `complete_setup` al cerrar el wizard.
/// Idempotente: si el tray ya existe, no re-inicializa.
pub fn init_tray_and_pill(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if tray::is_initialized(app) {
        return Ok(());
    }
    tray::setup(app)?;

    let settings = app.state::<SharedSettings>().inner().clone();

    // Poller de uso — necesita el token OAuth.
    match credentials::load() {
        Ok(oauth) => {
            let handle = app.clone();
            let usage = app.state::<SharedUsage>().inner().clone();
            let notif = app.state::<SharedNotificationState>().inner().clone();
            let force_refresh = app.state::<ForceRefresh>().inner().clone();
            let token = oauth.access_token.clone();
            let poller_settings = settings.clone();
            tauri::async_runtime::spawn(async move {
                poller::run(handle, usage, notif, force_refresh, token, poller_settings)
                    .await;
            });
        }
        Err(e) => {
            logging::app(&format!(
                "credentials load failed in init_tray_and_pill: {}",
                e
            ));
        }
    }

    // Poller de status — no necesita credenciales.
    let status_handle = app.clone();
    let status = app.state::<SharedStatus>().inner().clone();
    let status_settings = settings.clone();
    tauri::async_runtime::spawn(async move {
        poller::run_status(status_handle, status, status_settings).await;
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
    let settings: SharedSettings = Arc::new(Mutex::new(SetupState::load()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(usage_state)
        .manage(status_state)
        .manage(force_refresh)
        .manage(notification_state)
        .manage(last_window_pos)
        .manage(settings)
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
            commands::get_settings,
            commands::save_settings,
            commands::reset_settings,
            commands::open_logs_folder,
        ])
        .on_window_event(|window, event| {
            // La ventana de Settings tiene decoración nativa: al pulsar la X
            // del SO se oculta (no se destruye), para poder reabrirla desde el
            // menú del tray sin recrearla.
            if window.label() == "settings" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let completed = app.state::<SharedSettings>().lock().unwrap().completed;
            let creds_ok = credentials::load().is_ok();

            if !completed || !creds_ok {
                // Primer arranque o credenciales rotas: mostrar el wizard.
                if let Some(win) = app.get_webview_window("setup") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            } else {
                init_tray_and_pill(app.handle())?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
