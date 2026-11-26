use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSessionData {
    pub token: String,
    pub root_key_b64: String,
    pub email_private_key_pkcs8_b64: String,
    pub saved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<CliSessionData>,
}

pub fn resolve_config_dir(override_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(d) = override_dir {
        if !d.is_empty() {
            return Ok(PathBuf::from(d));
        }
    }
    if let Ok(d) = env::var("NONEPWD_CONFIG_DIR") {
        if !d.is_empty() {
            return Ok(PathBuf::from(d));
        }
    }
    if let Ok(xdg) = env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Ok(PathBuf::from(xdg).join("nonepwd"));
        }
    }
    if let Ok(home) = env::var("HOME").or_else(|_| env::var("USERPROFILE")) {
        if !home.is_empty() {
            return Ok(PathBuf::from(home).join(".config").join("nonepwd"));
        }
    }
    Err(
        "Unable to determine config directory: set HOME, XDG_CONFIG_HOME, or NONEPWD_CONFIG_DIR"
            .to_string(),
    )
}

pub fn ensure_config_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        if !dir.exists() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
                .map_err(|e| format!("Failed creating config dir {}: {e}", dir.display()))?;
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Failed setting permissions on {}: {e}", dir.display()))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Failed creating config dir {}: {e}", dir.display()))
    }
}

pub fn load_config(override_dir: Option<&str>) -> CliConfig {
    let Ok(dir) = resolve_config_dir(override_dir) else {
        return CliConfig::default();
    };
    let path = dir.join("config.json");
    let Ok(bytes) = fs::read(path) else {
        return CliConfig::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save_config(cfg: &CliConfig, override_dir: Option<&str>) -> Result<PathBuf, String> {
    let dir = resolve_config_dir(override_dir)?;
    ensure_config_dir(&dir)?;

    let target = dir.join("config.json");
    let tmp = dir.join(format!("config.json.tmp.{}", std::process::id()));
    let json = serde_json::to_vec_pretty(cfg).map_err(|e| format!("Serialize config failed: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("Failed opening temp config file: {e}"))?;
        f.write_all(&json)
            .map_err(|e| format!("Failed writing temp config file: {e}"))?;
        drop(f);
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed setting config permissions: {e}"))?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&tmp, &json).map_err(|e| format!("Failed writing temp config file: {e}"))?;
    }

    fs::rename(&tmp, &target).map_err(|e| format!("Failed saving config file: {e}"))?;
    Ok(target)
}
