use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State};

use crate::anthropic::UsageSnapshot;
use crate::credentials;
use crate::setup_state::SetupState;
use crate::status::StatusSnapshot;
use crate::{ForceRefresh, SharedStatus, SharedUsage};

/// Marca distintiva de los hooks de BurnClaw dentro de settings.json.
const HOOK_MARKER: &str = "127.0.0.1:9876";
/// Comando que ejecuta cada hook: reenvía el JSON del evento por stdin.
const HOOK_CMD: &str = "curl -s --max-time 1 -X POST http://127.0.0.1:9876/event -H \"Content-Type: application/json\" -d @-";

// ---------------------------------------------------------------------------
// Datos cacheados para el frontend
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_current_usage(state: State<'_, SharedUsage>) -> Option<UsageSnapshot> {
    state.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_current_status(state: State<'_, SharedStatus>) -> Option<StatusSnapshot> {
    state.lock().unwrap().clone()
}

/// Fuerza un fetch inmediato de uso (mismo mecanismo que "Refresh now" del
/// menú del tray): despierta al poller de su sleep.
#[tauri::command]
pub fn force_refresh(notify: State<'_, ForceRefresh>) {
    notify.notify_one();
}

/// Redimensiona la ventana principal al tamaño dado (logical px), manteniendo
/// la esquina inferior-derecha fija. El frontend la llama al expandir/colapsar
/// para que la ventana siga al contenido: pequeña cuando es pill (arrastrable
/// a cualquier sitio), grande cuando es widget.
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
    if delta_x == 0 && delta_y == 0 {
        return Ok(());
    }

    win.set_size(PhysicalSize::new(
        target_w.max(1) as u32,
        target_h.max(1) as u32,
    ))
    .map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(
        cur_pos.x + delta_x,
        cur_pos.y + delta_y,
    ))
    .map_err(|e| e.to_string())?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Setup wizard — credenciales
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CredentialsCheck {
    pub state: String, // "ok" | "missing" | "expired"
    pub subscription_type: Option<String>,
    pub expires_in_seconds: Option<i64>,
}

#[tauri::command]
pub fn check_credentials() -> CredentialsCheck {
    match credentials::load() {
        Ok(oauth) => {
            // expires_at viene en milisegundos Unix.
            let now_ms = chrono::Utc::now().timestamp_millis();
            let expires_in = (oauth.expires_at - now_ms) / 1000;
            CredentialsCheck {
                state: "ok".into(),
                subscription_type: Some(oauth.subscription_type),
                expires_in_seconds: Some(expires_in.max(0)),
            }
        }
        Err(credentials::CredentialsError::Expired) => CredentialsCheck {
            state: "expired".into(),
            subscription_type: None,
            expires_in_seconds: Some(0),
        },
        Err(_) => CredentialsCheck {
            state: "missing".into(),
            subscription_type: None,
            expires_in_seconds: None,
        },
    }
}

/// Abre `claude login` en una terminal nueva de Windows (queda abierta con /k).
#[tauri::command]
pub fn run_claude_login() -> Result<(), String> {
    Command::new("cmd")
        .args(["/c", "start", "cmd", "/k", "claude", "login"])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// STUB — el refresh OAuth real es Fase 3C. Por ahora `claude login` en otra
/// terminal ya refresca el archivo y `check_credentials` lo releerá de disco.
#[tauri::command]
pub fn refresh_oauth_token() -> Result<(), String> {
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
fn hook_entry(with_matcher: bool) -> serde_json::Value {
    let inner = serde_json::json!([{
        "type": "command",
        "command": HOOK_CMD,
        "timeout": 5
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
    ("PostToolUse", true),
    ("Notification", false),
    ("Stop", false),
    ("SubagentStop", false),
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
    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let count = serde_json::to_string(&json)
        .map(|s| s.matches(HOOK_MARKER).count() as u32)
        .unwrap_or(0);
    Ok(HooksCheck {
        installed: count > 0,
        hook_count: count,
    })
}

#[tauri::command]
pub fn install_hooks() -> Result<(), String> {
    let path = settings_path()?;

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
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
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
        let already = arr.iter().any(|entry| {
            serde_json::to_string(entry)
                .map(|s| s.contains(HOOK_MARKER))
                .unwrap_or(false)
        });
        if !already {
            arr.push(hook_entry(*with_matcher));
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
                arr.retain(|entry| {
                    !serde_json::to_string(entry)
                        .map(|s| s.contains(HOOK_MARKER))
                        .unwrap_or(false)
                });
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
/// de setup y arranca el modo normal de la app.
#[tauri::command]
pub fn complete_setup(
    auto_start: bool,
    polling_interval_secs: u64,
    app: AppHandle,
) -> Result<(), String> {
    set_auto_start(auto_start)?;

    let setup = SetupState {
        completed: true,
        auto_start,
        polling_interval_secs,
    };
    setup.save().map_err(|e| e.to_string())?;

    if let Some(win) = app.get_webview_window("setup") {
        win.close().map_err(|e| e.to_string())?;
    }

    crate::init_tray_and_pill(&app).map_err(|e| e.to_string())?;
    Ok(())
}

/// Cierra la app por completo (botón X del wizard).
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}
