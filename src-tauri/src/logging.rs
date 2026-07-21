use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use chrono::Local;

/// Carpeta de datos de BurnClaw (%APPDATA%/burnclaw). También donde vive
/// setup.json. Pública para el comando "Open logs folder".
pub fn dir() -> Option<PathBuf> {
    let mut path = dirs::config_dir()?;
    path.push("burnclaw");
    std::fs::create_dir_all(&path).ok()?;
    Some(path)
}

fn write_line(file: &str, msg: &str) {
    let Some(mut path) = dir() else {
        return;
    };
    path.push(file);
    let line = format!("[{}] {}\n", Local::now().format("%Y-%m-%d %H:%M:%S"), msg);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Log general de la aplicación → app.log
pub fn app(msg: &str) {
    // En `tauri dev` también sale por consola; en release no hay consola.
    eprintln!("{}", msg);
    write_line("app.log", msg);
}

/// Log de eventos de hooks de Claude Code → hooks.log
pub fn hook(msg: &str) {
    write_line("hooks.log", msg);
}

/// Diagnostic emitted by short-lived hook bridge processes. Unlike `app`, it
/// intentionally writes only to disk: stderr from a hook is surfaced by Codex
/// and would make an unavailable widget look like an agent failure.
pub fn hook_bridge_error(msg: &str) {
    write_line("hooks.log", &format!("bridge error: {}", msg));
}
