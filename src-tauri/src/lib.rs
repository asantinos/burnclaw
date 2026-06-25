mod anthropic;
mod codex;
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
use codex::CodexUsageSnapshot;
use notifications::NotificationState;
use setup_state::SetupState;
use status::StatusSnapshot;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

pub type SharedUsage = Arc<Mutex<Option<UsageSnapshot>>>;
/// Último snapshot de uso de Codex (None hasta el primer fetch o si Codex no
/// está activo).
pub type SharedCodexUsage = Arc<Mutex<Option<CodexUsageSnapshot>>>;
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

    // Qué proveedores trackear. Si el usuario los eligió en el wizard, se honra
    // su elección; si no (setup previo a esta feature), se cae a auto-detección
    // por archivos para no romper el tracking existente.
    let (track_claude, track_codex) = {
        let s = settings.lock().unwrap();
        if s.providers_chosen {
            (s.track_claude, s.track_codex)
        } else {
            (credentials::load_raw().is_ok(), codex::auth_exists())
        }
    };

    // Poller de uso de Claude. El poller relee las credenciales (y refresca el
    // token) en cada vuelta, así que solo hace falta que el archivo exista.
    if track_claude && credentials::load_raw().is_ok() {
        let handle = app.clone();
        let usage = app.state::<SharedUsage>().inner().clone();
        let notif = app.state::<SharedNotificationState>().inner().clone();
        let force_refresh = app.state::<ForceRefresh>().inner().clone();
        let poller_settings = settings.clone();
        tauri::async_runtime::spawn(async move {
            poller::run(handle, usage, notif, force_refresh, poller_settings).await;
        });
    } else {
        logging::app("claude usage poller not started (untracked or no credentials)");
    }

    // Poller de uso de Codex — gateado en la elección + que exista el auth.json.
    if track_codex && codex::auth_exists() {
        let handle = app.clone();
        let codex_usage = app.state::<SharedCodexUsage>().inner().clone();
        let codex_settings = settings.clone();
        tauri::async_runtime::spawn(async move {
            poller::run_codex(handle, codex_usage, codex_settings).await;
        });
    } else {
        logging::app("codex usage poller not started (untracked or no auth)");
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

/// Cuerpo normalizado que el forwarder de Codex envía al hook server.
#[derive(serde::Serialize)]
struct CodexForwardEvent {
    event_type: &'static str,
    provider: &'static str,
    message: Option<String>,
}

/// Si se invoca como `burnclaw --codex-notify <json>`, actúa de forwarder del
/// `notify` de Codex: traduce el payload al formato del hook server (con
/// `provider: "codex"`) y lo POSTea a 127.0.0.1:9876, luego sale. Devuelve true
/// si se consumió ese modo (para no arrancar la app entera). El propio exe hace
/// de forwarder: así Codex puede apuntar su `notify` a BurnClaw sin scripts.
fn try_codex_notify_forward() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let idx = match args.iter().position(|a| a == "--codex-notify") {
        Some(i) => i,
        None => return false,
    };
    let payload = args.get(idx + 1).cloned().unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let message = v
        .get("last-assistant-message")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    // Codex solo emite dos tipos; los mapeamos a los estados que ya entiende el
    // frontend (awaiting / finished).
    let event_type = match kind {
        "approval-requested" => "Notification",
        "agent-turn-complete" => "Stop",
        _ => return true, // tipo desconocido: nada que reenviar
    };

    let body = CodexForwardEvent {
        event_type,
        provider: "codex",
        message,
    };
    if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        rt.block_on(async {
            let _ = reqwest::Client::new()
                .post("http://127.0.0.1:9876/event")
                .json(&body)
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await;
        });
    }
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Modo forwarder del `notify` de Codex: reenvía y sale, sin arrancar la app.
    if try_codex_notify_forward() {
        return;
    }

    // Registrar el AppUserModelID antes de nada: las notificaciones que se
    // disparen después saldrán con el nombre/icono de BurnClaw.
    #[cfg(windows)]
    if let Err(e) = notifications::register_aumid() {
        logging::app(&format!("failed to register AUMID: {}", e));
    }

    let usage_state: SharedUsage = Arc::new(Mutex::new(None));
    let codex_usage_state: SharedCodexUsage = Arc::new(Mutex::new(None));
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
        .manage(codex_usage_state)
        .manage(status_state)
        .manage(force_refresh)
        .manage(notification_state)
        .manage(last_window_pos)
        .manage(settings)
        .invoke_handler(tauri::generate_handler![
            commands::get_current_usage,
            commands::get_current_codex_usage,
            commands::check_codex_credentials,
            commands::get_current_status,
            commands::resize_shell_window,
            commands::cursor_position,
            commands::force_refresh,
            commands::check_credentials,
            commands::run_claude_login,
            commands::run_codex_login,
            commands::refresh_oauth_token,
            commands::check_hooks_status,
            commands::install_hooks,
            commands::remove_hooks,
            commands::check_codex_notify,
            commands::install_codex_notify,
            commands::remove_codex_notify,
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
            // load_raw, no load: un token caducado no debe mandar al wizard —
            // el poller lo refrescará solo. Basta con que exista el archivo de
            // CUALQUIERA de los dos proveedores (Claude o Codex).
            let creds_ok = credentials::load_raw().is_ok() || codex::auth_exists();

            if !completed || !creds_ok {
                // Primer arranque o credenciales rotas: mostrar el wizard.
                if let Some(win) = app.get_webview_window("setup") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            } else {
                init_tray_and_pill(app.handle())?;
                // Mostrar la pill al arrancar, no solo el tray icon.
                tray::show_main_window(app.handle());
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
