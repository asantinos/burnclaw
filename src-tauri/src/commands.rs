use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State};

use crate::anthropic::UsageSnapshot;
use crate::status::StatusSnapshot;
use crate::{ForceRefresh, SharedStatus, SharedUsage};

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
    // delta > 0 al encoger: se mueve la esquina sup-izq hacia abajo-derecha
    // para que la esquina inferior-derecha (el contenido visible) no se mueva.
    win.set_position(PhysicalPosition::new(
        cur_pos.x + delta_x,
        cur_pos.y + delta_y,
    ))
    .map_err(|e| e.to_string())?;

    Ok(())
}
