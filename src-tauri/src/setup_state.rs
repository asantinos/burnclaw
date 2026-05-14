use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SetupState {
    pub completed: bool,
    pub auto_start: bool,
    pub polling_interval_secs: u64,
}

impl SetupState {
    pub fn defaults() -> Self {
        Self {
            completed: false,
            auto_start: true,
            polling_interval_secs: 60,
        }
    }

    pub fn path() -> Result<PathBuf, Box<dyn std::error::Error>> {
        let mut path = dirs::config_dir().ok_or("config_dir unavailable")?;
        path.push("burnclaw");
        fs::create_dir_all(&path)?;
        path.push("setup.json");
        Ok(path)
    }

    pub fn load() -> Self {
        match Self::path().and_then(|p| Ok(fs::read_to_string(p)?)) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| Self::defaults()),
            Err(_) => Self::defaults(),
        }
    }

    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let path = Self::path()?;
        fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}
