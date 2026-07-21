use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(not(windows))]
use tauri::{PhysicalPosition, PhysicalSize};

use crate::agent_requests::{self, AgentRequestInfo, AgentResponse, SharedAgentRequests};
use crate::anthropic::UsageSnapshot;
use crate::codex::{self, CodexUsageSnapshot};
use crate::credentials;
use crate::logging;
use crate::sessions::{self, AgentSession, SharedSessions};
use crate::setup_state::SetupState;
use crate::status::StatusSnapshot;
use crate::{
    CodexStatusState, ForceRefresh, SharedCodexUsage, SharedSettings, SharedStatus, SharedUsage,
};

/// Marca distintiva de los hooks de BurnClaw dentro de settings.json.
const CLAUDE_HOOK_MARKER: &str = "--claude-hook";
const LEGACY_CLAUDE_HOOK_MARKER: &str = "127.0.0.1:9876/event";
/// Comando que ejecuta cada hook: reenvía el JSON del evento por stdin.
/// Marker used by BurnClaw's own lightweight Codex hook forwarder.
const CODEX_HOOK_MARKER: &str = "--codex-hook";
const LEGACY_CODEX_HOOK_MARKER: &str = "127.0.0.1:9876/event/codex";

// ---------------------------------------------------------------------------
// Datos cacheados para el frontend
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_current_usage(state: State<'_, SharedUsage>) -> Option<UsageSnapshot> {
    state.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_current_codex_usage(state: State<'_, SharedCodexUsage>) -> Option<CodexUsageSnapshot> {
    state.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_current_status(state: State<'_, SharedStatus>) -> Option<StatusSnapshot> {
    state.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_current_codex_status(state: State<'_, CodexStatusState>) -> Option<StatusSnapshot> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_agent_sessions(state: State<'_, SharedSessions>) -> Vec<AgentSession> {
    sessions::list(state.inner())
}

#[tauri::command]
pub fn dismiss_agent_session(
    id: String,
    app: AppHandle,
    sessions_state: State<'_, SharedSessions>,
    requests_state: State<'_, SharedAgentRequests>,
) -> bool {
    for request_id in agent_requests::expire_session(requests_state.inner(), &id) {
        let _ = app.emit(
            "agent-request-resolved",
            serde_json::json!({ "id": request_id }),
        );
    }
    let removed = sessions::dismiss(sessions_state.inner(), &id);
    if removed {
        let _ = app.emit("agent-session-removed", serde_json::json!({ "id": id }));
    }
    removed
}

#[tauri::command]
pub fn get_pending_agent_requests(state: State<'_, SharedAgentRequests>) -> Vec<AgentRequestInfo> {
    agent_requests::list(state.inner())
}

#[tauri::command]
pub fn respond_to_agent_request(
    request_id: String,
    action: String,
    answers: Option<HashMap<String, String>>,
    app: AppHandle,
    requests_state: State<'_, SharedAgentRequests>,
    sessions_state: State<'_, SharedSessions>,
) -> Result<(), String> {
    let permission_suggestions =
        agent_requests::take_suggestion(requests_state.inner(), &request_id);
    let request = agent_requests::respond(
        requests_state.inner(),
        &request_id,
        AgentResponse {
            action,
            answers,
            permission_suggestions,
        },
    )?;
    if let Some(session) = sessions::resume(sessions_state.inner(), &request.session_id) {
        let _ = app.emit("agent-session-updated", session);
    }
    let _ = app.emit(
        "agent-request-resolved",
        serde_json::json!({ "id": request_id }),
    );
    Ok(())
}

#[tauri::command]
pub fn show_settings(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or("settings window missing")?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    let _ = app.emit_to("settings", "settings-reopened", ());
    Ok(())
}

#[tauri::command]
pub fn hide_settings(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or("settings window missing")?;
    window.hide().map_err(|error| error.to_string())
}

/// Estado de la cuenta de Codex para el wizard / Settings: si hay login
/// ChatGPT utilizable, solo API key (sin cuota de plan), o nada.
#[derive(Serialize)]
pub struct CodexCredentialsCheck {
    pub state: String, // "ok" | "api_key_only" | "missing"
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub cli_installed: bool,
    pub cli_path: Option<String>,
}

/// Plan de Codex ("plus", "pro"…) consultando wham/usage (solo lectura, no
/// consume cuota). Lo usa el wizard, donde el poller aún no corre y el plan no
/// está en auth.json.
#[tauri::command]
pub async fn get_codex_plan() -> Option<String> {
    codex::fetch_usage().await.ok().and_then(|u| u.plan_type)
}

#[tauri::command]
pub fn check_codex_credentials() -> CodexCredentialsCheck {
    let cli_path = resolve_cli_path("codex");
    let cli_installed = cli_path.is_some();
    let cli_path = cli_path.map(|path| path.display().to_string());
    match codex::load_raw() {
        Ok(auth) if auth.access_token().is_some() => CodexCredentialsCheck {
            state: "ok".into(),
            account_id: auth.account_id(),
            email: auth.email(),
            cli_installed,
            cli_path,
        },
        Ok(auth) if auth.openai_api_key.is_some() => CodexCredentialsCheck {
            state: "api_key_only".into(),
            account_id: None,
            email: None,
            cli_installed,
            cli_path,
        },
        _ => CodexCredentialsCheck {
            state: "missing".into(),
            account_id: None,
            email: None,
            cli_installed,
            cli_path,
        },
    }
}

/// Fuerza un fetch inmediato de uso (mismo mecanismo que "Refresh now" del
/// menú del tray): despierta al poller de su sleep.
#[tauri::command]
pub fn force_refresh(notify: State<'_, ForceRefresh>) {
    notify.notify_one();
}

/// Redimensiona la ventana principal al tamaño dado (logical px), manteniendo
/// fijo el punto de anclaje SUPERIOR-CENTRAL. El frontend la llama al
/// expandir/colapsar para que la ventana siga al contenido: pequeña cuando es
/// pill, grande cuando es widget — creciendo hacia abajo y centrada.
#[tauri::command]
pub fn resize_shell_window(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or("main window missing")?;

    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let target_w = (width * scale).round() as i32;
    let target_h = (height * scale).round() as i32;

    let cur_size = win.outer_size().map_err(|e| e.to_string())?;
    let cur_pos = win.outer_position().map_err(|e| e.to_string())?;

    let delta_x = cur_size.width as i32 - target_w;
    let delta_y = cur_size.height as i32 - target_h;
    // On Windows, size and position must change in the same compositor frame.
    // Tauri's set_size + set_position are two separate Win32 operations and a
    // transparent always-on-top window visibly flashes between them.
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{
            CreateRoundRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ, HRGN,
        };
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

        unsafe fn delete_region(region: HRGN) {
            if !region.0.is_null() {
                let _ = DeleteObject(HGDIOBJ(region.0));
            }
        }

        // El HWND conserva siempre el ancho expandido para que el WebView no
        // haga un reflow horizontal al terminar el collapse. En compacto se
        // recorta a los 400 px centrales y los márgenes no bloquean clics.
        // El recorte nativo replica las esquinas inferiores de CSS. Dejar el
        // HWND rectangular expone el fondo de WebView2 cuando pierde el foco.
        unsafe fn apply_notch_region(
            hwnd: HWND,
            window_width: i32,
            window_height: i32,
            scale: f64,
        ) -> Result<(), String> {
            let logical_height = window_height as f64 / scale;
            let compact = logical_height <= 30.5;
            let logical_radius = if compact { 13.0 } else { 16.0 };
            let radius = (logical_radius * scale).round().max(1.0) as i32;
            let horizontal_inset = if compact {
                (((window_width as f64 / scale) - 400.0) * 0.5 * scale)
                    .round()
                    .max(0.0) as i32
            } else {
                0
            };
            // Extender el round-rect por encima del HWND conserva rectas las
            // esquinas superiores y recorta únicamente las inferiores.
            let body = CreateRoundRectRgn(
                horizontal_inset,
                -radius,
                window_width - horizontal_inset + 1,
                window_height + 1,
                radius * 2,
                radius * 2,
            );
            if body.0.is_null() {
                delete_region(body);
                return Err("failed to create native notch region".into());
            }

            // On success Windows owns `body`; it must not be deleted here.
            if SetWindowRgn(hwnd, Some(body), true) == 0 {
                delete_region(body);
                return Err("SetWindowRgn failed".into());
            }
            Ok(())
        }

        let hwnd = win.hwnd().map_err(|e| e.to_string())?;
        let target_x = cur_pos.x + delta_x / 2;
        if delta_x != 0 || delta_y != 0 {
            unsafe {
                SetWindowPos(
                    hwnd,
                    None,
                    target_x,
                    cur_pos.y,
                    target_w.max(1),
                    target_h.max(1),
                    SWP_NOACTIVATE | SWP_NOZORDER,
                )
            }
            .map_err(|e| e.to_string())?;
        }
        unsafe {
            apply_notch_region(hwnd, target_w.max(1), target_h.max(1), scale)?;
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        if delta_x == 0 && delta_y == 0 {
            return Ok(());
        }
        win.set_size(PhysicalSize::new(
            target_w.max(1) as u32,
            target_h.max(1) as u32,
        ))
        .map_err(|e| e.to_string())?;
        // Solo se reposiciona si cambió el ancho (para mantener fijo el centro
        // horizontal hay que mover la ventana media diferencia de ancho). En el
        // caso normal solo varía el alto: `set_size` ya mantiene fija la esquina
        // superior-izquierda, así que NO se toca la posición — el resize queda
        // atómico y no hay flick. set_size + set_position no lo son.
        if delta_x != 0 {
            win.set_position(PhysicalPosition::new(cur_pos.x + delta_x / 2, cur_pos.y))
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }
}

/// Posición global del cursor en píxeles físicos. La usa el frontend para
/// detectar cuándo el cursor vuelve sobre el shell mientras la ventana ignora
/// eventos de ratón (click-through en los márgenes transparentes de la pill):
/// al ignorarlos, el webview deja de recibir `mousemove`, así que la reentrada
/// solo se puede detectar sondeando la posición real del cursor.
#[tauri::command]
pub fn cursor_position(app: AppHandle) -> Result<(f64, f64), String> {
    let pos = app.cursor_position().map_err(|e| e.to_string())?;
    Ok((pos.x, pos.y))
}

// ---------------------------------------------------------------------------
// Setup wizard — credenciales
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CredentialsCheck {
    pub state: String, // "ok" | "missing" | "expired"
    pub subscription_type: Option<String>,
    pub expires_in_seconds: Option<i64>,
    pub cli_installed: bool,
    pub cli_path: Option<String>,
}

#[tauri::command]
pub fn check_credentials() -> CredentialsCheck {
    let cli_path = resolve_cli_path("claude");
    let cli_installed = cli_path.is_some();
    let cli_path = cli_path.map(|path| path.display().to_string());
    match credentials::load() {
        Ok(oauth) => {
            // expires_at viene en milisegundos Unix.
            let now_ms = chrono::Utc::now().timestamp_millis();
            let expires_in = (oauth.expires_at - now_ms) / 1000;
            CredentialsCheck {
                state: "ok".into(),
                subscription_type: Some(oauth.subscription_type),
                expires_in_seconds: Some(expires_in.max(0)),
                cli_installed,
                cli_path,
            }
        }
        Err(credentials::CredentialsError::Expired) => CredentialsCheck {
            state: "expired".into(),
            subscription_type: None,
            expires_in_seconds: Some(0),
            cli_installed,
            cli_path,
        },
        Err(_) => CredentialsCheck {
            state: "missing".into(),
            subscription_type: None,
            expires_in_seconds: None,
            cli_installed,
            cli_path,
        },
    }
}

struct LoginProcess {
    pid: u32,
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

static CLAUDE_LOGIN_PROCESS: OnceLock<Mutex<Option<LoginProcess>>> = OnceLock::new();
static CODEX_LOGIN_PROCESS: OnceLock<Mutex<Option<LoginProcess>>> = OnceLock::new();

fn login_slot(provider: &str) -> Result<&'static Mutex<Option<LoginProcess>>, String> {
    match provider {
        "claude" => Ok(CLAUDE_LOGIN_PROCESS.get_or_init(|| Mutex::new(None))),
        "codex" => Ok(CODEX_LOGIN_PROCESS.get_or_init(|| Mutex::new(None))),
        _ => Err(format!("unknown provider: {provider}")),
    }
}

fn path_executable(name: &str) -> Option<PathBuf> {
    let names = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    } else {
        vec![name.to_string()]
    };

    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path).find_map(|directory| {
            names
                .iter()
                .map(|file| directory.join(file))
                .find(|candidate| candidate.is_file())
        })
    })
}

fn resolve_cli_path(provider: &str) -> Option<PathBuf> {
    if let Some(path) = path_executable(provider) {
        return Some(path);
    }

    let home = dirs::home_dir();
    let app_data = env::var_os("APPDATA").map(PathBuf::from);
    let local_app_data = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let mut candidates = Vec::new();

    match provider {
        "claude" => {
            if let Some(home) = &home {
                candidates.push(home.join(".local/bin/claude.exe"));
                candidates.push(home.join(".claude/local/claude.exe"));
            }
            if let Some(app_data) = &app_data {
                candidates.push(app_data.join("npm/claude.cmd"));
            }
        }
        "codex" => {
            if let Some(local_app_data) = &local_app_data {
                candidates.push(local_app_data.join("Programs/OpenAI/Codex/bin/codex.exe"));
            }
            if let Some(home) = &home {
                candidates.push(home.join(".local/bin/codex.exe"));
                candidates.push(home.join(".bun/bin/codex.exe"));
            }
            if let Some(app_data) = &app_data {
                candidates.push(app_data.join("npm/codex.cmd"));
            }
        }
        _ => return None,
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn command_for_cli(path: &Path, arguments: &[&str]) -> Command {
    let is_script = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });

    if is_script {
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/c"]).arg(path).args(arguments);
        command
    } else {
        let mut command = Command::new(path);
        command.args(arguments);
        command
    }
}

#[derive(Serialize)]
pub struct LoginLaunch {
    pub provider: String,
    pub pid: u32,
}

#[derive(Clone, Serialize)]
struct ProviderLoginFinished {
    provider: String,
    pid: u32,
    exit_code: Option<i32>,
    cancelled: bool,
}

fn provider_connected(provider: &str) -> bool {
    match provider {
        "claude" => credentials::load().is_ok(),
        "codex" => codex::load_raw()
            .ok()
            .is_some_and(|auth| auth.access_token().is_some()),
        _ => false,
    }
}

fn spawn_provider_login(app: AppHandle, provider: &str) -> Result<LoginLaunch, String> {
    let path = resolve_cli_path(provider).ok_or_else(|| {
        format!(
            "{} CLI is not installed or could not be found",
            if provider == "claude" {
                "Claude Code"
            } else {
                "Codex"
            }
        )
    })?;
    let arguments: &[&str] = match provider {
        "claude" => &["auth", "login", "--claudeai"],
        "codex" => &["login"],
        _ => return Err(format!("unknown provider: {provider}")),
    };
    let slot = login_slot(provider)?;

    {
        let mut guard = slot.lock().map_err(|error| error.to_string())?;
        if let Some(existing) = guard.as_ref() {
            let running = existing
                .child
                .lock()
                .map_err(|error| error.to_string())?
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none();
            if running {
                return Ok(LoginLaunch {
                    provider: provider.to_string(),
                    pid: existing.pid,
                });
            }
        }
        *guard = None;
    }

    let mut command = command_for_cli(&path, arguments);
    #[cfg(windows)]
    command.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE

    let child = command
        .spawn()
        .map_err(|error| format!("failed to start {}: {error}", path.display()))?;
    let pid = child.id();
    let child = Arc::new(Mutex::new(child));
    let cancelled = Arc::new(AtomicBool::new(false));

    {
        let mut guard = slot.lock().map_err(|error| error.to_string())?;
        *guard = Some(LoginProcess {
            pid,
            child: Arc::clone(&child),
            cancelled: Arc::clone(&cancelled),
        });
    }

    let provider_name = provider.to_string();
    thread::spawn(move || {
        // Give the invoke response time to reach the webview before an
        // immediately-failing CLI can emit its completion event.
        thread::sleep(Duration::from_millis(350));
        let exit_code = loop {
            let result = child
                .lock()
                .map_err(|error| error.to_string())
                .and_then(|mut child| child.try_wait().map_err(|error| error.to_string()));
            match result {
                Ok(Some(status)) => break status.code(),
                Ok(None) => thread::sleep(Duration::from_millis(250)),
                Err(error) => {
                    logging::app(&format!("failed to monitor {provider_name} login: {error}"));
                    break None;
                }
            }
        };

        if let Ok(mut guard) = slot.lock() {
            if guard.as_ref().is_some_and(|process| process.pid == pid) {
                *guard = None;
            }
        }

        let _ = app.emit_to(
            "setup",
            "provider-login-finished",
            ProviderLoginFinished {
                provider: provider_name.clone(),
                pid,
                exit_code,
                cancelled: cancelled.load(Ordering::Relaxed),
            },
        );

        if provider_connected(&provider_name) {
            logging::app(&format!("{provider_name} login completed"));
        } else {
            logging::app(&format!("{provider_name} login closed without credentials"));
        }
    });

    Ok(LoginLaunch {
        provider: provider.to_string(),
        pid,
    })
}

/// Opens the official Claude Code browser login in a monitored console.
#[tauri::command]
pub fn run_claude_login(app: AppHandle) -> Result<LoginLaunch, String> {
    spawn_provider_login(app, "claude")
}

/// Opens the official Codex browser login in a monitored console.
#[tauri::command]
pub fn run_codex_login(app: AppHandle) -> Result<LoginLaunch, String> {
    spawn_provider_login(app, "codex")
}

#[tauri::command]
pub fn cancel_provider_login(provider: String) -> Result<bool, String> {
    let slot = login_slot(&provider)?;
    let process = slot.lock().map_err(|error| error.to_string())?.take();
    let Some(process) = process else {
        return Ok(false);
    };

    process.cancelled.store(true, Ordering::Relaxed);
    let mut child = process.child.lock().map_err(|error| error.to_string())?;
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        child.kill().map_err(|error| error.to_string())?;
    }
    Ok(true)
}

/// Refresca el token OAuth contra el endpoint de Claude Code y reescribe
/// `.credentials.json` (con backup `.bak`). Lo usa el botón "Refresh token" del
/// wizard cuando detecta el token caducado.
#[tauri::command]
pub async fn refresh_oauth_token() -> Result<(), String> {
    let oauth = credentials::load_raw().map_err(|e| e.to_string())?;
    credentials::refresh_token(&oauth)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Setup wizard — hooks de Claude Code
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct HooksCheck {
    pub installed: bool,
    pub hook_count: u32,
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("home_dir unavailable")?
        .join(".claude")
        .join("settings.json"))
}

/// Entrada de hook para un evento. PreToolUse/PostToolUse llevan matcher "*".
fn is_burnclaw_claude_hook(entry: &serde_json::Value) -> bool {
    serde_json::to_string(entry)
        .map(|value| {
            value.contains(CLAUDE_HOOK_MARKER) || value.contains(LEGACY_CLAUDE_HOOK_MARKER)
        })
        .unwrap_or(false)
}

fn claude_hook_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy();
    if exe.contains('"') {
        return Err("BurnClaw executable path contains an unsupported quote".into());
    }
    Ok(format!("\"{}\" {}", exe, CLAUDE_HOOK_MARKER))
}

fn hook_entry(with_matcher: bool, command: &str) -> serde_json::Value {
    let inner = serde_json::json!([{
        "type": "command",
        "command": command,
        "timeout": 310
    }]);
    if with_matcher {
        serde_json::json!({ "matcher": "*", "hooks": inner })
    } else {
        serde_json::json!({ "hooks": inner })
    }
}

/// Eventos del lifecycle de Claude Code que registra BurnClaw, y si el evento
/// soporta `matcher`.
const HOOK_EVENTS: &[(&str, bool)] = &[
    ("SessionStart", false),
    ("UserPromptSubmit", false),
    ("PreToolUse", true),
    ("PermissionRequest", true),
    ("PostToolUse", true),
    ("PostToolUseFailure", true),
    ("PermissionDenied", true),
    ("Notification", true),
    ("Stop", false),
    ("SubagentStart", false),
    ("SubagentStop", false),
    ("SessionEnd", false),
];

#[tauri::command]
pub fn check_hooks_status() -> Result<HooksCheck, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(HooksCheck {
            installed: false,
            hook_count: 0,
        });
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let count = json
        .get("hooks")
        .and_then(|hooks| hooks.as_object())
        .map(|hooks| {
            hooks
                .values()
                .filter_map(|entries| entries.as_array())
                .flat_map(|entries| entries.iter())
                .filter(|entry| is_burnclaw_claude_hook(entry))
                .count() as u32
        })
        .unwrap_or(0);
    Ok(HooksCheck {
        installed: count > 0 && claude_hooks_are_current().unwrap_or(false),
        hook_count: count,
    })
}

#[tauri::command]
pub fn install_hooks() -> Result<(), String> {
    let path = settings_path()?;
    let command = claude_hook_command()?;

    // Backup si existe; si no, asegurar el directorio.
    if path.exists() {
        let backup = path.with_extension("json.bak");
        std::fs::copy(&path, &backup).map_err(|e| e.to_string())?;
    } else if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Leer el JSON existente o crear uno vacío.
    let mut json: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content)
            .map_err(|e| format!("settings.json no es JSON válido: {}", e))?
    } else {
        serde_json::json!({})
    };

    let obj = json
        .as_object_mut()
        .ok_or("settings.json no es un objeto JSON")?;
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    let hooks_obj = hooks
        .as_object_mut()
        .ok_or("la clave 'hooks' de settings.json no es un objeto")?;

    for (event, with_matcher) in HOOK_EVENTS {
        let arr = hooks_obj
            .entry(*event)
            .or_insert_with(|| serde_json::json!([]));
        let arr = arr
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{} no es un array", event))?;
        // Idempotente: no duplicar si BurnClaw ya está registrado en el evento.
        let existing = arr.iter().position(is_burnclaw_claude_hook);
        if let Some(index) = existing {
            // Actualiza instalaciones de BurnClaw 1.x (timeout corto y sin
            // respuesta) al puente interactivo 2.0 sin tocar hooks ajenos.
            arr[index] = hook_entry(*with_matcher, &command);
        } else {
            arr.push(hook_entry(*with_matcher, &command));
        }
    }

    std::fs::write(
        &path,
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_hooks() -> Result<(), String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(());
    }
    let backup = path.with_extension("json.bak");
    std::fs::copy(&path, &backup).map_err(|e| e.to_string())?;

    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("settings.json no es JSON válido: {}", e))?;

    // Quitar SOLO las entradas de BurnClaw (detectadas por la marca), dejando
    // intactos los hooks que el usuario tuviera por su cuenta.
    if let Some(hooks_obj) = json.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for entries in hooks_obj.values_mut() {
            if let Some(arr) = entries.as_array_mut() {
                arr.retain(|entry| !is_burnclaw_claude_hook(entry));
            }
        }
    }

    std::fs::write(
        &path,
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Integración de Codex — clave `notify` en ~/.codex/config.toml
// ---------------------------------------------------------------------------
// Legacy fallback from early BurnClaw 2.0 previews. Native lifecycle hooks are
// now preferred; these commands remain so existing installs can be migrated
// without deleting an unrelated user-defined notify command.

// Native Codex lifecycle hooks live in ~/.codex/hooks.json. They supersede
// BurnClaw's legacy notify integration below and preserve unrelated hooks.
fn codex_hooks_path() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home).join("hooks.json"));
        }
    }
    Ok(dirs::home_dir()
        .ok_or("home_dir unavailable")?
        .join(".codex")
        .join("hooks.json"))
}

fn is_burnclaw_codex_hook(entry: &serde_json::Value) -> bool {
    serde_json::to_string(entry)
        .map(|value| value.contains(CODEX_HOOK_MARKER) || value.contains(LEGACY_CODEX_HOOK_MARKER))
        .unwrap_or(false)
}

fn codex_hook_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy();
    if exe.contains('"') {
        return Err("BurnClaw executable path contains an unsupported quote".into());
    }
    Ok(format!("\"{}\" {}", exe, CODEX_HOOK_MARKER))
}

fn codex_hook_entry(with_matcher: bool, command: &str) -> serde_json::Value {
    let handler = serde_json::json!({
        "type": "command",
        "command": command,
        "commandWindows": command,
        "timeout": 310,
        "statusMessage": "Syncing live activity with BurnClaw"
    });
    if with_matcher {
        serde_json::json!({ "matcher": ".*", "hooks": [handler] })
    } else {
        serde_json::json!({ "hooks": [handler] })
    }
}

const CODEX_HOOK_EVENTS: &[(&str, bool)] = &[
    ("SessionStart", false),
    ("UserPromptSubmit", false),
    ("PreToolUse", true),
    ("PermissionRequest", true),
    ("PostToolUse", true),
    ("PreCompact", false),
    ("PostCompact", false),
    ("Stop", false),
    ("SubagentStart", false),
    ("SubagentStop", false),
];

fn hook_entry_uses_command(
    entry: &serde_json::Value,
    expected_command: &str,
    require_windows_command: bool,
) -> bool {
    entry
        .get("hooks")
        .and_then(|value| value.as_array())
        .is_some_and(|handlers| {
            handlers.iter().any(|handler| {
                let command_matches = handler.get("command").and_then(|value| value.as_str())
                    == Some(expected_command);
                let windows_matches = !require_windows_command
                    || handler
                        .get("commandWindows")
                        .and_then(|value| value.as_str())
                        == Some(expected_command);
                command_matches && windows_matches
            })
        })
}

fn claude_hooks_are_current() -> Result<bool, String> {
    let expected_command = claude_hook_command()?;
    let path = settings_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let Some(hooks) = json.get("hooks").and_then(|value| value.as_object()) else {
        return Ok(false);
    };
    Ok(HOOK_EVENTS.iter().all(|(event, _)| {
        hooks
            .get(*event)
            .and_then(|value| value.as_array())
            .is_some_and(|entries| {
                entries.iter().any(|entry| {
                    is_burnclaw_claude_hook(entry)
                        && hook_entry_uses_command(entry, &expected_command, false)
                })
            })
    }))
}

fn codex_hooks_are_current() -> Result<bool, String> {
    let expected_command = codex_hook_command()?;
    let path = codex_hooks_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let Some(hooks) = json.get("hooks").and_then(|value| value.as_object()) else {
        return Ok(false);
    };
    Ok(CODEX_HOOK_EVENTS.iter().all(|(event, _)| {
        hooks
            .get(*event)
            .and_then(|value| value.as_array())
            .is_some_and(|entries| {
                entries.iter().any(|entry| {
                    is_burnclaw_codex_hook(entry)
                        && hook_entry_uses_command(entry, &expected_command, true)
                })
            })
    }))
}

/// Upgrade only BurnClaw-owned entries after an app update. User hooks remain
/// untouched and current configurations are not rewritten on every startup.
pub fn ensure_hooks_current(track_claude: bool, track_codex: bool) {
    if track_claude && !claude_hooks_are_current().unwrap_or(false) {
        if let Err(error) = install_hooks() {
            logging::app(&format!("could not repair Claude hooks: {}", error));
        }
    }
    if track_codex && !codex_hooks_are_current().unwrap_or(false) {
        if let Err(error) = install_codex_hooks() {
            logging::app(&format!("could not repair Codex hooks: {}", error));
        }
    }
}

#[tauri::command]
pub fn check_codex_hooks_status() -> Result<HooksCheck, String> {
    let path = codex_hooks_path()?;
    if !path.exists() {
        return Ok(HooksCheck {
            installed: false,
            hook_count: 0,
        });
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let count = json
        .get("hooks")
        .and_then(|hooks| hooks.as_object())
        .map(|hooks| {
            hooks
                .values()
                .filter_map(|entries| entries.as_array())
                .flat_map(|entries| entries.iter())
                .filter(|entry| is_burnclaw_codex_hook(entry))
                .count() as u32
        })
        .unwrap_or(0);
    Ok(HooksCheck {
        installed: count > 0 && codex_hooks_are_current().unwrap_or(false),
        hook_count: count,
    })
}

#[tauri::command]
pub fn install_codex_hooks() -> Result<(), String> {
    let path = codex_hooks_path()?;
    let command = codex_hook_command()?;
    if path.exists() {
        std::fs::copy(&path, path.with_extension("json.bak")).map_err(|e| e.to_string())?;
    } else if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut json: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content)
            .map_err(|e| format!("hooks.json is not valid JSON: {}", e))?
    } else {
        serde_json::json!({
            "description": "User-level lifecycle hooks. BurnClaw entries are managed independently.",
            "hooks": {}
        })
    };

    let root = json
        .as_object_mut()
        .ok_or("hooks.json must contain a JSON object")?;
    let hooks = root.entry("hooks").or_insert_with(|| serde_json::json!({}));
    let hooks_obj = hooks
        .as_object_mut()
        .ok_or("the hooks key must contain an object")?;

    for (event, with_matcher) in CODEX_HOOK_EVENTS {
        let entries = hooks_obj
            .entry(*event)
            .or_insert_with(|| serde_json::json!([]));
        let entries = entries
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{} must contain an array", event))?;
        let existing = entries.iter().position(is_burnclaw_codex_hook);
        if let Some(index) = existing {
            entries[index] = codex_hook_entry(*with_matcher, &command);
        } else {
            entries.push(codex_hook_entry(*with_matcher, &command));
        }
    }

    std::fs::write(
        &path,
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    // Remove only BurnClaw's legacy notify entry to avoid duplicate events.
    let _ = remove_codex_notify();
    Ok(())
}

#[tauri::command]
pub fn remove_codex_hooks() -> Result<(), String> {
    let path = codex_hooks_path()?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::copy(&path, path.with_extension("json.bak")).map_err(|e| e.to_string())?;
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("hooks.json is not valid JSON: {}", e))?;
    if let Some(hooks_obj) = json.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for entries in hooks_obj.values_mut() {
            if let Some(entries) = entries.as_array_mut() {
                entries.retain(|entry| !is_burnclaw_codex_hook(entry));
            }
        }
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Marca que identifica la entrada de BurnClaw dentro de config.toml.
const CODEX_NOTIFY_MARKER: &str = "--codex-notify";

fn codex_config_path() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home).join("config.toml"));
        }
    }
    Ok(dirs::home_dir()
        .ok_or("home_dir unavailable")?
        .join(".codex")
        .join("config.toml"))
}

/// ¿Es una asignación de la clave raíz `notify`? (p. ej. `notify = [...]`).
fn is_notify_line(line: &str) -> bool {
    line.trim_start()
        .strip_prefix("notify")
        .map(|rest| rest.trim_start().starts_with('='))
        .unwrap_or(false)
}

#[derive(Serialize)]
pub struct CodexNotifyCheck {
    pub installed: bool,
}

#[tauri::command]
pub fn check_codex_notify() -> CodexNotifyCheck {
    let installed = codex_config_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|c| c.contains(CODEX_NOTIFY_MARKER))
        .unwrap_or(false);
    CodexNotifyCheck { installed }
}

#[tauri::command]
pub fn install_codex_notify() -> Result<(), String> {
    let path = codex_config_path()?;
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();

    let existing = if path.exists() {
        let backup = path.with_extension("toml.bak");
        std::fs::copy(&path, &backup).map_err(|e| e.to_string())?;
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        String::new()
    };

    // `notify` debe ir en la raíz, antes de cualquier tabla: se quita la que
    // hubiera y se antepone la nuestra. Strings TOML literales (comillas
    // simples) para no escapar los backslashes de la ruta de Windows.
    let cleaned: Vec<&str> = existing.lines().filter(|l| !is_notify_line(l)).collect();
    let line = format!("notify = ['{}', '{}']", exe, CODEX_NOTIFY_MARKER);
    let rest = cleaned.join("\n");
    let content = if rest.trim().is_empty() {
        format!("{}\n", line)
    } else {
        format!("{}\n{}\n", line, rest.trim_start_matches('\n'))
    };
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_codex_notify() -> Result<(), String> {
    let path = codex_config_path()?;
    if !path.exists() {
        return Ok(());
    }
    let backup = path.with_extension("toml.bak");
    std::fs::copy(&path, &backup).map_err(|e| e.to_string())?;
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Quitar solo la línea de BurnClaw (la que lleva el marcador).
    let cleaned: Vec<&str> = content
        .lines()
        .filter(|l| !(is_notify_line(l) && l.contains(CODEX_NOTIFY_MARKER)))
        .collect();
    std::fs::write(&path, cleaned.join("\n")).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Setup wizard — preferencias y cierre
// ---------------------------------------------------------------------------

/// Auto-arranque con Windows vía la clave Run del registro.
#[tauri::command]
pub fn set_auto_start(enabled: bool) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = hkcu
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|e| e.to_string())?;

    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        run_key
            .set_value("BurnClaw", &exe.to_string_lossy().to_string())
            .map_err(|e| e.to_string())?;
    } else {
        let _ = run_key.delete_value("BurnClaw");
    }
    Ok(())
}

/// Cierra el wizard: aplica auto-start, guarda SetupState, cierra la ventana
/// de setup y arranca el modo normal de la app. El wizard solo controla 3
/// campos; el resto de ajustes conservan sus valores (defaults en primer
/// arranque), y se editan luego desde la ventana de Settings.
#[tauri::command]
pub fn complete_setup(
    auto_start: bool,
    polling_interval_secs: u64,
    track_claude: bool,
    track_codex: bool,
    app: AppHandle,
    shared: State<'_, SharedSettings>,
) -> Result<(), String> {
    set_auto_start(auto_start)?;

    let setup = {
        let mut s = shared.lock().unwrap();
        s.completed = true;
        s.auto_start = auto_start;
        s.polling_interval_secs = polling_interval_secs;
        s.providers_chosen = true;
        s.track_claude = track_claude;
        s.track_codex = track_codex;
        s.clone()
    };
    setup.save().map_err(|e| e.to_string())?;

    // Se oculta (no se cierra) para poder reabrirlo desde el menú "Settings".
    if let Some(win) = app.get_webview_window("setup") {
        win.hide().map_err(|e| e.to_string())?;
    }

    crate::init_tray_and_pill(&app).map_err(|e| e.to_string())?;
    // Al terminar el wizard, se muestra la pill directamente.
    crate::tray::show_main_window(&app);
    let _ = app.emit_to("main", "setup-completed", ());
    Ok(())
}

/// Cierra la app por completo (botón X del wizard).
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Settings window — leer/guardar/reset ajustes y abrir logs
// ---------------------------------------------------------------------------

/// Devuelve los ajustes vivos actuales (los que ve la ventana de Settings al
/// abrirse).
#[tauri::command]
pub fn get_settings(shared: State<'_, SharedSettings>) -> SetupState {
    shared.lock().unwrap().clone()
}

/// Guarda los ajustes: persiste a disco, actualiza el estado compartido (que
/// el poller y notifications releen en vivo), aplica auto-start y avisa a la
/// ventana principal para que aplique los toggles visuales. `completed` se
/// conserva del estado actual — la ventana de Settings no lo toca.
#[tauri::command]
pub fn save_settings(
    mut new_settings: SetupState,
    app: AppHandle,
    shared: State<'_, SharedSettings>,
) -> Result<(), String> {
    new_settings.completed = shared.lock().unwrap().completed;

    new_settings.save().map_err(|e| e.to_string())?;
    set_auto_start(new_settings.auto_start)?;

    *shared.lock().unwrap() = new_settings.clone();

    // La ventana principal aplica pill_activity / console_banner al vuelo.
    let _ = app.emit_to("main", "settings-changed", new_settings);
    logging::app("settings saved");
    Ok(())
}

/// Restablece todo: borra setup.json, vuelve el estado compartido a defaults y
/// reabre el wizard (ocultando settings y la ventana principal).
#[tauri::command]
pub fn reset_settings(app: AppHandle, shared: State<'_, SharedSettings>) -> Result<(), String> {
    if let Ok(path) = SetupState::path() {
        let _ = std::fs::remove_file(path);
    }
    *shared.lock().unwrap() = SetupState::defaults();

    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    logging::app("settings reset — reopening wizard");
    Ok(())
}

/// Abre la carpeta de datos de BurnClaw (donde viven app.log, hooks.log y
/// setup.json) en el Explorador de Windows.
#[tauri::command]
pub fn open_logs_folder() -> Result<(), String> {
    let dir = logging::dir().ok_or("logs folder unavailable")?;
    Command::new("explorer")
        .arg(dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_command_check_rejects_an_old_executable_path() {
        let current = r#""C:\Program Files\BurnClaw\burnclaw.exe" --codex-hook"#;
        let stale = r#""C:\work\burnclaw\target\debug\burnclaw.exe" --codex-hook"#;
        let entry = serde_json::json!({
            "hooks": [{
                "type": "command",
                "command": stale,
                "commandWindows": stale
            }]
        });

        assert!(!hook_entry_uses_command(&entry, current, true));
    }

    #[test]
    fn hook_command_check_accepts_the_current_windows_command() {
        let current = r#""C:\Program Files\BurnClaw\burnclaw.exe" --codex-hook"#;
        let entry = serde_json::json!({
            "hooks": [{
                "type": "command",
                "command": current,
                "commandWindows": current
            }]
        });

        assert!(hook_entry_uses_command(&entry, current, true));
    }
}
