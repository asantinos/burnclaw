use chrono::{DateTime, Utc};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition,
};

use crate::{ForceRefresh, SharedCodexUsage, SharedUsage};

const TRAY_ID: &str = "burnclaw-tray";
const WINDOW_LABEL: &str = "main";
/// Separación entre el borde superior de la pantalla y la ventana.
const TOP_MARGIN: i32 = 0;

const IDLE_PNG: &[u8] = include_bytes!("../icons/tray/idle.png");
const OK_PNG: &[u8] = include_bytes!("../icons/tray/ok.png");
const WARN_PNG: &[u8] = include_bytes!("../icons/tray/warn.png");
const ORANGE_PNG: &[u8] = include_bytes!("../icons/tray/orange.png");
const DANGER_PNG: &[u8] = include_bytes!("../icons/tray/danger.png");

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let refresh_item = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&refresh_item, &settings_item, &quit_item])?;

    let idle_icon = Image::from_bytes(IDLE_PNG)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(idle_icon)
        .tooltip("BurnClaw — loading…")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "refresh" => {
                if let Some(notify) = app.try_state::<ForceRefresh>() {
                    notify.notify_one();
                }
            }
            "settings" => {
                // Abre la ventana de Settings (vive oculta, no se destruye).
                if let Some(win) = app.get_webview_window("settings") {
                    let _ = win.show();
                    let _ = win.set_focus();
                    let _ = app.emit_to("settings", "settings-reopened", ());
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Click izquierdo en el tray: alterna la visibilidad de la única ventana.
/// El morph pill <-> widget es interno (CSS), aquí solo se muestra/oculta.
/// Se recuerda la posición al ocultar y se restaura al volver a mostrar.
fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        // Guarda la posición actual antes de ocultar.
        let _ = window.hide();
    } else {
        show_main_window(app);
    }
}

/// Muestra la ventana principal (pill): restaura la última posición o la
/// coloca arriba-centro la primera vez. La usa el toggle del tray y también
/// `complete_setup` al cerrar el wizard.
pub fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    position_top_center(&window);
    let _ = window.show();
    // El frontend vuelve al estado colapsado (pill).
    let _ = app.emit_to(WINDOW_LABEL, "window-shown", ());
}

/// Si el tray icon ya existe, la app ya está en modo normal (idempotencia
/// de `init_tray_and_pill`, que puede llamarse de nuevo desde `complete_setup`).
pub fn is_initialized(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

/// Coloca la ventana arriba-centro del monitor primario.
fn position_top_center(window: &tauri::WebviewWindow) {
    let win_size = match window.outer_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let mpos = monitor.position();
        let msize = monitor.size();
        let x = mpos.x + (msize.width as i32 - win_size.width as i32) / 2;
        let y = mpos.y + TOP_MARGIN;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

/// Actualiza icono + tooltip del tray a partir del estado compartido de AMBOS
/// proveedores. El color lo manda el % máximo entre todos los presentes; el
/// tooltip lista una línea por proveedor activo + el reset más próximo.
pub fn update_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("tray icon not found")?;

    let claude = app
        .try_state::<SharedUsage>()
        .map(|s| s.lock().unwrap().clone())
        .flatten();
    let codex = app
        .try_state::<SharedCodexUsage>()
        .map(|s| s.lock().unwrap().clone())
        .flatten();

    let mut max_pct = 0.0_f64;
    let mut lines: Vec<String> = Vec::new();

    // Reset opcional formateado entre paréntesis (vacío si no hay dato).
    let paren = |reset: Option<DateTime<Utc>>| {
        reset
            .map(|r| format!(" ({})", format_countdown(&r)))
            .unwrap_or_default()
    };

    // El tooltip del tray de Windows tiene límite de caracteres, así que solo
    // muestra la ventana de 5h. El color del icono sí considera ambas ventanas
    // (max_pct) para no perder el aviso de la semanal.
    if let Some(c) = &claude {
        max_pct = max_pct.max(c.session_5h_pct).max(c.weekly_pct);
        lines.push(format!(
            "Claude · 5h {}%{}",
            c.session_5h_pct.round() as i64,
            paren(Some(c.session_5h_reset_at)),
        ));
    }
    if let Some(x) = &codex {
        for pct in [x.session_5h_pct, x.weekly_pct].into_iter().flatten() {
            max_pct = max_pct.max(pct);
        }
        let visible = x
            .session_5h_pct
            .map(|pct| ("5h", pct, x.session_5h_reset_at))
            .or_else(|| x.weekly_pct.map(|pct| ("7d", pct, x.weekly_reset_at)));
        if let Some((label, pct, reset)) = visible {
            lines.push(format!(
                "Codex · {} {}%{}",
                label,
                pct.round() as i64,
                paren(reset),
            ));
        }
    }

    // Sin datos aún: dejar el icono idle del arranque.
    if lines.is_empty() {
        return Ok(());
    }

    let image = Image::from_bytes(icon_bytes_for_pct(max_pct))?;
    tray.set_icon(Some(image))?;
    tray.set_tooltip(Some(lines.join("\n")))?;

    Ok(())
}

pub fn format_countdown(reset: &DateTime<Utc>) -> String {
    let secs = reset.signed_duration_since(Utc::now()).num_seconds().max(0);
    let d = secs / 86400;
    let h = (secs % 86400) / 3600;
    let m = (secs % 3600) / 60;
    if d > 0 {
        format!("{}d {}h", d, h)
    } else if h > 0 {
        format!("{}h {}m", h, m)
    } else if m > 0 {
        format!("{}m", m)
    } else {
        "<1m".to_string()
    }
}

fn icon_bytes_for_pct(pct: f64) -> &'static [u8] {
    if pct >= 95.0 {
        DANGER_PNG
    } else if pct >= 80.0 {
        ORANGE_PNG
    } else if pct >= 50.0 {
        WARN_PNG
    } else {
        OK_PNG
    }
}
