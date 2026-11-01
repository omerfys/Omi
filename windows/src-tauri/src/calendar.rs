// Calendar and daily planner storage for Coucou / Omi.
// Saves tasks and events to %APPDATA%\omi\calendar.json.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarItem {
    pub id: String,
    pub date: String,            // "YYYY-MM-DD"
    #[serde(default)]
    pub time: Option<String>,    // "HH:MM"
    pub title: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default = "default_priority")]
    pub priority: String,        // "low" | "medium" | "high"
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default = "now_millis")]
    pub created_at: i64,
}

fn default_priority() -> String {
    "medium".to_string()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

static LOCK: Mutex<()> = Mutex::new(());

fn calendar_path() -> PathBuf {
    crate::platform::config_dir().join("calendar.json")
}

pub fn list_items() -> Result<Vec<CalendarItem>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let path = calendar_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let items: Vec<CalendarItem> = serde_json::from_str(&data).unwrap_or_default();
    Ok(items)
}

fn save_all(items: &[CalendarItem]) -> Result<(), String> {
    let path = calendar_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let data = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save_item(item: CalendarItem) -> Result<CalendarItem, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let path = calendar_path();
    let mut items: Vec<CalendarItem> = if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    };

    if let Some(pos) = items.iter().position(|i| i.id == item.id) {
        items[pos] = item.clone();
    } else {
        items.push(item.clone());
    }

    save_all(&items)?;
    Ok(item)
}

pub fn toggle_item(id: &str) -> Result<CalendarItem, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let path = calendar_path();
    if !path.exists() {
        return Err("Takvim verisi bulunamadı".to_string());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut items: Vec<CalendarItem> = serde_json::from_str(&data).unwrap_or_default();

    if let Some(pos) = items.iter().position(|i| i.id == id) {
        items[pos].done = !items[pos].done;
        let updated = items[pos].clone();
        save_all(&items)?;
        Ok(updated)
    } else {
        Err("Görev bulunamadı".to_string())
    }
}

pub fn delete_item(id: &str) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let path = calendar_path();
    if !path.exists() {
        return Ok(());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut items: Vec<CalendarItem> = serde_json::from_str(&data).unwrap_or_default();

    items.retain(|i| i.id != id);
    save_all(&items)?;
    Ok(())
}
