// Game Mode Auto-Hide: Automatically hides Omi when playing specified games
// or full-screen apps, and restores Omi to the foreground upon exit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
extern "system" {
    fn GetCurrentProcess() -> isize;
    fn SetPriorityClass(hProcess: isize, dwPriorityClass: u32) -> i32;
    fn SetProcessWorkingSetSize(hProcess: isize, dwMinimumWorkingSetSize: usize, dwMaximumWorkingSetSize: usize) -> i32;
}

#[cfg(windows)]
const IDLE_PRIORITY_CLASS: u32 = 0x00000040;
#[cfg(windows)]
const NORMAL_PRIORITY_CLASS: u32 = 0x00000020;

static WAS_HIDDEN_BY_GAME: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
fn get_foreground_app() -> Option<(String, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::core::PWSTR;

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }

        // 1. Get window title directly via HWND (works even if anti-cheat blocks OpenProcess)
        let text_len = GetWindowTextLengthW(hwnd);
        let mut title = String::new();
        if text_len > 0 {
            let mut title_buf = vec![0u16; (text_len + 1) as usize];
            let read_len = GetWindowTextW(hwnd, &mut title_buf);
            if read_len > 0 {
                title = String::from_utf16_lossy(&title_buf[..read_len as usize]);
            }
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == std::process::id() {
            return None;
        }

        let mut exe_name = String::new();

        // 2. Try standard OpenProcess
        if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                let path = String::from_utf16_lossy(&buf[..len as usize]);
                if let Some(stem) = std::path::Path::new(&path).file_stem() {
                    exe_name = stem.to_string_lossy().to_string();
                }
            }
            let _ = CloseHandle(process);
        }

        // 3. If OpenProcess was blocked (e.g. by Riot Vanguard, EAC, BattlEye), fallback to Toolhelp Snapshot
        if exe_name.is_empty() {
            if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                let mut entry = PROCESSENTRY32W {
                    dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                    ..Default::default()
                };
                if Process32FirstW(snap, &mut entry).is_ok() {
                    loop {
                        if entry.th32ProcessID == pid {
                            let end = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                            let fname = String::from_utf16_lossy(&entry.szExeFile[..end]);
                            if let Some(stem) = std::path::Path::new(&fname).file_stem() {
                                exe_name = stem.to_string_lossy().to_string();
                            }
                            break;
                        }
                        if Process32NextW(snap, &mut entry).is_err() {
                            break;
                        }
                    }
                }
                let _ = CloseHandle(snap);
            }
        }

        if exe_name.is_empty() && title.is_empty() {
            return None;
        }

        Some((exe_name.to_lowercase(), title.to_lowercase()))
    }
}

#[cfg(not(windows))]
fn get_foreground_app() -> Option<(String, String)> {
    crate::flow::os::foreground_app()
}

pub fn spawn_game_mode_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            let sleep_ms = if WAS_HIDDEN_BY_GAME.load(Ordering::Relaxed) { 1500 } else { 800 };
            std::thread::sleep(Duration::from_millis(sleep_ms));

            let settings = match app.try_state::<crate::Shared>() {
                Some(shared) => match shared.settings.lock() {
                    Ok(guard) => guard.clone(),
                    Err(_) => continue,
                },
                None => continue,
            };

            if !settings.game_mode_enabled || settings.game_mode_apps.is_empty() {
                if WAS_HIDDEN_BY_GAME.swap(false, Ordering::Relaxed) {
                    if let Some(win) = app.get_webview_window(crate::island::WINDOW_LABEL) {
                        let _ = win.show();
                    }
                }
                continue;
            }

            let Some((fg_exe, fg_title)) = get_foreground_app() else {
                continue;
            };

            let fg_clean_exe = fg_exe.strip_suffix(".exe").unwrap_or(&fg_exe).trim().to_lowercase();
            let fg_clean_title = fg_title.trim().to_lowercase();

            // Never hide if the foreground app is Omi itself
            if fg_clean_exe.contains("coucou") || fg_clean_exe.contains("omi") {
                continue;
            }

            // Check if current foreground matches any enabled game/app
            let is_game = settings.game_mode_apps.iter().any(|app_def| {
                if !app_def.enabled {
                    return false;
                }
                let id_raw = app_def.id.trim().to_lowercase();
                let id_clean = id_raw.strip_suffix(".exe").unwrap_or(&id_raw).trim();
                let name_raw = app_def.name.trim().to_lowercase();
                let name_clean = name_raw.strip_suffix(".exe").unwrap_or(&name_raw).trim();

                // 1. Executable name matches configured ID or name
                (!id_clean.is_empty() && (fg_clean_exe.contains(id_clean) || id_clean.contains(&fg_clean_exe)))
                    // 2. Window title matches configured name or ID
                    || (!name_clean.is_empty() && (fg_clean_title.contains(name_clean) || fg_clean_exe.contains(name_clean)))
                    || (!id_clean.is_empty() && fg_clean_title.contains(id_clean))
                    // 3. Dedicated Valorant match: if id or name mentions valorant, match any valorant process or window
                    || ((id_clean.contains("valorant") || name_clean.contains("valorant"))
                        && (fg_clean_exe.contains("valorant") || fg_clean_title.contains("valorant")))
            });

            if is_game {
                if !WAS_HIDDEN_BY_GAME.swap(true, Ordering::Relaxed) {
                    crate::log::line(format!(
                        "game_mode: active game detected (exe: '{fg_clean_exe}', title: '{fg_clean_title}'), entering deep game standby"
                    ));
                    // 1. Hide all windows (drops DWM composition & GPU swapchains)
                    if let Some(win) = app.get_webview_window(crate::island::WINDOW_LABEL) {
                        let _ = win.hide();
                    }
                    if let Some(win) = app.get_webview_window("desktop_mochi") {
                        let _ = win.hide();
                    }
                    if let Some(win) = app.get_webview_window(crate::HUB_LABEL) {
                        let _ = win.hide();
                    }

                    // 2. Notify island frontend
                    let _ = app.emit_to(crate::island::WINDOW_LABEL, "game-mode-hide", ());

                    // 3. Unload heavy neural models from RAM
                    crate::speech::unload();

                    // 4. Stop background cursor polling gates
                    if let Some(shared) = app.try_state::<crate::Shared>() {
                        shared.gate.set_active(false);
                    }

                    // 5. Windows kernel: Drop Omi priority to IDLE so the game has 100% CPU priority,
                    // and purge working set pages from RAM
                    #[cfg(windows)]
                    unsafe {
                        let proc = GetCurrentProcess();
                        SetPriorityClass(proc, IDLE_PRIORITY_CLASS);
                        SetProcessWorkingSetSize(proc, usize::MAX, usize::MAX);
                    }
                }
            } else if WAS_HIDDEN_BY_GAME.swap(false, Ordering::Relaxed) {
                crate::log::line(format!(
                    "game_mode: game exited (current: '{fg_clean_exe}'), restoring Omi to normal priority and foreground"
                ));
                #[cfg(windows)]
                unsafe {
                    let proc = GetCurrentProcess();
                    SetPriorityClass(proc, NORMAL_PRIORITY_CLASS);
                }

                if let Some(shared) = app.try_state::<crate::Shared>() {
                    shared.gate.set_active(true);
                }

                if let Some(win) = app.get_webview_window(crate::island::WINDOW_LABEL) {
                    let _ = win.show();
                }
                if let Some(win) = app.get_webview_window("desktop_mochi") {
                    let _ = win.show();
                }

                let _ = app.emit_to(crate::island::WINDOW_LABEL, "game-mode-restore", ());
            }
        }
    });
}
