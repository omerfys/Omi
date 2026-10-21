// Coucou for Windows — app wiring and the commands the island calls.

mod antigravity;
mod agent_hooks;
mod agents;
mod calendar;
mod chat;
mod claude;
mod codex_plan;
pub mod computer_use;
mod config_file;
mod desktop;
mod files;
mod flow;
mod game_mode;
mod github;
mod hooks;
mod i18n;
mod identity;
mod integrations;
mod island;
pub mod learnings;
mod local_chat;
mod log;
mod net;
mod notes;
mod openai_compat;
mod phone_link;
mod pipe;
mod platform;
#[cfg(target_os = "linux")]
mod portal;
mod recap;
mod secrets;
mod session_window;
mod settings;
mod shortcuts;
mod sounds;
mod speech;
mod spotify;
mod tray;
mod voice;
#[cfg(windows)]
mod webview_drop;
pub mod laya;

use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(windows))]
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_autostart::MacosLauncher;

use chat::{Chat, ChatContext, ChatReply, ModelInfo};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
    autostarted: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    let hooks_status = hooks::status();
    settings.hooks_installed = hooks_status.installed;
    settings.plan_relay_installed = hooks_status.plan_relay_installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
        autostarted: launched_at_login(),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed, shortcuts_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        let shortcuts_changed = current.shortcuts != settings.shortcuts;
        // Where Mochi sits on the desktop is desktop.rs's to say, not a webview's.
        let mut settings = settings.clone();
        settings.desktop_mochi = current.desktop_mochi.clone();
        // Same for the phone link: only its own commands turn it on or off.
        settings.phone_link = current.phone_link;
        settings.phone_chat = current.phone_chat;
        settings.phone_details = current.phone_details;
        settings.phone_answers = current.phone_answers;
        settings.phone_diffs = current.phone_diffs;
        settings.phone_usage = current.phone_usage;
        settings.phone_services = current.phone_services.clone();
        settings.phone_relay = current.phone_relay;
        settings.phone_relay_url = current.phone_relay_url.clone();
        settings.phone_chat_models = current.phone_chat_models.clone();
        *current = settings;
        (screen_changed, autostart_changed, shortcuts_changed)
    };
    let settings = shared.settings.lock().unwrap().clone();
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    if autostart_changed {
        sync_autostart(&app, settings.autostart);
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    integrations::settings_saved(&app, &settings.active_integrations);
    spotify::sync(&app, &settings.active_integrations);
    if shortcuts_changed {
        shortcuts::apply(&app, &settings.shortcuts);
    }
    if i18n::set_picked(&settings.language) {
        language_changed(&app);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// The island reports the system's languages at launch, for "System" in
/// Settings → Language (WebView2 and WebKitGTK know them best).
#[tauri::command]
fn set_system_languages(app: AppHandle, languages: Vec<String>) {
    if i18n::set_system(languages) {
        language_changed(&app);
    }
}

/// What Rust labels itself follows the new language: the tray menu and the
/// settings window's title. The webviews switch on their own.
fn language_changed(app: &AppHandle) {
    tray::retitle(app);
    if let Some(window) = app.get_webview_window(HUB_LABEL) {
        let _ = window.set_title("Omi");
    }
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
    platform::set_pointer_watch(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

/// The panel is laid out in CSS px against the window's own scale. If the webview
/// reports a different devicePixelRatio (it ends up bigger than the window and gets
/// cut), correct its zoom so one CSS px is one logical px again.
#[tauri::command]
fn fit_zoom(app: AppHandle, dpr: f64) -> bool {
    let Some(win) = island::window(&app) else { return false };
    let scale = win.scale_factor().unwrap_or(1.0);
    static ZOOM: std::sync::Mutex<f64> = std::sync::Mutex::new(1.0);
    let mut zoom = ZOOM.lock().unwrap();
    if let Some(new_zoom) = island::calculate_zoom_correction(*zoom, scale, dpr) {
        *zoom = new_zoom;
        log::line(format!("webview dpr {dpr} != window scale {scale} — setting zoom {new_zoom:.3}"));
        let _ = win.set_zoom(new_zoom);
        true
    } else {
        false
    }
}


/// The displays the island can be pinned to, for Settings.
#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<island::MonitorChoice> {
    island::monitor_choices(&app)
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to the file manager otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        platform::reveal_folder(p);
    }
    false
}

/// "Open terminal": brings forward the terminal or editor window the session
/// runs in, when it was found (see session_window.rs); otherwise opens the
/// folder in VS Code, as before.
#[tauri::command]
fn open_session(session_id: Option<String>, path: Option<String>) -> bool {
    let Some(owners) = session_id.as_deref().and_then(session_window::lookup) else {
        return open_in_vscode(path);
    };
    let folder = path.as_deref().map(session_window::folder_name).unwrap_or_default().to_string();
    #[cfg(windows)]
    {
        if platform::focus_session_window(&owners, &folder) {
            return true;
        }
        open_in_vscode(path)
    }
    // Linux asks the display server, KWin or the terminal, which can take a
    // moment: never on the UI thread a sync command runs on. VS Code still
    // opens when none of them could bring the window forward.
    #[cfg(target_os = "linux")]
    {
        std::thread::spawn(move || {
            if !platform::focus_session_window(&owners, &folder) {
                open_in_vscode(path);
            }
        });
        true
    }
}

/// The Claude Desktop pill's target: the Claude app (Windows only — it has no
/// Linux build).
#[tauri::command]
fn open_claude_desktop() -> bool {
    platform::open_claude_desktop()
}

#[tauri::command]
fn open_antigravity(path: Option<String>) -> bool {
    platform::open_antigravity(path.as_deref())
}

#[tauri::command]
fn get_learned_rules() -> Vec<learnings::LearnedRule> {
    learnings::list_rules()
}

#[tauri::command]
fn save_learned_rule(topic: String, rule: String) -> Result<learnings::LearnedRule, String> {
    learnings::add_rule(&topic, &rule)
}

#[tauri::command]
fn delete_learned_rule(id: String) -> Result<bool, String> {
    learnings::remove_rule(&id)
}

/// The file behind a live diff, if it may be handed to the editor: an existing
/// regular file given by its full or relative path.
fn diff_file(path: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(path);
    if p.is_file() {
        return Some(p.to_path_buf());
    }
    // Resolve relative path against current working directory or Desktop
    if let Ok(cwd) = std::env::current_dir() {
        let resolved = cwd.join(p);
        if resolved.is_file() {
            return Some(resolved);
        }
    }
    let desktop = get_desktop_dir().join(p);
    if desktop.is_file() {
        return Some(desktop);
    }
    None
}

/// The diff card's ↗: opens the edited file in VS Code or default editor on Windows.
#[tauri::command]
fn open_file_in_vscode(path: String) -> bool {
    let Some(file) = diff_file(&path) else { return false };
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        cmd.arg(&file);
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg("start").arg("").arg(&file);
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(folder) = file.parent().filter(|d| d.is_dir()) {
        platform::reveal_folder(&folder.to_string_lossy());
        return true;
    }
    false
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Pill ID → whether that agent's hooks reach Coucou. Read-only.
#[tauri::command]
fn agent_hooks_status() -> std::collections::HashMap<String, bool> {
    agent_hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn hooks_auto_install(app: AppHandle, shared: State<Shared>) -> Result<bool, String> {
    let preview = hooks::preview(true)?;
    let _ = hooks::write(true, &preview.fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = true;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(true)
}

#[tauri::command]
fn auto_install_pill_hook(app: AppHandle, shared: State<Shared>, pill_id: String) -> Result<bool, String> {
    if pill_id == "integration_claude" {
        if let Ok(preview) = hooks::preview(true) {
            let _ = hooks::write(true, &preview.fingerprint);
            let updated = {
                let mut current = shared.settings.lock().unwrap();
                current.hooks_installed = true;
                let _ = settings::save(&current);
                current.clone()
            };
            let _ = app.emit("settings-changed", updated);
        }
        return Ok(true);
    }

    let agent_name = pill_id.strip_prefix("agent_").unwrap_or(&pill_id);
    if let Ok(plan) = agents::preview(agent_name, true) {
        let _ = agents::apply(agent_name, true, &plan.fingerprint);
    }
    Ok(true)
}

// ── Other agents' hooks and plugins ──────────────────────────────────────────

#[tauri::command]
fn agent_hooks_list() -> Vec<agents::AgentStatus> {
    agents::list()
}

/// The diff the user has to look at before anything is written.
#[tauri::command]
fn agent_hooks_preview(agent: String, install: bool) -> Result<config_file::Plan, String> {
    agents::preview(&agent, install)
}

/// Only ever called from an explicit click in the settings window, with the
/// fingerprint of the preview the user looked at.
#[tauri::command]
fn agent_hooks_apply(agent: String, install: bool, fingerprint: String) -> Result<String, String> {
    let backups = agents::apply(&agent, install, &fingerprint)?;
    let done = if install { "installed" } else { "removed" };
    log::line(format!("agent hooks {done} for {agent}"));
    Ok(backups)
}

// ── Plan usage ────────────────────────────────────────────────────────────────

/// The diff of putting the plan usage relay into (or taking it out of) the
/// status line, before anything is written.
#[tauri::command]
fn status_line_preview(install: bool) -> Result<HookPreview, String> {
    hooks::status_line_preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn status_line_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    let backup = hooks::status_line_write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.plan_relay_installed = install;
        // As on the Mac: taking the relay out turns the pill off with it.
        if !install {
            current.show_plan_in_notch = false;
        }
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

/// Codex plan usage, asked of the Codex CLI (`codex app-server`) when its pill
/// shows. Off the main thread: it can take a few seconds.
#[tauri::command]
async fn codex_plan_usage() -> Option<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(codex_plan::read).await.ok().flatten()
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    recap::record_decision(&app, &request_id, &decision);
    pipe::answer(&app, &request_id, &decision);
}

/// An option picked on the island for a question Claude Code asked.
#[tauri::command]
fn approval_answer(
    app: AppHandle,
    request_id: String,
    answers: std::collections::HashMap<String, serde_json::Value>,
) {
    // An answered question is not an Allow / Deny: nothing for the recap.
    recap::forget_request(&app, &request_id);
    pipe::answer_question(&app, &request_id, &answers);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    recap::forget_request(&app, &request_id);
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn with the provider picked in the chat view. API keys and any
/// file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
    session_id: Option<String>,
) -> Result<ChatReply, String> {
    let settings = shared.settings.lock().unwrap().clone();
    chat::send(&app, &chat, &settings, query, context, session_id).await
}

/// The models a provider offers, for the picker in the chat view. Only asked
/// once the user picked that provider, and only with its key or address.
#[tauri::command]
async fn chat_models(shared: State<'_, Shared>, provider: String) -> Result<Vec<ModelInfo>, String> {
    let settings = shared.settings.lock().unwrap().clone();
    chat::models(&settings, &provider).await
}

/// Settings → Local models → Connect: does the server answer, and with which models?
#[tauri::command]
async fn local_connect(provider: String, url: String) -> Result<local_chat::Connected, String> {
    local_chat::connect(&provider, &url).await
}

/// Stores the custom server's key for the address typed next to it; it is only
/// ever sent to that address.
#[tauri::command]
fn local_set_key(url: String, key: String) -> Result<(), String> {
    local_chat::set_custom_key(&url, &key)
}

#[tauri::command]
fn antigravity_accounts() -> Result<Vec<antigravity::AntigravityAccount>, String> {
    antigravity::list_accounts()
}

#[tauri::command]
fn antigravity_switch(id: i64) -> Result<bool, String> {
    antigravity::switch_account(id)
}

#[tauri::command]
async fn antigravity_login(app: AppHandle) -> Result<String, String> {
    antigravity::start_oauth_login(&app).await
}

#[tauri::command]
fn antigravity_import_json(content: String) -> Result<usize, String> {
    antigravity::import_accounts_json(&content)
}

#[tauri::command]
fn antigravity_export_json() -> Result<String, String> {
    antigravity::export_accounts_json()
}

#[tauri::command]
fn antigravity_export_file() -> Result<String, String> {
    antigravity::export_accounts_to_file()
}

#[tauri::command]
async fn antigravity_export_dialog() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(antigravity::save_accounts_as_dialog)
        .await
        .map_err(|e| format!("Görev hatası: {e}"))?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryReport {
    pub percent: u8,
    pub charging: bool,
    pub has_battery: bool,
}

#[tauri::command]
fn battery_status() -> Option<BatteryReport> {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct SYSTEM_POWER_STATUS {
            ac_line_status: u8,
            battery_flag: u8,
            battery_life_percent: u8,
            system_status_flag: u8,
            battery_life_time: u32,
            battery_full_life_time: u32,
        }
        extern "system" {
            fn GetSystemPowerStatus(lpSystemPowerStatus: *mut SYSTEM_POWER_STATUS) -> i32;
        }
        let mut status = SYSTEM_POWER_STATUS {
            ac_line_status: 255,
            battery_flag: 255,
            battery_life_percent: 255,
            system_status_flag: 0,
            battery_life_time: 0,
            battery_full_life_time: 0,
        };
        unsafe {
            if GetSystemPowerStatus(&mut status) != 0 {
                let has_battery = status.battery_life_percent <= 100 && status.battery_flag != 128;
                let percent = if has_battery { status.battery_life_percent } else { 100 };
                let charging = status.ac_line_status == 1;
                return Some(BatteryReport {
                    percent,
                    charging,
                    has_battery,
                });
            }
        }
    }
    None
}

#[tauri::command]
fn github_oauth_connect() -> Result<String, String> {
    let mut cmd = std::process::Command::new("gh");
    cmd.arg("auth").arg("token");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if token.starts_with("gh") && token.len() >= 30 {
                secrets::set("github-token", &token)?;
                let mut user = String::new();
                let mut u_cmd = std::process::Command::new("gh");
                u_cmd.arg("api").arg("user").arg("-q").arg(".login");
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    u_cmd.creation_flags(0x08000000);
                }
                if let Ok(u_out) = u_cmd.output() {
                    user = String::from_utf8_lossy(&u_out.stdout).trim().to_string();
                }
                if user.is_empty() {
                    user = "hesabınız".to_string();
                }
                return Ok(user);
            }
        }
    }

    let mut login_cmd = std::process::Command::new("cmd");
    login_cmd.arg("/c").arg("start gh auth login -w -s repo,read:user,workflow");
    let _ = login_cmd.spawn();
    Err("GitHub web yetkilendirmesi başlatıldı. Onay verdikten sonra butona tekrar tıklayın.".to_string())
}
fn get_desktop_dir() -> std::path::PathBuf {
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let d = std::path::PathBuf::from(userprofile).join("Desktop");
        if d.exists() {
            return d;
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let d = std::path::PathBuf::from(home).join("Desktop");
        if d.exists() {
            return d;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

#[tauri::command]
fn get_current_dir() -> String {
    let desktop = get_desktop_dir();
    let cwd = std::env::current_dir().unwrap_or_else(|_| desktop.clone());
    let cwd_str = cwd.to_string_lossy().to_string();
    let lower = cwd_str.replace('\\', "/").to_lowercase();
    if lower.ends_with("/src-tauri") || lower.ends_with("/windows") || lower.ends_with("/agentfy") || lower.ends_with("/omi") {
        let _ = std::env::set_current_dir(&desktop);
        return desktop.to_string_lossy().to_string();
    }
    cwd_str
}

#[tauri::command]
fn set_current_dir(path: String) -> Result<String, String> {
    let raw = path.trim();
    let resolved = if raw.is_empty() || raw.eq_ignore_ascii_case("desktop") || raw.eq_ignore_ascii_case("masaüstü") || raw.eq_ignore_ascii_case("masaustu") {
        get_desktop_dir()
    } else {
        let p = std::path::PathBuf::from(raw);
        if p.is_relative() {
            std::env::current_dir().unwrap_or_else(|_| get_desktop_dir()).join(&p)
        } else {
            p
        }
    };
    if !resolved.exists() {
        return Err(format!("Dizin bulunamadı: {}", resolved.display()));
    }
    if !resolved.is_dir() {
        return Err(format!("Belirtilen yol bir klasör değil: {}", resolved.display()));
    }
    let canonical = resolved.canonicalize().unwrap_or(resolved);
    let s = canonical.to_string_lossy().to_string();
    let clean = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    std::env::set_current_dir(&clean).map_err(|e| format!("Dizin değiştirilemedi: {e}"))?;
    Ok(clean)
}

#[tauri::command]
async fn pick_directory() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let script = r#"
            Add-Type -AssemblyName System.Windows.Forms
            $f = New-Object System.Windows.Forms.FolderBrowserDialog
            $f.Description = 'Çalışma Dizini Seçin'
            if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                Write-Output $f.SelectedPath
            }
        "#;
        let mut cmd = std::process::Command::new("powershell");
        cmd.arg("-NoProfile").arg("-Command").arg(script);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd.output().ok()?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                let _ = std::env::set_current_dir(&path);
                return Some(path);
            }
        }
        None
    }).await.ok().flatten()
}



#[tauri::command]
fn chat_reset(chat: State<Chat>, session_id: Option<String>) {
    chat.reset_session(session_id.as_deref().unwrap_or("default"));
}

#[tauri::command]
fn chat_restore(chat: State<Chat>, messages: Vec<serde_json::Value>, session_id: Option<String>) {
    chat.restore_session(session_id.as_deref().unwrap_or("default"), messages);
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResult {
    pub path: String,
    pub name: String,
    pub mode: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub data_url: String,
}

#[tauri::command]
async fn take_screenshot(app: AppHandle, mode: Option<String>) -> Result<ScreenshotResult, String> {
    // Hide Omi's window so Omi never appears in the screenshot
    if let Some(win) = app.get_webview_window("island") {
        let _ = win.hide();
    }
    // Give Windows DWM compositor 140ms to repaint the desktop area cleanly
    tokio::time::sleep(std::time::Duration::from_millis(140)).await;

    let res = tauri::async_runtime::spawn_blocking(move || {
        let mode_str = mode.as_deref().unwrap_or("fullscreen");
        let dir = std::env::temp_dir().join("omi_screenshots");
        let _ = std::fs::create_dir_all(&dir);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let filename = format!("ekran_goruntusu_{now}.png");
        let dest_path = dir.join(&filename);
        let dest_str = dest_path.to_string_lossy().replace('\\', "/");

        #[cfg(windows)]
        {
            let mut detected_title = None;

            if mode_str == "snip" || mode_str == "screenclip" {
                let temp_exe = std::env::temp_dir().join("omi_snipper.exe");
                let target_exe = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.join("omi-snipper.exe")));

                let snipper_exe = if let Some(t) = &target_exe {
                    if t.exists() {
                        t.clone()
                    } else if temp_exe.exists() {
                        temp_exe
                    } else {
                        let cs_path = std::env::temp_dir().join("OmiSnipper.cs");
                        let _ = std::fs::write(&cs_path, include_str!("../../snipper/OmiSnipper.cs"));
                        let csc = r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe";
                        let mut compile_cmd = std::process::Command::new(csc);
                        compile_cmd.arg("/nologo")
                            .arg("/target:winexe")
                            .arg("/optimize+")
                            .arg(format!("/out:{}", temp_exe.to_string_lossy()))
                            .arg(&cs_path);
                        use std::os::windows::process::CommandExt;
                        compile_cmd.creation_flags(0x08000000);
                        let _ = compile_cmd.output();
                        temp_exe
                    }
                } else if temp_exe.exists() {
                    temp_exe
                } else {
                    let cs_path = std::env::temp_dir().join("OmiSnipper.cs");
                    let _ = std::fs::write(&cs_path, include_str!("../../snipper/OmiSnipper.cs"));
                    let csc = r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe";
                    let mut compile_cmd = std::process::Command::new(csc);
                    compile_cmd.arg("/nologo")
                        .arg("/target:winexe")
                        .arg("/optimize+")
                        .arg(format!("/out:{}", temp_exe.to_string_lossy()))
                        .arg(&cs_path);
                    use std::os::windows::process::CommandExt;
                    compile_cmd.creation_flags(0x08000000);
                    let _ = compile_cmd.output();
                    temp_exe
                };

                let mut cmd = std::process::Command::new(&snipper_exe);
                cmd.arg(&dest_str);
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
                let status = cmd.status().map_err(|e| format!("Ekran alıntısı başlatılamadı: {e}"))?;
                if !status.success() || !dest_path.exists() {
                    return Err("Ekran alıntısı iptal edildi.".to_string());
                }
            } else {
                let script = if mode_str == "clipboard" {
                    format!(
                        r#"
                        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
                        if ([System.Windows.Forms.Clipboard]::ContainsImage()) {{
                            $img = [System.Windows.Forms.Clipboard]::GetImage()
                            $img.Save('{dest_str}', [System.Drawing.Imaging.ImageFormat]::Png)
                            $img.Dispose()
                            Write-Output "CLIP::"
                        }} else {{
                            Write-Output "EMPTY::"
                        }}
                        "#
                    )
                } else if mode_str == "window" {
                    format!(
                        r#"
                        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
                        $source = @"
                        using System;
                        using System.Drawing;
                        using System.Runtime.InteropServices;
                        public class WinSnap {{
                            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
                            [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
                            [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, [Out] char[] text, int maxCount);
                            [StructLayout(LayoutKind.Sequential)] public struct RECT {{ public int Left, Top, Right, Bottom; }}
                        }}
                        "@
                        Add-Type -TypeDefinition $source
                        $fg = [WinSnap]::GetForegroundWindow()
                        $titleBuf = New-Object char[] 512
                        $len = [WinSnap]::GetWindowTextW($fg, $titleBuf, 512)
                        $title = (New-Object string ($titleBuf, 0, $len)).Trim()
                        $r = New-Object WinSnap+RECT
                        $ok = [WinSnap]::GetWindowRect($fg, [ref]$r)
                        $w = $r.Right - $r.Left
                        $h = $r.Bottom - $r.Top
                        if ($w -gt 50 -and $h -gt 50) {{
                            $bmp = New-Object System.Drawing.Bitmap $w, $h
                            $g = [System.Drawing.Graphics]::FromImage($bmp)
                            $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
                            $g.Dispose()
                            $bmp.Save('{dest_str}', [System.Drawing.Imaging.ImageFormat]::Png)
                            $bmp.Dispose()
                            Write-Output "WIN::$title"
                        }} else {{
                            $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
                            $bmp = New-Object System.Drawing.Bitmap($s.Width, $s.Height)
                            $g = [System.Drawing.Graphics]::FromImage($bmp)
                            $g.CopyFromScreen($s.X, $s.Y, 0, 0, $bmp.Size)
                            $g.Dispose()
                            $bmp.Save('{dest_str}', [System.Drawing.Imaging.ImageFormat]::Png)
                            $bmp.Dispose()
                            Write-Output "FULL::"
                        }}
                        "#
                    )
                } else {
                    format!(
                        r#"
                        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
                        $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
                        $bmp = New-Object System.Drawing.Bitmap($s.Width, $s.Height)
                        $g = [System.Drawing.Graphics]::FromImage($bmp)
                        $g.CopyFromScreen($s.X, $s.Y, 0, 0, $bmp.Size)
                        $g.Dispose()
                        $bmp.Save('{dest_str}', [System.Drawing.Imaging.ImageFormat]::Png)
                        $bmp.Dispose()
                        Write-Output "FULL::"
                        "#
                    )
                };

                let mut cmd = std::process::Command::new("powershell");
                cmd.arg("-NoProfile").arg("-STA").arg("-Command").arg(&script);
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                let output = cmd.output().map_err(|e| format!("Ekran görüntüsü alınamadı: {e}"))?;
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if let Some(t) = stdout.strip_prefix("WIN::") {
                    let clean = t.trim();
                    if !clean.is_empty() { detected_title = Some(clean.to_string()); }
                }
            }
            if dest_path.exists() {
                let data_url = match std::fs::read(&dest_path) {
                    Ok(bytes) => {
                        use base64::Engine;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        format!("data:image/png;base64,{b64}")
                    }
                    Err(_) => String::new(),
                };
                Ok(ScreenshotResult {
                    path: dest_path.to_string_lossy().to_string(),
                    name: filename,
                    mode: mode_str.to_string(),
                    title: detected_title,
                    data_url,
                })
            } else {
                Err("Ekran görüntüsü dosyası oluşturulamadı.".to_string())
            }
        }
        #[cfg(not(windows))]
        {
            Err("Ekran görüntüsü alma özelliği şu an sadece Windows üzerinde desteklenmektedir.".to_string())
        }
    }).await.map_err(|e| e.to_string())?;

    // Restore and re-focus Omi's window
    if let Some(win) = app.get_webview_window("island") {
        let _ = win.show();
        let _ = win.set_focus();
    }

    res
}

#[tauri::command]
async fn execute_playwright_action(params: serde_json::Value) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let input_json = serde_json::to_string(&params).map_err(|e| e.to_string())?;
        
        let mut runner_candidates = vec![
            std::env::current_dir().unwrap_or_default().join("scripts").join("playwright_runner.mjs"),
            std::env::current_dir().unwrap_or_default().join("windows").join("scripts").join("playwright_runner.mjs"),
        ];
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                runner_candidates.push(parent.join("scripts").join("playwright_runner.mjs"));
                runner_candidates.push(parent.join("..").join("windows").join("scripts").join("playwright_runner.mjs"));
            }
        }

        let script = runner_candidates.iter().find(|p| p.exists()).cloned().unwrap_or_else(|| {
            std::path::PathBuf::from("scripts/playwright_runner.mjs")
        });

        let mut cmd = std::process::Command::new("node");
        cmd.arg(&script).arg(&input_json);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let output = cmd.output().map_err(|e| format!("Failed to execute node playwright: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let trimmed = stdout.trim();

        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(parsed)
        } else if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Playwright execution failed: {stderr}"))
        } else {
            Ok(serde_json::json!({
                "success": true,
                "rawOutput": trimmed
            }))
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn execute_browser_use_action(params: serde_json::Value) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let input_json = serde_json::to_string(&params).map_err(|e| e.to_string())?;

        let mut runner_candidates = vec![
            std::env::current_dir().unwrap_or_default().join("scripts").join("browser_use_runner.mjs"),
            std::env::current_dir().unwrap_or_default().join("windows").join("scripts").join("browser_use_runner.mjs"),
        ];
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                runner_candidates.push(parent.join("scripts").join("browser_use_runner.mjs"));
                runner_candidates.push(parent.join("..").join("windows").join("scripts").join("browser_use_runner.mjs"));
            }
        }

        let script = runner_candidates.iter().find(|p| p.exists()).cloned().unwrap_or_else(|| {
            std::path::PathBuf::from("scripts/browser_use_runner.mjs")
        });

        let mut cmd = std::process::Command::new("node");
        cmd.arg(&script).arg(&input_json);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let output = cmd.output().map_err(|e| format!("Failed to execute node browser-use: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let trimmed = stdout.trim();

        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(parsed)
        } else if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Browser-Use execution failed: {stderr}"))
        } else {
            Ok(serde_json::json!({
                "success": true,
                "rawOutput": trimmed
            }))
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn save_temp_image(base64_data: String) -> Result<ScreenshotResult, String> {
    use base64::Engine;
    let clean = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(clean.trim())
        .map_err(|e| format!("Base64 çözümleme hatası: {e}"))?;
    let dir = std::env::temp_dir().join("omi_screenshots");
    let _ = std::fs::create_dir_all(&dir);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("ekran_goruntusu_cizim_{now}.png");
    let dest_path = dir.join(&filename);
    std::fs::write(&dest_path, &bytes).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
    let data_url_clone = base64_data.clone();
    Ok(ScreenshotResult {
        path: dest_path.to_string_lossy().to_string(),
        name: filename,
        mode: "markup".to_string(),
        title: Some("Çizimli Ekran Görüntüsü".to_string()),
        data_url: data_url_clone,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTrackInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub source: String,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub position: Option<f64>,
}

static COVER_CACHE: parking_lot::Mutex<Option<std::collections::HashMap<String, String>>> = parking_lot::Mutex::new(None);
static LAST_TRACK: parking_lot::Mutex<Option<(MediaTrackInfo, std::time::Instant)>> = parking_lot::Mutex::new(None);
#[cfg(windows)]
fn init_com_mta() {
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(pv_reserved: *const std::ffi::c_void, dw_co_init: u32) -> i32;
    }
    unsafe {
        let _ = CoInitializeEx(std::ptr::null(), 0);
    }
}

#[cfg(windows)]
fn sanitize_media_title(raw: &str) -> String {
    let mut s = raw.trim().to_string();

    // 1. Strip leading notification badges like "(1) ", "(99) "
    if s.starts_with('(') {
        if let Some(pos) = s.find(')') {
            if pos <= 5 && s[1..pos].chars().all(|c| c.is_ascii_digit()) {
                s = s[pos + 1..].trim().to_string();
            }
        }
    }

    // 2. Strip trailing platform suffixes case-insensitively
    for platform in &[" - YouTube Music", " - YouTube", " - Soundfy", " - Spotify"] {
        if let Some(pos) = s.to_lowercase().rfind(&platform.to_lowercase()) {
            if pos + platform.len() == s.len() {
                s = s[..pos].trim().to_string();
            }
        }
    }

    // 3. Strip common video/clip annotations case-insensitively
    let noise_words = [
        "official music video",
        "official hd music video",
        "official hd video",
        "official video klip",
        "official video",
        "official audio",
        "official lyric video",
        "official lyrics",
        "official klip",
        "official visualizer",
        "official",
        "music video",
        "video klip",
        "resmi klip",
        "klip",
        "clip officiel",
        "visualizer",
        "lyric video",
        "lyrics",
        "audio",
        "4k 60fps",
        "4k",
        "hd",
        "hq",
    ];

    for noise in &noise_words {
        for (open, close) in &[('(', ')'), ('[', ']')] {
            let pattern = format!("{open}{noise}{close}");
            let s_lower = s.to_lowercase();
            if let Some(pos) = s_lower.find(&pattern) {
                s = format!("{}{}", &s[..pos], &s[pos + pattern.len()..]).trim().to_string();
            }
        }
    }

    for pipe_noise in &[" | official music video", " | official video", " | video"] {
        if let Some(pos) = s.to_lowercase().rfind(pipe_noise) {
            if pos + pipe_noise.len() == s.len() {
                s = s[..pos].trim().to_string();
            }
        }
    }

    s.trim().to_string()
}

#[cfg(windows)]
async fn detect_soundfy_presence() -> Option<MediaTrackInfo> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(150))
        .build()
        .ok()?;
    let resp = client.get("http://127.0.0.1:3000/api/discord/presence").send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    let last = json.get("lastActivity")?;
    let title = last.get("title").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        return None;
    }
    let artist = last.get("artist").and_then(|a| a.as_str()).unwrap_or("Soundfy").trim().to_string();
    let album = last.get("album").and_then(|a| a.as_str()).unwrap_or("Soundfy").trim().to_string();
    let thumbnail = last.get("thumbnail").and_then(|t| t.as_str()).map(String::from);
    let duration = last.get("duration").and_then(|d| d.as_f64()).filter(|d| *d > 0.0);
    let position = last.get("currentTime").and_then(|c| c.as_f64());
    let playing = last.get("isPlaying").and_then(|p| p.as_bool()).unwrap_or(true);

    Some(MediaTrackInfo {
        title,
        artist,
        album,
        playing,
        source: "Soundfy".to_string(),
        cover_url: thumbnail,
        duration,
        position,
    })
}

fn native_detect_now_playing() -> Option<MediaTrackInfo> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    use windows::Storage::Streams::DataReader;

    init_com_mta();
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .ok()?
        .get()
        .ok()?;

    let sessions = manager.GetSessions().ok()?;
    let current_session = manager.GetCurrentSession().ok();
    let current_app_id = current_session
        .as_ref()
        .and_then(|s| s.SourceAppUserModelId().ok())
        .map(|h| h.to_string())
        .unwrap_or_default();

    struct Candidate {
        session: windows::Media::Control::GlobalSystemMediaTransportControlsSession,
        title: String,
        artist: String,
        album: String,
        app_id: String,
        status: GlobalSystemMediaTransportControlsSessionPlaybackStatus,
        is_current: bool,
        thumbnail_base64: Option<String>,
    }

    let mut candidates = Vec::new();
    let count = sessions.Size().ok().unwrap_or(0);

    for i in 0..count {
        if let Ok(session) = sessions.GetAt(i) {
            let playback = match session.GetPlaybackInfo() {
                Ok(pb) => pb,
                Err(_) => continue,
            };
            let status = match playback.PlaybackStatus() {
                Ok(st) => st,
                Err(_) => continue,
            };
            if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed
                || status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped
            {
                continue;
            }

            let props_op = match session.TryGetMediaPropertiesAsync() {
                Ok(op) => op,
                Err(_) => continue,
            };
            let props = match props_op.get() {
                Ok(p) => p,
                Err(_) => continue,
            };

            let title_raw = props.Title().map(|h| h.to_string()).unwrap_or_default();
            let title_clean = title_raw.trim().to_string();
            if title_clean.is_empty() {
                continue;
            }

            let title_lower = title_clean.to_lowercase();
            if matches!(
                title_lower.as_str(),
                "instagram" | "tiktok" | "whatsapp" | "telegram" | "discord" | "new tab" | "home" | "inbox"
            ) {
                continue;
            }

            let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default().trim().to_string();
            let album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default().trim().to_string();
            let app_id = session.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
            let is_current = !current_app_id.is_empty() && app_id == current_app_id;

            // Extract thumbnail directly from WinRT SMTC
            let thumbnail_base64 = (|| -> Option<String> {
                let thumb_ref = props.Thumbnail().ok()?;
                let stream_op = thumb_ref.OpenReadAsync().ok()?;
                let stream = stream_op.get().ok()?;
                let size = stream.Size().ok()? as u32;
                if size == 0 || size > 10 * 1024 * 1024 {
                    return None;
                }
                let reader = DataReader::CreateDataReader(&stream).ok()?;
                let load_op = reader.LoadAsync(size).ok()?;
                load_op.get().ok()?;
                let mut bytes = vec![0u8; size as usize];
                reader.ReadBytes(&mut bytes).ok()?;
                let ct = stream.ContentType().map(|s| s.to_string()).unwrap_or_default();
                let ct = if ct.is_empty() { "image/jpeg" } else { ct.as_str() };
                let b64 = crate::claude::base64_for(&bytes);
                Some(format!("data:{ct};base64,{b64}"))
            })();

            candidates.push(Candidate {
                session: session.clone(),
                title: title_clean,
                artist,
                album,
                app_id,
                status,
                is_current,
                thumbnail_base64,
            });
        }
    }

    let is_music_app = |app_id: &str, title: &str| -> bool {
        let a = app_id.to_lowercase();
        let t = title.to_lowercase();
        a.contains("soundfy")
            || a.contains("spotify")
            || a.contains("youtube")
            || a.contains("ytm")
            || a.contains("music")
            || a.contains("cider")
            || a.contains("moosync")
            || a.contains("spotube")
            || a.contains("nuclear")
            || a.contains("apple")
            || a.contains("itunes")
            || t.contains("youtube")
            || t.contains("soundfy")
            || t.contains("spotify")
    };

    let chosen = candidates
        .iter()
        .find(|c| c.status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing && (c.is_current || is_music_app(&c.app_id, &c.title)))
        .or_else(|| {
            candidates
                .iter()
                .find(|c| c.status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
        })
        .or_else(|| {
            candidates.iter().find(|c| {
                c.status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing
                    || c.status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Opened
            })
        })
        .or_else(|| {
            candidates
                .iter()
                .find(|c| is_music_app(&c.app_id, &c.title))
        })
        .or_else(|| candidates.iter().find(|c| c.is_current))
        .or_else(|| candidates.first())?;

    let clean_title_sanitized = sanitize_media_title(&chosen.title);
    let mut clean_title = clean_title_sanitized;
    let mut clean_artist = chosen.artist.trim().to_string();

    let artist_lower = clean_artist.to_lowercase();
    let is_generic_artist = clean_artist.is_empty()
        || artist_lower == "youtube"
        || artist_lower == "youtube.com"
        || artist_lower == "çalan parça"
        || artist_lower == "bilinmeyen sanatçı"
        || artist_lower == "soundfy"
        || artist_lower == "unknown artist"
        || artist_lower == "various artists";

    // Split on " - " ONLY if artist is generic OR if the artist is already the left side of the title!
    if let Some((left, right)) = clean_title.split_once(" - ") {
        let left_trim = left.trim();
        let right_trim = right.trim();
        if !left_trim.is_empty() && !right_trim.is_empty() {
            if is_generic_artist || clean_artist.eq_ignore_ascii_case(left_trim) {
                clean_artist = left_trim.to_string();
                clean_title = right_trim.to_string();
            }
        }
    }

    if clean_artist.is_empty() || clean_artist.eq_ignore_ascii_case("youtube") {
        clean_artist = if !chosen.artist.trim().is_empty() && !chosen.artist.trim().eq_ignore_ascii_case("youtube") {
            chosen.artist.trim().to_string()
        } else {
            "YouTube".to_string()
        };
    }

    let app_lower = chosen.app_id.to_lowercase();
    let title_lower = clean_title.to_lowercase();
    let src = if app_lower.contains("spotify") {
        "Spotify".to_string()
    } else if app_lower.contains("soundfy") {
        "Soundfy".to_string()
    } else if app_lower.contains("ytm") || app_lower.contains("music.youtube") {
        "YouTube Music".to_string()
    } else if app_lower.contains("youtube") || title_lower.contains("youtube") {
        if app_lower.contains("music") || title_lower.contains("music") {
            "YouTube Music".to_string()
        } else {
            "YouTube".to_string()
        }
    } else if app_lower.contains("applemusic") || app_lower.contains("itunes") {
        "Apple Music".to_string()
    } else if title_lower.contains("soundcloud") || app_lower.contains("soundcloud") {
        "SoundCloud".to_string()
    } else if !chosen.app_id.is_empty() {
        if app_lower.contains("chrome")
            || app_lower.contains("msedge")
            || app_lower.contains("firefox")
            || app_lower.contains("brave")
            || app_lower.contains("zen")
            || app_lower.contains("opera")
            || app_lower.contains("vivaldi")
        {
            if chosen.album.to_lowercase().contains("music") {
                "YouTube Music".to_string()
            } else {
                "YouTube".to_string()
            }
        } else {
            chosen.app_id.clone()
        }
    } else {
        "YouTube Music".to_string()
    };

    let album = if !chosen.album.is_empty() {
        chosen.album.clone()
    } else {
        src.clone()
    };

    let playing = chosen.status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
        || chosen.status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing
        || chosen.status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Opened;

    let (mut duration, position) = if let Ok(tl) = chosen.session.GetTimelineProperties() {
        let start = tl.StartTime().ok().map(|t| t.Duration as f64 / 10_000_000.0).unwrap_or(0.0);
        let end = tl.EndTime().ok().map(|t| t.Duration as f64 / 10_000_000.0).unwrap_or(0.0);
        let raw_pos = tl.Position().ok().map(|t| t.Duration as f64 / 10_000_000.0).unwrap_or(0.0);
        let dur = (end - start).max(0.0);
        let mut cur_pos = (raw_pos - start).max(0.0);

        if playing {
            if let Ok(last_updated) = tl.LastUpdatedTime() {
                let last_ms = (last_updated.UniversalTime - 116444736000000000) / 10000;
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let elapsed_secs = ((now_ms - last_ms) as f64 / 1000.0).max(0.0);
                if elapsed_secs > 0.0 && elapsed_secs < 120.0 {
                    cur_pos += elapsed_secs;
                }
            }
        }

        let dur_opt = if dur > 0.0 { Some(dur) } else { None };
        let pos_opt = if dur > 0.0 {
            Some(cur_pos.min(dur))
        } else if cur_pos > 0.0 {
            Some(cur_pos)
        } else {
            None
        };
        (dur_opt, pos_opt)
    } else {
        (None, None)
    };

    if duration.is_none() {
        let guard = LAST_TRACK.lock();
        if let Some((cached, _)) = guard.as_ref() {
            if cached.title.eq_ignore_ascii_case(&clean_title) && cached.duration.is_some() {
                duration = cached.duration;
            }
        }
    }

    Some(MediaTrackInfo {
        title: clean_title,
        artist: clean_artist,
        album,
        playing,
        source: src,
        cover_url: chosen.thumbnail_base64.clone(),
        duration,
        position,
    })
}

#[cfg(windows)]
fn fallback_detect_window_titles() -> Option<MediaTrackInfo> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible, GetWindow};

    let mut pair: (Option<String>, Option<String>) = (None, None);

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let (sp, yt) = unsafe { &mut *(lparam.0 as *mut (Option<String>, Option<String>)) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, windows::Win32::UI::WindowsAndMessaging::GW_OWNER).is_ok() {
                return true.into();
            }
            let mut text = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut text);
            if len > 0 {
                let title = String::from_utf16_lossy(&text[..len as usize]).trim().to_string();
                if sp.is_none() && (title.contains(" - ") || title.ends_with("Spotify")) {
                    if !matches!(title.as_str(), "Spotify" | "Spotify Free" | "Spotify Premium") {
                        let mut class = [0u16; 128];
                        let clen = windows::Win32::UI::WindowsAndMessaging::GetClassNameW(hwnd, &mut class);
                        if clen > 0 {
                            let class_str = String::from_utf16_lossy(&class[..clen as usize]);
                            if class_str.contains("Chrome_WidgetWin_0") || class_str.contains("Spotify") {
                                if title.contains(" - ") {
                                    *sp = Some(title.clone());
                                }
                            }
                        }
                    }
                }
                if yt.is_none() && (title.contains("YouTube") || title.contains("Soundfy")) {
                    if title.contains(" - ") {
                        *yt = Some(title.clone());
                    }
                }
                if yt.is_none() {
                    let mut pid = 0u32;
                    let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, Some(&mut pid));
                    if pid != 0 {
                        if let Ok(process) = windows::Win32::System::Threading::OpenProcess(
                            windows::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
                            false,
                            pid,
                        ) {
                            let mut buf = [0u16; 512];
                            let mut plen = buf.len() as u32;
                            if windows::Win32::System::Threading::QueryFullProcessImageNameW(
                                process,
                                windows::Win32::System::Threading::PROCESS_NAME_WIN32,
                                windows::core::PWSTR(buf.as_mut_ptr()),
                                &mut plen,
                            ).is_ok() {
                                let path = String::from_utf16_lossy(&buf[..plen as usize]).to_lowercase();
                                if path.contains("soundfy.exe") && title != "Soundfy" && !title.is_empty() {
                                    *yt = Some(format!("{title} - Soundfy"));
                                }
                            }
                            let _ = windows::Win32::Foundation::CloseHandle(process);
                        }
                    }
                }
            }
        }
        true.into()
    }

    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut pair as *mut _ as isize));
    }

    if let Some(sp_title) = pair.0 {
        if let Some((artist, track)) = sp_title.split_once(" - ") {
            return Some(MediaTrackInfo {
                title: track.trim().to_string(),
                artist: artist.trim().to_string(),
                album: "Spotify".to_string(),
                playing: true,
                source: "Spotify".to_string(),
                cover_url: None,
                duration: None,
                position: None,
            });
        }
    }

    if let Some(raw_yt) = pair.1 {
        let mut clean = raw_yt;
        for browser in &[
            " - Google Chrome",
            " - Microsoft Edge",
            " - Brave",
            " — Mozilla Firefox",
            " - Mozilla Firefox",
            " — Zen Browser",
            " - Zen Browser",
            " - Opera",
            " - Vivaldi",
        ] {
            if let Some(stripped) = clean.strip_suffix(browser) {
                clean = stripped.trim().to_string();
                break;
            }
        }

        let is_ytm = clean.contains("YouTube Music");
        for platform in &[" - YouTube Music", " - YouTube", " - Soundfy"] {
            if let Some(stripped) = clean.strip_suffix(platform) {
                clean = stripped.trim().to_string();
                break;
            }
        }

        let (artist, track) = if let Some((a, t)) = clean.split_once(" - ") {
            (a.trim().to_string(), t.trim().to_string())
        } else {
            ("YouTube".to_string(), clean)
        };

        let src = if is_ytm { "YouTube Music" } else { "YouTube" };

        return Some(MediaTrackInfo {
            title: track,
            artist,
            album: src.to_string(),
            playing: true,
            source: src.to_string(),
            cover_url: None,
            duration: None,
            position: None,
        });
    }

    None
}

async fn fetch_youtube_cover(client: &reqwest::Client, query: &str) -> Option<String> {
    // 1. First try YouTube Music Innertube API (official square album artwork)
    let ytm_url = "https://music.youtube.com/youtubei/v1/search";
    let ytm_body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20231204.01.00",
                "hl": "tr",
                "gl": "TR"
            }
        },
        "query": query
    });
    if let Ok(resp) = client.post(ytm_url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .json(&ytm_body)
        .timeout(std::time::Duration::from_millis(1500))
        .send().await
    {
        if let Ok(json_text) = resp.text().await {
            if let Some(pos) = json_text.find("https://lh3.googleusercontent.com/") {
                let after = &json_text[pos..];
                if let Some(end) = after.find('"').or_else(|| after.find('=')) {
                    let base_url = &after[..end];
                    return Some(format!("{base_url}=w544-h544-l90-rj"));
                }
            }
            if let Some(pos) = json_text.find("https://i.ytimg.com/vi/") {
                let after = &json_text[pos + "https://i.ytimg.com/vi/".len()..];
                if let Some(end) = after.find('/') {
                    let video_id = &after[..end];
                    if video_id.len() == 11 {
                        return Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"));
                    }
                }
            }
        }
    }

    // 2. Fallback to standard YouTube Innertube API (indexes 100% of YouTube videos)
    let yt_url = "https://www.youtube.com/youtubei/v1/search";
    let yt_body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20231204.01.00",
                "hl": "tr",
                "gl": "TR"
            }
        },
        "query": query
    });
    if let Ok(resp) = client.post(yt_url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .json(&yt_body)
        .timeout(std::time::Duration::from_millis(1500))
        .send().await
    {
        if let Ok(json_text) = resp.text().await {
            if let Some(pos) = json_text.find("https://i.ytimg.com/vi/") {
                let after = &json_text[pos + "https://i.ytimg.com/vi/".len()..];
                if let Some(end) = after.find('/') {
                    let video_id = &after[..end];
                    if video_id.len() == 11 {
                        return Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"));
                    }
                }
            }
        }
    }

    None
}

async fn resolve_cover_url(client: &reqwest::Client, artist: &str, title: &str) -> Option<String> {
    let clean_artist = artist.replace("Çalan Parça", "").trim().to_string();
    let query = if clean_artist.is_empty() {
        title.trim().to_string()
    } else {
        format!("{clean_artist} {title}").trim().to_string()
    };

    if query.is_empty() {
        return None;
    }

    {
        let mut guard = COVER_CACHE.lock();
        let map = guard.get_or_insert_with(std::collections::HashMap::new);
        if let Some(cached) = map.get(&query) {
            return Some(cached.clone());
        }
    }

    // 1. YouTube Music Innertube API (native for YouTube Music tracks)
    if let Some(url) = fetch_youtube_cover(client, &query).await {
        let mut guard = COVER_CACHE.lock();
        guard.get_or_insert_with(std::collections::HashMap::new).insert(query, url.clone());
        return Some(url);
    }

    // 2. iTunes API fallback
    if let Ok(resp) = client.get("https://itunes.apple.com/search")
        .query(&[("term", &query), ("entity", &"song".to_string()), ("limit", &"1".to_string())])
        .timeout(std::time::Duration::from_millis(1500))
        .send().await
    {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if let Some(art) = json["results"][0]["artworkUrl100"].as_str() {
                let high_res = art.replace("100x100bb", "600x600bb");
                let mut guard = COVER_CACHE.lock();
                guard.get_or_insert_with(std::collections::HashMap::new).insert(query.clone(), high_res.clone());
                return Some(high_res);
            }
        }
    }

    // 3. Deezer API fallback
    if let Ok(resp) = client.get("https://api.deezer.com/search")
        .header("User-Agent", "Mozilla/5.0")
        .query(&[("q", &query), ("limit", &"1".to_string())])
        .timeout(std::time::Duration::from_millis(1500))
        .send().await
    {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if let Some(art) = json["data"][0]["album"]["cover_xl"].as_str()
                .or_else(|| json["data"][0]["album"]["cover_medium"].as_str())
            {
                let url = art.to_string();
                let mut guard = COVER_CACHE.lock();
                guard.get_or_insert_with(std::collections::HashMap::new).insert(query, url.clone());
                return Some(url);
            }
        }
    }

    None
}

#[tauri::command]
async fn detect_now_playing() -> Result<Option<MediaTrackInfo>, String> {
    #[cfg(windows)]
    {
        let soundfy_track = detect_soundfy_presence().await;
        let detected = if soundfy_track.is_some() {
            soundfy_track
        } else {
            tokio::task::spawn_blocking(|| {
                native_detect_now_playing().or_else(fallback_detect_window_titles)
            }).await.ok().flatten()
        };

        if let Some(mut info) = detected {
            if info.cover_url.is_none() && !info.title.is_empty() {
                let clean_artist = info.artist.replace("Çalan Parça", "").trim().to_string();
                let query = if clean_artist.is_empty() || clean_artist.eq_ignore_ascii_case("youtube") {
                    info.title.trim().to_string()
                } else {
                    format!("{clean_artist} {}", info.title).trim().to_string()
                };

                let cached = {
                    let mut guard = COVER_CACHE.lock();
                    guard.as_mut().and_then(|m| m.get(&query).cloned())
                };

                if let Some(url) = cached {
                    info.cover_url = Some(url);
                } else {
                    let artist = info.artist.clone();
                    let title = info.title.clone();
                    tokio::spawn(async move {
                        let client = reqwest::Client::new();
                        let _ = resolve_cover_url(&client, &artist, &title).await;
                    });
                }
            }
            {
                let mut guard = LAST_TRACK.lock();
                *guard = Some((info.clone(), std::time::Instant::now()));
            }
            return Ok(Some(info));
        }

        // Extended grace period for buffering, track transitions, ads
        {
            let guard = LAST_TRACK.lock();
            if let Some((cached_track, timestamp)) = guard.as_ref() {
                let elapsed = timestamp.elapsed().as_millis();
                let max_grace = if cached_track.source == "Soundfy" || cached_track.source == "Spotify" {
                    25000
                } else {
                    15000
                };
                if elapsed < max_grace {
                    let mut fallback = cached_track.clone();
                    fallback.playing = false; // Transition defaults to paused rather than wiping out
                    return Ok(Some(fallback));
                }
            }
        }
        Ok(None)
    }
    #[cfg(not(windows))]
    Ok(None)
}
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_percent: f64,
    pub ram_used_gb: f64,
    pub ram_total_gb: f64,
    pub ram_percent: u32,
    pub time_str: String,
}

#[tauri::command]
fn get_system_stats() -> SystemStats {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        use windows::Win32::System::Threading::GetSystemTimes;
        use windows::Win32::Foundation::FILETIME;

        let mut mem = MEMORYSTATUSEX::default();
        mem.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        let (ram_used_gb, ram_total_gb, ram_percent) = if GlobalMemoryStatusEx(&mut mem).is_ok() {
            let total = mem.ullTotalPhys as f64 / (1024.0 * 1024.0 * 1024.0);
            let avail = mem.ullAvailPhys as f64 / (1024.0 * 1024.0 * 1024.0);
            (total - avail, total, mem.dwMemoryLoad)
        } else {
            (0.0, 0.0, 0)
        };

        static PREV_TIMES: parking_lot::Mutex<Option<(u64, u64)>> = parking_lot::Mutex::new(None);
        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();

        let to_u64 = |ft: FILETIME| ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64);

        let cpu_percent = if GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).is_ok() {
            let idle_u = to_u64(idle);
            let total_u = to_u64(kernel) + to_u64(user);
            let mut guard = PREV_TIMES.lock();
            let cpu = if let Some((prev_idle, prev_total)) = *guard {
                let d_idle = idle_u.saturating_sub(prev_idle);
                let d_total = total_u.saturating_sub(prev_total);
                if d_total > 0 {
                    let used = d_total.saturating_sub(d_idle);
                    ((used as f64 / d_total as f64) * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                }
            } else {
                0.0
            };
            *guard = Some((idle_u, total_u));
            cpu
        } else {
            0.0
        };

        let now = std::time::SystemTime::now();
        let dur = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let secs = dur % 60;
        let mins = (dur / 60) % 60;
        let hours = ((dur / 3600) + 3) % 24; // Local Turkey time (UTC+3)
        let time_str = format!("{:02}:{:02}:{:02}", hours, mins, secs);

        SystemStats {
            cpu_percent: (cpu_percent * 10.0).round() / 10.0,
            ram_used_gb: (ram_used_gb * 10.0).round() / 10.0,
            ram_total_gb: (ram_total_gb * 10.0).round() / 10.0,
            ram_percent,
            time_str,
        }
    }
    #[cfg(not(windows))]
    {
        SystemStats::default()
    }
}

#[cfg(windows)]
fn native_media_control(action: &str, value: Option<f64>) -> bool {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };

    init_com_mta();

    let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
        Ok(op) => match op.get() {
            Ok(m) => m,
            Err(_) => return false,
        },
        Err(_) => return false,
    };

    let count = manager.GetSessions().ok().and_then(|s| s.Size().ok()).unwrap_or(0);
    let sessions: Vec<windows::Media::Control::GlobalSystemMediaTransportControlsSession> = (0..count)
        .filter_map(|i| manager.GetSessions().ok()?.GetAt(i).ok())
        .collect();

    let is_music_app = |app_id: &str| -> bool {
        let a = app_id.to_lowercase();
        a.contains("soundfy")
            || a.contains("spotify")
            || a.contains("youtube")
            || a.contains("ytm")
            || a.contains("music")
            || a.contains("cider")
            || a.contains("apple")
            || a.contains("itunes")
    };

    // 1. Actively playing music app (Soundfy, Spotify, etc.)
    let mut session = sessions.iter().find(|s| {
        let app = s.SourceAppUserModelId().ok().map(|h| h.to_string()).unwrap_or_default();
        let status = s.GetPlaybackInfo().ok().and_then(|p| p.PlaybackStatus().ok());
        is_music_app(&app) && status == Some(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
    }).cloned();

    // 2. Current session if it is a music app
    if session.is_none() {
        if let Ok(cur) = manager.GetCurrentSession() {
            let app = cur.SourceAppUserModelId().ok().map(|h| h.to_string()).unwrap_or_default();
            if is_music_app(&app) {
                session = Some(cur);
            }
        }
    }

    // 3. Any actively playing session
    if session.is_none() {
        session = sessions.iter().find(|s| {
            s.GetPlaybackInfo().ok().and_then(|p| p.PlaybackStatus().ok()) == Some(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
        }).cloned();
    }

    // 4. Any music app session (even if paused, so clicking Play resumes Soundfy/Spotify)
    if session.is_none() {
        session = sessions.iter().find(|s| {
            let app = s.SourceAppUserModelId().ok().map(|h| h.to_string()).unwrap_or_default();
            is_music_app(&app)
        }).cloned();
    }

    // 5. Fallback to current session or first available session
    if session.is_none() {
        session = manager.GetCurrentSession().ok().or_else(|| sessions.into_iter().next());
    }

    if let Some(s) = session {
        let res = match action {
            "playPause" | "toggle" => s.TryTogglePlayPauseAsync().ok().and_then(|op| op.get().ok()),
            "next" => s.TrySkipNextAsync().ok().and_then(|op| op.get().ok()),
            "previous" | "prev" => s.TrySkipPreviousAsync().ok().and_then(|op| op.get().ok()),
            "seek" => {
                if let Some(secs) = value {
                    let units = (secs * 10_000_000.0) as i64;
                    s.TryChangePlaybackPositionAsync(units).ok().and_then(|op| op.get().ok())
                } else {
                    None
                }
            }
            "shuffle" => {
                let on = value.map(|v| v > 0.0).unwrap_or(true);
                s.TryChangeShuffleActiveAsync(on).ok().and_then(|op| op.get().ok())
            }
            "repeat" => {
                let mode = match value.map(|v| v as i32) {
                    Some(2) => windows::Media::MediaPlaybackAutoRepeatMode::Track,
                    Some(1) => windows::Media::MediaPlaybackAutoRepeatMode::List,
                    _ => windows::Media::MediaPlaybackAutoRepeatMode::None,
                };
                s.TryChangeAutoRepeatModeAsync(mode).ok().and_then(|op| op.get().ok())
            }
            _ => None,
        };
        if res == Some(true) {
            return true;
        }
    }
    false
}

#[tauri::command]
fn media_control(action: String, value: Option<f64>) -> Result<bool, String> {
    #[cfg(windows)]
    {
        {
            let mut guard = LAST_TRACK.lock();
            if let Some((_, ts)) = guard.as_mut() {
                *ts = std::time::Instant::now();
            }
        }

        let winrt_ok = native_media_control(&action, value);

        unsafe {
            use windows::Win32::UI::Input::KeyboardAndMouse::{
                keybd_event, KEYEVENTF_KEYUP, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK,
                VK_VOLUME_DOWN, VK_VOLUME_MUTE, VK_VOLUME_UP, VIRTUAL_KEY,
            };
            let vk: Option<VIRTUAL_KEY> = match action.as_str() {
                "playPause" | "toggle" => Some(VK_MEDIA_PLAY_PAUSE),
                "next" => Some(VK_MEDIA_NEXT_TRACK),
                "previous" | "prev" => Some(VK_MEDIA_PREV_TRACK),
                "volumeUp" => Some(VK_VOLUME_UP),
                "volumeDown" => Some(VK_VOLUME_DOWN),
                "mute" => Some(VK_VOLUME_MUTE),
                "seek" | "shuffle" | "repeat" => None,
                _ => return Err(format!("Bilinmeyen medya eylemi: {action}")),
            };
            if let Some(key) = vk {
                if action == "volumeUp" || action == "volumeDown" {
                    for _ in 0..4 {
                        keybd_event(key.0 as u8, 0, Default::default(), 0);
                        keybd_event(key.0 as u8, 0, KEYEVENTF_KEYUP, 0);
                    }
                } else if !winrt_ok {
                    keybd_event(key.0 as u8, 0, Default::default(), 0);
                    keybd_event(key.0 as u8, 0, KEYEVENTF_KEYUP, 0);
                }
            }
            Ok(true)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (action, value);
        Ok(false)
    }
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    // Bound to its server's address: only local_set_key may store it.
    if key == local_chat::CUSTOM_KEY {
        return Err("use local_set_key".into());
    }
    let before = (key == "github-token").then(|| secrets::get(&key));
    secrets::set(&key, &value)?;
    if key == claude::KEY {
        voice::sync(&app);
    }
    if let Some(before) = before {
        if secrets::get(&key) != before {
            integrations::github_token_changed(&app);
        }
    }
    Ok(())
}

#[tauri::command]
fn secret_clear(app: AppHandle, key: String) -> Result<(), String> {
    let had = key == "github-token" && secrets::present(&key);
    secrets::clear(&key)?;
    if key == claude::KEY {
        voice::sync(&app);
    }
    if had {
        integrations::github_token_changed(&app);
    }
    Ok(())
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// The GitHub card was opened: refetch its `section` ("pulse" or "activity")
/// if it is stale. The pollers still decline while the pill is off or paused.
#[tauri::command]
fn github_refresh(section: String) {
    integrations::github_refresh_if_stale(&section);
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}
#[tauri::command]
fn calendar_list() -> Result<Vec<calendar::CalendarItem>, String> {
    calendar::list_items()
}

#[tauri::command]
fn calendar_save(item: calendar::CalendarItem) -> Result<calendar::CalendarItem, String> {
    calendar::save_item(item)
}

#[tauri::command]
fn calendar_toggle(id: String) -> Result<calendar::CalendarItem, String> {
    calendar::toggle_item(&id)
}

#[tauri::command]
fn calendar_delete(id: String) -> Result<(), String> {
    calendar::delete_item(&id)
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

/// How each global shortcut went: registered, taken by another app, and so on.
#[tauri::command]
fn shortcuts_status(app: AppHandle) -> shortcuts::Report {
    shortcuts::status(&app)
}

/// Settings is recording a new combination: let go of ours meanwhile, so the
/// keys reach the recorder instead of running an action. `false` takes them back.
#[tauri::command]
fn shortcuts_suspend(app: AppHandle, shared: State<Shared>, suspended: bool) {
    if suspended {
        shortcuts::suspend(&app);
    } else {
        let stored = shared.settings.lock().unwrap().shortcuts.clone();
        shortcuts::apply(&app, &stored);
    }
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The Coucou window (Flow dictation, the Notetaker and every setting of the
/// island), labelled "settings" since it grew out of the settings window.
pub const HUB_LABEL: &str = "settings";

/// The Coucou window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, HUB_LABEL, url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Omi")
        .inner_size(1100.0, 720.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            if let Some(icon) = app.default_window_icon() {
                let _ = win.set_icon(icon.clone());
            }
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("Coucou window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    show_hub(app, Some("general"));
}

/// Shows the Coucou window, on `page` when given ("dictation", "notes",
/// "settings", "general", "shortcuts"…).
pub fn show_hub(app: &AppHandle, page: Option<&str>) {
    let Some(win) = app.get_webview_window(HUB_LABEL) else {
        log::line("Coucou window missing");
        return;
    };
    if let Some(icon) = app.default_window_icon() {
        let _ = win.set_icon(icon.clone());
    }
    if let Some(page) = page {
        let _ = win.emit("hub-page", page.to_string());
    }
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}


/// Synchronises the OS autostart entry with `enabled`.
/// On Windows, registers the release executable if in development mode or if built,
/// preventing the Vite localhost:1420 dev server error from appearing on boot.
fn sync_autostart(_app: &AppHandle, enabled: bool) {
    #[cfg(windows)]
    {
        use winreg::enums::RegType::REG_BINARY;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        use winreg::{RegKey, RegValue};

        const AL_REGKEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
        const TASK_MANAGER_OVERRIDE_REGKEY: &str =
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
        const TASK_MANAGER_OVERRIDE_ENABLED_VALUE: [u8; 12] = [
            0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        if enabled {
            let is_dev = cfg!(debug_assertions) || cfg!(dev);
            let current = std::env::current_exe().unwrap_or_default();

            let exe_to_register = if is_dev {
                let release_exe = current
                    .ancestors()
                    .nth(2)
                    .map(|d| d.join("release").join("omi.exe"))
                    .filter(|p| p.exists());
                if release_exe.is_none() {
                    log::line("autostart: skipping dev executable registration into Windows startup; build release first");
                }
                release_exe
            } else {
                Some(current)
            };

            if let Some(exe) = exe_to_register {
                if let Ok(run_key) = hkcu.open_subkey_with_flags(AL_REGKEY, KEY_SET_VALUE) {
                    let cmd = format!("\"{}\" {}", exe.display(), AUTOSTART_ARG);
                    let _ = run_key.set_value("Omi", &cmd);
                }
                if let Ok(reg) = hkcu.open_subkey_with_flags(TASK_MANAGER_OVERRIDE_REGKEY, KEY_SET_VALUE) {
                    let _ = reg.set_raw_value(
                        "Omi",
                        &RegValue {
                            vtype: REG_BINARY,
                            bytes: TASK_MANAGER_OVERRIDE_ENABLED_VALUE.to_vec(),
                        },
                    );
                }
            }
        } else if let Ok(run_key) = hkcu.open_subkey_with_flags(AL_REGKEY, KEY_SET_VALUE) {
            let _ = run_key.delete_value("Omi");
        }
    }
    #[cfg(not(windows))]
    {
        let manager = app.autolaunch();
        let result = if enabled { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
}
/// The argument the login item starts Coucou with.
const AUTOSTART_ARG: &str = "--autostart";

/// Coucou started with the computer, not opened by the user: the window stays hidden.
pub fn launched_at_login() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

#[tauri::command]
fn open_settings_window(app: AppHandle, page: Option<String>) {
    show_hub(&app, Some(page.as_deref().unwrap_or("general")));
}


pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    i18n::set_picked(&loaded.language);
    let gate = Arc::new(PollGate::new());

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // `coucou --shortcut <action>`: what a desktop's own keyboard
            // settings run where we can't listen for keys ourselves (Wayland).
            match shortcuts::from_args(&argv) {
                Some(action) => shortcuts::dispatch(app, action),
                // Opening Coucou again (its shortcut, the Start menu) shows its window.
                None => show_hub(app, None),
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])));
    // Where no global shortcut can work, the plugin isn't even started.
    if platform::global_shortcuts_blocked().is_none() {
        builder = builder.plugin(shortcuts::plugin());
    }

    builder
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage(shortcuts::Registry::default())
        .manage(recap::load())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_system_languages,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            fit_zoom,
            list_monitors,
            open_url,
            open_in_vscode,
            open_session,
            open_claude_desktop,
            open_antigravity,
            get_learned_rules,
            save_learned_rule,
            delete_learned_rule,
            open_file_in_vscode,
            quit_app,
            hooks_status,
            agent_hooks_status,
            hooks_preview,
            hooks_apply,
            hooks_auto_install,
            auto_install_pill_hook,
            agent_hooks_list,
            agent_hooks_preview,
            agent_hooks_apply,
            status_line_preview,
            status_line_apply,
            codex_plan_usage,
            approval_decision,
            approval_answer,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_models,
            local_connect,
            local_set_key,
            chat_reset,
            chat_restore,
            antigravity_accounts,
            antigravity_switch,
            antigravity_login,
            antigravity_import_json,
            antigravity_export_json,
            antigravity_export_file,
            antigravity_export_dialog,
            battery_status,
            get_current_dir,
            set_current_dir,
            pick_directory,
            ingest_file,
            take_screenshot,
            computer_use::execute_computer_action,
            execute_playwright_action,
            execute_browser_use_action,
            save_temp_image,
            detect_now_playing,
            get_system_stats,
            media_control,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            github_refresh,
            github_oauth_connect,
            open_n8n,
            calendar_list,
            calendar_save,
            calendar_toggle,
            calendar_delete,
            open_settings_window,
            set_paused,
            shortcuts_status,
            shortcuts_suspend,
            phone_link::phone_link_status,
            phone_link::phone_link_set_enabled,
            phone_link::phone_link_pairing,
            phone_link::phone_link_new_pairing,
            phone_link::phone_link_publish,
            phone_link::phone_link_publish_question,
            phone_link::phone_link_publish_prefs,
            phone_link::phone_answers_status,
            phone_link::phone_answers_set_enabled,
            phone_link::phone_diffs_status,
            phone_link::phone_diffs_set_enabled,
            phone_link::phone_link_send_diff,
            phone_link::phone_usage_status,
            phone_link::phone_usage_set_enabled,
            phone_link::phone_relay_status,
            phone_link::phone_relay_set,
            phone_link::phone_relay_set_access,
            phone_link::phone_link_publish_usage,
            phone_link::phone_services_status,
            phone_link::phone_services_set,
            phone_link::phone_link_publish_services,
            phone_link::phone_details_status,
            phone_link::phone_details_set_enabled,
            phone_link::phone_chat_status,
            phone_link::phone_chat_set_enabled,
            phone_link::phone_chat_set_models,
            recap::recap_history,
            recap::recap_prefs,
            recap::recap_set_enabled,
            recap::recap_set_hide_projects,
            recap::recap_mark_shown,
            recap::recap_clear,
            recap::recap_save_png,
            recap::recap_reveal_saved,
            desktop::desktop_mochi_info,
            desktop::desktop_mochi_pick_up,
            desktop::desktop_mochi_carry,
            desktop::desktop_mochi_carry_end,
            desktop::desktop_mochi_drag_begin,
            desktop::desktop_mochi_drag_move,
            desktop::desktop_mochi_drag_end,
            desktop::desktop_mochi_fly_out,
            desktop::desktop_mochi_fly_home,
            desktop::desktop_mochi_set_asleep,
            desktop::desktop_mochi_hide,
            sounds::custom_sounds,
            sounds::custom_sound,
            sounds::reveal_sounds_folder,
            sounds::reload_sounds,
            spotify::spotify_refresh,
            spotify::spotify_control,
            spotify::spotify_open,
            spotify::spotify_installed,
            flow::flow_status,
            flow::flow_set_prefs,
            flow::flow_history,
            flow::flow_delete,
            flow::flow_clear,
            flow::flow_stats,
            flow::flow_words,
            flow::flow_set_words,
            flow::flow_snippets,
            flow::flow_set_snippets,
            flow::flow_styles,
            flow::flow_set_styles,
            flow::flow_running_apps,
            flow::flow_copy,
            flow::flow_paste_again,
            flow::flow_models_download,
            flow::flow_models_remove,
            flow::pill_state,
            flow::pill_hot,
            flow::pill_hover,
            flow::pill_action,
            notes::notes_state,
            notes::notes_start,
            notes::notes_stop,
            notes::notes_rename,
            notes::notes_rename_speaker,
            notes::notes_toggle_todo,
            notes::notes_delete,
            notes::notes_summarize,
            notes::notes_retry,
            notes::notes_markdown,
            notes::notes_export,
            voice::voice_done,
            voice::voice_say_native,
            voice::voice_stop_piper,
            voice::voice_toggle_conversation,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            app.manage(phone_link::PhoneLink::new(handle.clone()));
            let desktop = get_desktop_dir();
            let _ = std::env::set_current_dir(&desktop);
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
            // Same rule for Mochi's desktop window and the dictation pill.
            desktop::setup(&handle);
            flow::setup(&handle);
            notes::setup(&handle);

            if let Some(win) = island::window(&handle) {
                // Where Tauri takes the drop itself (Linux), its paths are the
                // ones ingest_file may copy (files.rs).
                win.on_window_event(|event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        files::allow_dropped(paths.iter().map(|p| p.to_string_lossy().to_string()));
                    }
                });
                platform::make_non_activating(&win);
                #[cfg(windows)]
                webview_drop::install(&handle);
                let at_login = launched_at_login();
                island::apply_geometry(&handle, &loaded.screen, at_login);
                let _ = win.show();
            }
            let at_login = launched_at_login();
            gate.collapsed.store(at_login, Ordering::Relaxed);
            if at_login || !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            spotify::sync(&handle, &loaded.active_integrations);
            shortcuts::apply(&handle, &loaded.shortcuts);
            game_mode::spawn_game_mode_watcher(handle.clone());
            if loaded.autostart {
                sync_autostart(&handle, true);
            }
            let open_window = flow::get(&handle).map(|f| f.store.lock().unwrap().prefs.open_at_launch).unwrap_or(true);
            if open_window && !at_login {
                show_hub(&handle, None);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Coucou")
        .run(|app, event| {
            // Withdraw the phone link's announcement on the local network before the process ends.
            if let tauri::RunEvent::Exit = event {
                voice::stop_piper();
                laya::stop_daemon();
                phone_link::stop_on_exit(app);
                notes::shutdown(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::diff_file;

    #[test]
    fn only_an_existing_file_by_its_full_path_reaches_the_editor() {
        let dir = std::env::temp_dir().join(format!("coucou-diff-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("edited.ts");
        std::fs::write(&file, "x").unwrap();

        assert!(diff_file(&file.to_string_lossy()).is_some());
        // A folder, a missing file, a relative path or an option never pass.
        assert!(diff_file(&dir.to_string_lossy()).is_none());
        assert!(diff_file(&dir.join("missing.ts").to_string_lossy()).is_none());
        assert!(diff_file("edited.ts").is_none());
        assert!(diff_file("--help").is_none());
        assert!(diff_file("").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
