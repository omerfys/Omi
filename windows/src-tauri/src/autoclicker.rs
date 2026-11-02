//! Omi Autoclicker Engine
//! High-speed, system-aware auto-clicking automation for Windows and desktop environments.
//! Detects existing autoclicker software on the system and launches it;
//! if none exists, launches or creates Omi's native built-in autoclicker mechanism.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

static AUTOCLICKER_RUNNING: AtomicBool = AtomicBool::new(false);
static AUTOCLICKER_CHILD_PID: Mutex<Option<u32>> = Mutex::new(None);

pub const BUILTIN_AUTOCLICKER_PS1: &str = r#"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class MouseClicker {
    [DllImport("user32.dll", CharSet = CharSet.Auto, CallingConvention = CallingConvention.StdCall)]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    private const int MOUSEEVENTF_LEFTDOWN = 0x02;
    private const int MOUSEEVENTF_LEFTUP = 0x04;

    public static void LeftClick() {
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }

    public static bool IsKeyPressed(int vKey) {
        return (GetAsyncKeyState(vKey) & 0x8000) != 0;
    }
}
"@

$stopFlag = Join-Path $PSScriptRoot "autoclicker_stop.flag"
if (Test-Path $stopFlag) { Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue }

# F8 (119) veya ESC (27) ile de anında durdurulabilir
while ($true) {
    if (Test-Path $stopFlag) {
        Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue
        break
    }
    if ([MouseClicker]::IsKeyPressed(119) -or [MouseClicker]::IsKeyPressed(27)) {
        break
    }
    [MouseClicker]::LeftClick()
    Start-Sleep -Milliseconds 50
}
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoclickerStatus {
    pub success: bool,
    pub mode: String, // "existing" or "builtin"
    pub app_name: Option<String>,
    pub message: String,
    pub stop_hint: String,
}

#[cfg(windows)]
pub fn find_existing_autoclicker() -> Option<(String, PathBuf)> {
    // 1. Check running processes first
    let output = std::process::Command::new("powershell")
        .args(&[
            "-NoProfile",
            "-Command",
            "Get-Process | Where-Object { $_.ProcessName -match 'autoclicker|speedautoclicker|opautoclicker|gsautoclicker' } | Select-Object -First 1 -ExpandProperty ProcessName",
        ])
        .output();
    if let Ok(out) = output {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !name.is_empty() {
            return Some((name.clone(), PathBuf::from(format!("{name}.exe"))));
        }
    }

    // 2. Search common locations for known autoclicker executables
    let mut probe_dirs = Vec::new();
    if let Ok(p) = std::env::var("ProgramFiles") {
        probe_dirs.push(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var("ProgramFiles(x86)") {
        probe_dirs.push(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var("LOCALAPPDATA") {
        probe_dirs.push(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var("APPDATA") {
        probe_dirs.push(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var("USERPROFILE") {
        let user = PathBuf::from(p);
        probe_dirs.push(user.join("Desktop"));
        probe_dirs.push(user.join("Downloads"));
    }

    let search_patterns = [
        "opautoclicker.exe",
        "speedautoclicker.exe",
        "autoclicker.exe",
        "auto_clicker.exe",
        "gsautoclicker.exe",
    ];

    for base in &probe_dirs {
        if !base.exists() {
            continue;
        }
        // Direct file in base directory
        for pattern in &search_patterns {
            let candidate = base.join(pattern);
            if candidate.is_file() {
                let name = candidate.file_stem().unwrap_or_default().to_string_lossy().to_string();
                return Some((name, candidate));
            }
        }
        // Check subdirectories 1 level down
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_dir() {
                        let dir_path = entry.path();
                        for pattern in &search_patterns {
                            let candidate = dir_path.join(pattern);
                            if candidate.is_file() {
                                let name = candidate.file_stem().unwrap_or_default().to_string_lossy().to_string();
                                return Some((name, candidate));
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

#[cfg(not(windows))]
pub fn find_existing_autoclicker() -> Option<(String, PathBuf)> {
    None
}

pub fn launch_builtin_clicker(interval_ms: u64) -> Result<AutoclickerStatus, String> {
    let candidates = [
        PathBuf::from("windows/src-tauri/autoclicker.ps1"),
        PathBuf::from("src-tauri/autoclicker.ps1"),
        PathBuf::from("autoclicker.ps1"),
        std::env::temp_dir().join("omi_autoclicker.ps1"),
    ];

    let script_path = candidates.iter().find(|p| p.is_file()).cloned().unwrap_or_else(|| {
        let fallback = std::env::temp_dir().join("omi_autoclicker.ps1");
        let script = if interval_ms != 50 {
            BUILTIN_AUTOCLICKER_PS1.replace("Start-Sleep -Milliseconds 50", &format!("Start-Sleep -Milliseconds {interval_ms}"))
        } else {
            BUILTIN_AUTOCLICKER_PS1.to_string()
        };
        let _ = std::fs::write(&fallback, script);
        fallback
    });

    if let Some(parent) = script_path.parent() {
        let stop_flag = parent.join("autoclicker_stop.flag");
        let _ = std::fs::remove_file(stop_flag);
    }
    let temp_stop_flag = std::env::temp_dir().join("autoclicker_stop.flag");
    let _ = std::fs::remove_file(temp_stop_flag);

    let mut cmd = std::process::Command::new("powershell");
    cmd.args(&[
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        script_path.to_str().unwrap_or("autoclicker.ps1"),
    ]);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = cmd.spawn().map_err(|e| format!("PowerShell autoclicker başlatılamadı: {e}"))?;
    let pid = child.id();
    *AUTOCLICKER_CHILD_PID.lock() = Some(pid);
    AUTOCLICKER_RUNNING.store(true, Ordering::SeqCst);

    Ok(AutoclickerStatus {
        success: true,
        mode: "builtin".to_string(),
        app_name: Some("Omi Yerleşik Autoclicker".to_string()),
        message: format!("Sistemde harici bir autoclicker bulunamadı. Omi'nin yerleşik otomatik tıklayıcısı başarıyla başlatıldı (aralık: {interval_ms}ms)."),
        stop_hint: "Durdurmak için klavyeden F8 veya ESC tuşuna basabilir ya da durdur komutunu verebilirsiniz.".to_string(),
    })
}

pub fn launch_or_create_autoclicker(interval_ms: Option<u64>) -> Result<AutoclickerStatus, String> {
    let interval = interval_ms.unwrap_or(50);
    #[cfg(windows)]
    {
        if let Some((app_name, exe_path)) = find_existing_autoclicker() {
            let is_running_cmd = std::process::Command::new("powershell")
                .args(&[
                    "-NoProfile",
                    "-Command",
                    &format!("Get-Process -Name '{}' -ErrorAction SilentlyContinue", app_name),
                ])
                .output();
            let is_running = is_running_cmd.map(|o| !o.stdout.is_empty()).unwrap_or(false);
            if !is_running && exe_path.exists() {
                let _ = std::process::Command::new(&exe_path).spawn();
            }
            return Ok(AutoclickerStatus {
                success: true,
                mode: "existing".to_string(),
                app_name: Some(app_name.clone()),
                message: format!("Sisteminizde yüklü olan '{}' autoclicker uygulaması tespit edildi ve açıldı.", app_name),
                stop_hint: "Uygulama arayüzünden veya kendi kısayol tuşuyla durdurabilirsiniz.".to_string(),
            });
        }
    }
    launch_builtin_clicker(interval)
}

pub fn stop_autoclicker() -> Result<bool, String> {
    let temp_stop = std::env::temp_dir().join("autoclicker_stop.flag");
    let _ = std::fs::write(&temp_stop, "stop");
    let local_stop = PathBuf::from("windows/src-tauri/autoclicker_stop.flag");
    let _ = std::fs::write(&local_stop, "stop");

    if let Some(pid) = AUTOCLICKER_CHILD_PID.lock().take() {
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(&["/F", "/PID", &pid.to_string()])
                .output();
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
        }
    }
    AUTOCLICKER_RUNNING.store(false, Ordering::SeqCst);
    Ok(true)
}

pub fn is_autoclicker_running() -> bool {
    AUTOCLICKER_RUNNING.load(Ordering::SeqCst)
}
