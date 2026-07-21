mod agent_requests;
mod anthropic;
mod codex;
mod commands;
mod credentials;
mod hook_server;
mod logging;
mod notifications;
mod poller;
mod sessions;
mod setup_state;
mod status;
mod tray;

use std::io::Read;
use std::sync::{Arc, Mutex};

use agent_requests::SharedAgentRequests;
use anthropic::UsageSnapshot;
use codex::CodexUsageSnapshot;
use notifications::NotificationState;
use sessions::SharedSessions;
use setup_state::SetupState;
use status::StatusSnapshot;
use sysinfo::{get_current_pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

pub type SharedUsage = Arc<Mutex<Option<UsageSnapshot>>>;
/// Último snapshot de uso de Codex (None hasta el primer fetch o si Codex no
/// está activo).
pub type SharedCodexUsage = Arc<Mutex<Option<CodexUsageSnapshot>>>;
pub type SharedStatus = Arc<Mutex<Option<StatusSnapshot>>>;
/// Estado del servicio de OpenAI (status.openai.com), para Codex. Comparte el
/// tipo interno con `SharedStatus`, así que se envuelve en un newtype: Tauri
/// indexa el estado gestionado por tipo y dos alias del mismo tipo colisionan.
pub type SharedCodexStatus = Arc<Mutex<Option<StatusSnapshot>>>;
pub struct CodexStatusState(pub SharedCodexStatus);
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

    // Poller de status — no necesita credenciales. Pollea Claude siempre y
    // OpenAI (Codex) si hay auth de Codex.
    let status_handle = app.clone();
    let status = app.state::<SharedStatus>().inner().clone();
    let codex_status = app.state::<CodexStatusState>().inner().0.clone();
    let status_settings = settings.clone();
    tauri::async_runtime::spawn(async move {
        poller::run_status(status_handle, status, codex_status, status_settings).await;
    });

    // Servidor de hooks de Claude Code.
    let hook_state = hook_server::HookState {
        app: app.clone(),
        sessions: app.state::<SharedSessions>().inner().clone(),
        requests: app.state::<SharedAgentRequests>().inner().clone(),
    };

    // Migrate old curl hooks and install newly supported lifecycle events.
    // The repair functions only replace BurnClaw-owned entries.
    commands::ensure_hooks_current(track_claude, track_codex);
    tauri::async_runtime::spawn(hook_server::start_server(hook_state));

    Ok(())
}

/// Cuerpo normalizado que el forwarder de Codex envía al hook server.
#[derive(serde::Serialize)]
struct CodexForwardEvent {
    event_type: &'static str,
    provider: &'static str,
    session_id: Option<String>,
    cwd: Option<String>,
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
    let session_id = v
        .get("thread-id")
        .and_then(|id| id.as_str())
        .map(|s| s.to_string());
    let cwd = v
        .get("cwd")
        .and_then(|cwd| cwd.as_str())
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
        session_id,
        cwd,
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

fn hook_owner_pid(provider: &str) -> Option<u32> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let mut pid = get_current_pid().ok()?;
    for _ in 0..12 {
        let process = system.process(pid)?;
        let parent_pid = process.parent()?;
        let parent = system.process(parent_pid)?;
        let name = parent.name().to_string_lossy().to_ascii_lowercase();
        let command = parent
            .cmd()
            .iter()
            .map(|part| part.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        let matches = match provider {
            "claude" => {
                name == "claude"
                    || name == "claude.exe"
                    || command.contains("@anthropic-ai/claude-code")
            }
            "codex" => name == "codex" || name == "codex.exe" || command.contains("@openai/codex"),
            _ => false,
        };
        if matches {
            return Some(parent_pid.as_u32());
        }
        pid = parent_pid;
    }
    None
}

/// Native lifecycle-hook bridge shared by Claude and Codex. Ordinary events
/// never write stdout; only an intentional hook decision is relayed.
fn try_hook_forward() -> Option<i32> {
    let args: Vec<_> = std::env::args().collect();
    let (provider, endpoint) = if args.iter().any(|arg| arg == "--claude-hook") {
        ("claude", "http://127.0.0.1:9876/event/claude")
    } else if args.iter().any(|arg| arg == "--codex-hook") {
        ("codex", "http://127.0.0.1:9876/event/codex")
    } else {
        return None;
    };

    let mut payload = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut payload) {
        logging::hook_bridge_error(&format!(
            "could not read {} hook input: {}",
            provider, error
        ));
        return Some(0);
    }
    let mut parsed = match serde_json::from_str::<serde_json::Value>(&payload) {
        Ok(value) => value,
        Err(error) => {
            logging::hook_bridge_error(&format!("invalid {} hook JSON: {}", provider, error));
            return Some(0);
        }
    };

    let Some(object) = parsed.as_object_mut() else {
        logging::hook_bridge_error(&format!("invalid {} hook object", provider));
        return Some(0);
    };
    object.insert("provider".into(), serde_json::json!(provider));
    if let Some(owner_pid) = hook_owner_pid(provider) {
        object.insert("owner_pid".into(), serde_json::json!(owner_pid));
    }
    let payload = match serde_json::to_string(&parsed) {
        Ok(payload) => payload,
        Err(error) => {
            logging::hook_bridge_error(&format!("could not encode {} hook: {}", provider, error));
            return Some(0);
        }
    };

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            logging::hook_bridge_error(&format!(
                "could not start {} hook bridge: {}",
                provider, error
            ));
            return Some(0);
        }
    };

    Some(runtime.block_on(async move {
        let client = reqwest::Client::new();
        let mut attempt = 0;
        let response = loop {
            match client
                .post(endpoint)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(payload.clone())
                .timeout(std::time::Duration::from_secs(305))
                .send()
                .await
            {
                Ok(response) => break response,
                Err(error) if error.is_connect() && attempt < 11 => {
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
                Err(error) => {
                    logging::hook_bridge_error(&format!(
                        "{} event skipped because BurnClaw was unavailable: {}",
                        provider, error
                    ));
                    // Monitoring must never break or clutter the Codex session.
                    return 0;
                }
            }
        };

        if !response.status().is_success() {
            logging::hook_bridge_error(&format!(
                "{} event rejected by BurnClaw ({})",
                provider,
                response.status()
            ));
            return 0;
        }

        let body = match response.text().await {
            Ok(body) => body,
            Err(error) => {
                logging::hook_bridge_error(&format!(
                    "could not read the {} hook response: {}",
                    provider, error
                ));
                return 0;
            }
        };
        let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
        if parsed.get("hookSpecificOutput").is_some() {
            println!("{}", body);
        }
        0
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(exit_code) = try_hook_forward() {
        std::process::exit(exit_code);
    }

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
    let codex_status_state = CodexStatusState(Arc::new(Mutex::new(None)));
    let force_refresh: ForceRefresh = Arc::new(Notify::new());
    let notification_state: SharedNotificationState =
        Arc::new(Mutex::new(NotificationState::new()));
    let last_window_pos: LastWindowPos = Arc::new(Mutex::new(None));
    let settings: SharedSettings = Arc::new(Mutex::new(SetupState::load()));
    let sessions: SharedSessions = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let agent_requests: SharedAgentRequests =
        Arc::new(Mutex::new(std::collections::HashMap::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(usage_state)
        .manage(codex_usage_state)
        .manage(status_state)
        .manage(codex_status_state)
        .manage(force_refresh)
        .manage(notification_state)
        .manage(last_window_pos)
        .manage(settings)
        .manage(sessions)
        .manage(agent_requests)
        .invoke_handler(tauri::generate_handler![
            commands::get_current_usage,
            commands::get_current_codex_usage,
            commands::check_codex_credentials,
            commands::get_codex_plan,
            commands::get_current_status,
            commands::get_current_codex_status,
            commands::get_agent_sessions,
            commands::dismiss_agent_session,
            commands::get_pending_agent_requests,
            commands::respond_to_agent_request,
            commands::show_settings,
            commands::hide_settings,
            commands::resize_shell_window,
            commands::cursor_position,
            commands::force_refresh,
            commands::check_credentials,
            commands::run_claude_login,
            commands::run_codex_login,
            commands::cancel_provider_login,
            commands::refresh_oauth_token,
            commands::check_hooks_status,
            commands::install_hooks,
            commands::remove_hooks,
            commands::check_codex_hooks_status,
            commands::install_codex_hooks,
            commands::remove_codex_hooks,
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
