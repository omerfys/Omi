//! Omi Computer Use Skill Engine
//! High-performance, native OS-level desktop automation for Windows.
//! Implements mouse control, keyboard input with full Unicode support,
//! window inspection, screen metrics, and coordinate-based action execution.

use serde::{Deserialize, Serialize};
use std::thread::sleep;
use std::time::Duration;

#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
    MOUSEEVENTF_HWHEEL, MOUSEINPUT, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN,
    VK_ESCAPE, VK_F1, VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7,
    VK_F8, VK_F9, VK_HOME, VK_END, VK_LEFT, VK_LMENU, VK_LWIN, VK_PRIOR, VK_NEXT,
    VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextW,
    SM_CXSCREEN, SM_CYSCREEN,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenMetrics {
    pub width: i32,
    pub height: i32,
    pub cursor_x: i32,
    pub cursor_y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindowDetails {
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ComputerAction {
    Click {
        x: Option<i32>,
        y: Option<i32>,
        button: Option<String>,
    },
    DoubleClick {
        x: Option<i32>,
        y: Option<i32>,
    },
    RightClick {
        x: Option<i32>,
        y: Option<i32>,
    },
    Move {
        x: i32,
        y: i32,
        smooth: Option<bool>,
    },
    Drag {
        from_x: i32,
        from_y: i32,
        to_x: i32,
        to_y: i32,
    },
    Scroll {
        amount: i32,
        horizontal: Option<bool>,
    },
    Type {
        text: String,
        delay_ms: Option<u64>,
    },
    Key {
        key: String,
    },
    Hotkey {
        keys: Vec<String>,
    },
    GetScreenMetrics,
    GetActiveWindow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActionResult {
    pub success: bool,
    pub message: String,
    pub metrics: Option<ScreenMetrics>,
    pub window: Option<ActiveWindowDetails>,
}

#[cfg(windows)]
pub fn get_screen_metrics() -> ScreenMetrics {
    let (mut cx, mut cy) = (0, 0);
    unsafe {
        let mut pt = windows::Win32::Foundation::POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            cx = pt.x;
            cy = pt.y;
        }
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        ScreenMetrics {
            width: w,
            height: h,
            cursor_x: cx,
            cursor_y: cy,
        }
    }
}

#[cfg(not(windows))]
pub fn get_screen_metrics() -> ScreenMetrics {
    ScreenMetrics {
        width: 1920,
        height: 1080,
        cursor_x: 0,
        cursor_y: 0,
    }
}

#[cfg(windows)]
pub fn get_active_window() -> Option<ActiveWindowDetails> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..len as usize]);

        let mut rect = windows::Win32::Foundation::RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);

        Some(ActiveWindowDetails {
            title,
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        })
    }
}

#[cfg(not(windows))]
pub fn get_active_window() -> Option<ActiveWindowDetails> {
    None
}

#[cfg(windows)]
fn move_cursor_abs(x: i32, y: i32) {
    let sm = get_screen_metrics();
    if sm.width <= 0 || sm.height <= 0 {
        return;
    }
    let norm_x = ((x as f64 / sm.width as f64) * 65535.0) as i32;
    let norm_y = ((y as f64 / sm.height as f64) * 65535.0) as i32;

    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: norm_x,
                dy: norm_y,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(windows)]
fn mouse_click_raw(flags_down: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS, flags_up: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS) {
    let down = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: flags_down,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let up = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: flags_up,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(windows)]
fn type_unicode_char(c: char) {
    let mut utf16_buf = [0u16; 2];
    let encoded = c.encode_utf16(&mut utf16_buf);

    for &mut code in encoded {
        let down = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: code,
                    dwFlags: KEYEVENTF_UNICODE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let up = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: code,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe {
            SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32);
        }
    }
}

#[cfg(windows)]
fn key_name_to_vk(name: &str) -> Option<VIRTUAL_KEY> {
    match name.to_lowercase().as_str() {
        "enter" | "return" => Some(VK_RETURN),
        "tab" => Some(VK_TAB),
        "esc" | "escape" => Some(VK_ESCAPE),
        "backspace" => Some(VK_BACK),
        "delete" | "del" => Some(VK_DELETE),
        "space" => Some(VK_SPACE),
        "up" => Some(VK_UP),
        "down" => Some(VK_DOWN),
        "left" => Some(VK_LEFT),
        "right" => Some(VK_RIGHT),
        "home" => Some(VK_HOME),
        "end" => Some(VK_END),
        "pageup" | "pgup" => Some(VK_PRIOR),
        "pagedown" | "pgdn" => Some(VK_NEXT),
        "ctrl" | "control" => Some(VK_CONTROL),
        "shift" => Some(VK_SHIFT),
        "alt" => Some(VK_LMENU),
        "win" | "windows" | "cmd" | "meta" => Some(VK_LWIN),
        "f1" => Some(VK_F1),
        "f2" => Some(VK_F2),
        "f3" => Some(VK_F3),
        "f4" => Some(VK_F4),
        "f5" => Some(VK_F5),
        "f6" => Some(VK_F6),
        "f7" => Some(VK_F7),
        "f8" => Some(VK_F8),
        "f9" => Some(VK_F9),
        "f10" => Some(VK_F10),
        "f11" => Some(VK_F11),
        "f12" => Some(VK_F12),
        s if s.len() == 1 => {
            let ch = s.chars().next().unwrap().to_ascii_uppercase();
            if ch.is_ascii_alphanumeric() {
                Some(VIRTUAL_KEY(ch as u16))
            } else {
                None
            }
        }
        _ => None,
    }
}

#[cfg(windows)]
fn send_vk_event(vk: VIRTUAL_KEY, keyup: bool) {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if keyup {
        flags |= KEYEVENTF_KEYUP;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

#[tauri::command]
pub async fn execute_computer_action(action: ComputerAction) -> Result<ComputerActionResult, String> {
    tokio::task::spawn_blocking(move || -> Result<ComputerActionResult, String> {
        #[cfg(windows)]
        {
            match action {
                ComputerAction::Click { x, y, button } => {
                    if let (Some(x), Some(y)) = (x, y) {
                        move_cursor_abs(x, y);
                        sleep(Duration::from_millis(30));
                    }
                    let btn = button.as_deref().unwrap_or("left");
                    match btn {
                        "right" => mouse_click_raw(MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                        "middle" => mouse_click_raw(MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                        _ => mouse_click_raw(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                    }
                    let sm = get_screen_metrics();
                    Ok(ComputerActionResult {
                        success: true,
                        message: format!("Clicked {} at ({}, {})", btn, sm.cursor_x, sm.cursor_y),
                        metrics: Some(sm),
                        window: None,
                    })
                }
                ComputerAction::DoubleClick { x, y } => {
                    if let (Some(x), Some(y)) = (x, y) {
                        move_cursor_abs(x, y);
                        sleep(Duration::from_millis(30));
                    }
                    mouse_click_raw(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP);
                    sleep(Duration::from_millis(80));
                    mouse_click_raw(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP);
                    let sm = get_screen_metrics();
                    Ok(ComputerActionResult {
                        success: true,
                        message: format!("Double clicked at ({}, {})", sm.cursor_x, sm.cursor_y),
                        metrics: Some(sm),
                        window: None,
                    })
                }
                ComputerAction::RightClick { x, y } => {
                    if let (Some(x), Some(y)) = (x, y) {
                        move_cursor_abs(x, y);
                        sleep(Duration::from_millis(30));
                    }
                    mouse_click_raw(MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP);
                    let sm = get_screen_metrics();
                    Ok(ComputerActionResult {
                        success: true,
                        message: format!("Right clicked at ({}, {})", sm.cursor_x, sm.cursor_y),
                        metrics: Some(sm),
                        window: None,
                    })
                }
                ComputerAction::Move { x, y, smooth } => {
                    let smooth = smooth.unwrap_or(true);
                    if smooth {
                        let cur = get_screen_metrics();
                        let steps = 12;
                        for i in 1..=steps {
                            let t = i as f64 / steps as f64;
                            let cur_x = cur.cursor_x as f64 + (x as f64 - cur.cursor_x as f64) * t;
                            let cur_y = cur.cursor_y as f64 + (y as f64 - cur.cursor_y as f64) * t;
                            move_cursor_abs(cur_x as i32, cur_y as i32);
                            sleep(Duration::from_millis(10));
                        }
                    } else {
                        move_cursor_abs(x, y);
                    }
                    let sm = get_screen_metrics();
                    Ok(ComputerActionResult {
                        success: true,
                        message: format!("Moved cursor to ({}, {})", x, y),
                        metrics: Some(sm),
                        window: None,
                    })
                }
                ComputerAction::Drag { from_x, from_y, to_x, to_y } => {
                    move_cursor_abs(from_x, from_y);
                    sleep(Duration::from_millis(40));
                    let down = INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dx: 0,
                                dy: 0,
                                mouseData: 0,
                                dwFlags: MOUSEEVENTF_LEFTDOWN,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    };
                    unsafe { SendInput(&[down], std::mem::size_of::<INPUT>() as i32); }
                    sleep(Duration::from_millis(50));

                    let steps = 20;
                    for i in 1..=steps {
                        let t = i as f64 / steps as f64;
                        let cur_x = from_x as f64 + (to_x as f64 - from_x as f64) * t;
                        let cur_y = from_y as f64 + (to_y as f64 - from_y as f64) * t;
                        move_cursor_abs(cur_x as i32, cur_y as i32);
                        sleep(Duration::from_millis(12));
                    }

                    sleep(Duration::from_millis(40));
                    let up = INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dx: 0,
                                dy: 0,
                                mouseData: 0,
                                dwFlags: MOUSEEVENTF_LEFTUP,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    };
                    unsafe { SendInput(&[up], std::mem::size_of::<INPUT>() as i32); }

                    let sm = get_screen_metrics();
                    Ok(ComputerActionResult {
                        success: true,
                        message: format!("Dragged from ({}, {}) to ({}, {})", from_x, from_y, to_x, to_y),
                        metrics: Some(sm),
                        window: None,
                    })
                }
                ComputerAction::Scroll { amount, horizontal } => {
                    let is_horiz = horizontal.unwrap_or(false);
                    let flag = if is_horiz { MOUSEEVENTF_HWHEEL } else { MOUSEEVENTF_WHEEL };
                    let input = INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dx: 0,
                                dy: 0,
                                mouseData: (amount * 120) as u32,
                                dwFlags: flag,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    };
                    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32); }
                    Ok(ComputerActionResult {
                        success: true,
                        message: format!("Scrolled amount {}", amount),
                        metrics: Some(get_screen_metrics()),
                        window: None,
                    })
                }
                ComputerAction::Type { text, delay_ms } => {
                    let risk = crate::laya::check_computer_use_risk(&text);
                    if risk.is_destructive || risk.risk_score >= 1.6 {
                        crate::log::line(format!(
                            "laya: BLOCKED high-risk computer_use typing: '{}' (score: {:.2})",
                            text, risk.risk_score
                        ));
                        return Err(format!(
                            "Laya Security Gate: Potentially destructive action blocked (risk score: {:.2})",
                            risk.risk_score
                        ));
                    }
                    let delay = delay_ms.unwrap_or(12);
                    for ch in text.chars() {
                        type_unicode_char(ch);
                        if delay > 0 {
                            sleep(Duration::from_millis(delay));
                        }
                    }
                    Ok(ComputerActionResult {
                        success: true,
                        message: format!("Typed {} characters", text.len()),
                        metrics: Some(get_screen_metrics()),
                        window: None,
                    })
                }
                ComputerAction::Key { key } => {
                    if let Some(vk) = key_name_to_vk(&key) {
                        send_vk_event(vk, false);
                        sleep(Duration::from_millis(20));
                        send_vk_event(vk, true);
                        Ok(ComputerActionResult {
                            success: true,
                            message: format!("Pressed key '{}'", key),
                            metrics: Some(get_screen_metrics()),
                            window: None,
                        })
                    } else {
                        Err(format!("Unknown key name: '{}'", key))
                    }
                }
                ComputerAction::Hotkey { keys } => {
                    let mut pressed = Vec::new();
                    for k in &keys {
                        if let Some(vk) = key_name_to_vk(k) {
                            send_vk_event(vk, false);
                            pressed.push(vk);
                            sleep(Duration::from_millis(15));
                        } else {
                            // Release already pressed
                            for p in pressed.iter().rev() {
                                send_vk_event(*p, true);
                            }
                            return Err(format!("Unknown hotkey component: '{}'", k));
                        }
                    }
                    sleep(Duration::from_millis(40));
                    for p in pressed.iter().rev() {
                        send_vk_event(*p, true);
                        sleep(Duration::from_millis(15));
                    }
                    Ok(ComputerActionResult {
                        success: true,
                        message: format!("Triggered hotkey: {}", keys.join("+")),
                        metrics: Some(get_screen_metrics()),
                        window: None,
                    })
                }
                ComputerAction::GetScreenMetrics => {
                    let sm = get_screen_metrics();
                    Ok(ComputerActionResult {
                        success: true,
                        message: format!("Screen: {}x{}, Cursor: ({}, {})", sm.width, sm.height, sm.cursor_x, sm.cursor_y),
                        metrics: Some(sm),
                        window: None,
                    })
                }
                ComputerAction::GetActiveWindow => {
                    let w = get_active_window();
                    let msg = w.as_ref().map(|x| format!("Active window: '{}'", x.title)).unwrap_or_else(|| "No active window".into());
                    Ok(ComputerActionResult {
                        success: true,
                        message: msg,
                        metrics: Some(get_screen_metrics()),
                        window: w,
                    })
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = action;
            Err("Computer action execution is currently supported on Windows.".into())
        }
    }).await.map_err(|e| e.to_string())?
}
