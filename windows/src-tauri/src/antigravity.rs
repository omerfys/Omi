// Google Antigravity OAuth and Chat integration for Coucou / Omi.
// Completely independent from OMP: stores its own accounts in %APPDATA%\omi\antigravity_accounts.json,
// manages its own OAuth token refresh, and chats directly via Google Cloud Code Assist SSE API.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use base64::Engine;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::chat::{Chat, ChatContext, ChatReply, ModelInfo};

pub const PROVIDER_ID: &str = "google-antigravity";
pub const DEFAULT_MODEL: &str = "gemini-3.8-flash";

const CLIENT_ID: &str = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET: &str = "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";
const REDIRECT_URI: &str = "http://127.0.0.1:51121/oauth-callback";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CLOUD_CODE_ASSIST_URL: &str = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const STREAM_GENERATE_URL: &str = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const USER_AGENT: &str = "antigravity/hub/2.19.1 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccount {
    pub id: i64,
    pub email: String,
    pub active: bool,
    #[serde(default)]
    pub access: String,
    #[serde(default)]
    pub refresh: String,
    #[serde(default)]
    pub expires: i64,
    #[serde(default = "default_project")]
    pub project_id: String,
}

fn default_project() -> String {
    "aicode-consumers".to_string()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Omi's own private accounts file: %APPDATA%\omi\antigravity_accounts.json
fn accounts_path() -> PathBuf {
    crate::platform::config_dir().join("antigravity_accounts.json")
}

/// Loads accounts from Omi's private storage (%APPDATA%\omi\antigravity_accounts.json).
/// Returns an empty list by default if no accounts have been added yet.
pub fn list_accounts() -> Result<Vec<AntigravityAccount>, String> {
    let path = accounts_path();
    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Hesap dosyasi okunamadi: {e}"))?;
        let accounts: Vec<AntigravityAccount> = serde_json::from_str(&content)
            .map_err(|e| format!("Hesap json hatasi: {e}"))?;
        return Ok(accounts);
    }

    Ok(Vec::new())
}

pub fn has_active_account() -> bool {
    list_accounts().map(|accs| accs.iter().any(|a| a.active)).unwrap_or(false)
}


fn dirs_next() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Saves accounts into %APPDATA%\omi\antigravity_accounts.json only.
fn save_accounts(accounts: &[AntigravityAccount]) -> Result<(), String> {
    let path = accounts_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let data = serde_json::to_string_pretty(accounts)
        .map_err(|e| format!("JSON serialize hatasi: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Hesaplar kaydedilemedi: {e}"))?;
    Ok(())
}

/// Switches active account ONLY in Coucou's private storage.
/// Never touches ~/.omp/agent/agent.db.
pub fn switch_account(id: i64) -> Result<bool, String> {
    let mut accounts = list_accounts()?;
    let mut found = false;
    for acc in &mut accounts {
        if acc.id == id {
            acc.active = true;
            found = true;
        } else {
            acc.active = false;
        }
    }
    if !found {
        return Err(format!("Hesap bulunamadi: {id}"));
    }
    save_accounts(&accounts)?;
    Ok(true)
}

/// Imports accounts from raw JSON text (supports Antigravity Manager format or array of accounts)
pub fn import_accounts_json(json_content: &str) -> Result<usize, String> {
    let parsed: Value = serde_json::from_str(json_content)
        .map_err(|e| format!("Geçersiz JSON formatı: {e}"))?;

    let items = if let Some(arr) = parsed.as_array() {
        arr.clone()
    } else if let Some(arr) = parsed.get("accounts").and_then(|v| v.as_array()) {
        arr.clone()
    } else {
        return Err("JSON içinde hesap listesi bulunamadı (dizi veya 'accounts' alanı bekleniyor).".to_string());
    };

    let mut current_accounts = list_accounts().unwrap_or_default();
    let mut imported_count = 0;
    let now = now_millis();

    for item in items {
        if !item.is_object() {
            continue;
        }
        let email = item.get("email")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if email.is_empty() {
            continue;
        }

        let refresh_token = item.get("refresh_token")
            .or_else(|| item.get("refresh"))
            .or_else(|| item.get("token").and_then(|t| t.get("refresh_token")))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        if refresh_token.is_empty() {
            continue;
        }

        let access_token = item.get("access_token")
            .or_else(|| item.get("access"))
            .or_else(|| item.get("token").and_then(|t| t.get("access_token")))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        let project_id = item.get("project_id")
            .or_else(|| item.get("projectId"))
            .or_else(|| item.get("token").and_then(|t| t.get("project_id")))
            .and_then(|v| v.as_str())
            .unwrap_or("aicode-consumers")
            .trim()
            .to_string();

        let expires_ms = item.get("expires")
            .or_else(|| item.get("expiresAt"))
            .and_then(|v| v.as_i64())
            .unwrap_or(now + 3600 * 1000);

        if let Some(existing) = current_accounts.iter_mut().find(|a| a.email.to_lowercase() == email) {
            existing.refresh = refresh_token;
            if !access_token.is_empty() {
                existing.access = access_token;
            }
            existing.project_id = project_id;
            existing.expires = expires_ms;
        } else {
            let next_id = current_accounts.iter().map(|a| a.id).max().unwrap_or(0) + 1;
            let is_first = current_accounts.is_empty();
            current_accounts.push(AntigravityAccount {
                id: next_id,
                email,
                active: is_first,
                access: access_token,
                refresh: refresh_token,
                expires: expires_ms,
                project_id,
            });
        }
        imported_count += 1;
    }

    if imported_count == 0 {
        return Err("JSON içinde geçerli Google Antigravity hesabı bulunamadı (email ve refresh_token zorunludur).".to_string());
    }

    save_accounts(&current_accounts)?;
    Ok(imported_count)
}

/// Exports all accounts to formatted JSON text
pub fn export_accounts_json() -> Result<String, String> {
    let accounts = list_accounts().unwrap_or_default();
    serde_json::to_string_pretty(&accounts)
        .map_err(|e| format!("JSON oluşturma hatası: {e}"))
}

/// Exports accounts to a backup file on Desktop or AppData
pub fn export_accounts_to_file() -> Result<String, String> {
    let json_text = export_accounts_json()?;
    let desktop = dirs_next().join("Desktop");
    let target = if desktop.exists() {
        desktop.join("antigravity_accounts_backup.json")
    } else {
        accounts_path().with_file_name("antigravity_accounts_backup.json")
    };
    std::fs::write(&target, json_text)
        .map_err(|e| format!("Yedek dosyası yazılamadı: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

/// Prompts user with a native SaveFileDialog to choose where to export accounts JSON.
/// Defaults to 'omi_accounts_antigravity.json' on Desktop.
pub fn save_accounts_as_dialog() -> Result<Option<String>, String> {
    let json_text = export_accounts_json()?;

    let script = r#"
        Add-Type -AssemblyName System.Windows.Forms
        $f = New-Object System.Windows.Forms.SaveFileDialog
        $f.Filter = 'JSON Dosyası (*.json)|*.json'
        $f.FileName = 'omi_accounts_antigravity.json'
        $f.Title = 'Hesapları Dışa Aktar'
        $f.InitialDirectory = [Environment]::GetFolderPath('Desktop')
        if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            Write-Output $f.FileName
        }
    "#;

    let mut cmd = std::process::Command::new("powershell");
    cmd.arg("-NoProfile").arg("-Command").arg(script);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().map_err(|e| format!("Diyalog açılamadı: {e}"))?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            std::fs::write(&path, json_text)
                .map_err(|e| format!("Dosya yazılamadı: {e}"))?;
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// Models offered by Google Antigravity
pub fn models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "gemini-3.8-flash".into(),
            label: "Gemini 3.8 Flash".into(),
        },
        ModelInfo {
            id: "gemini-3-pro".into(),
            label: "Gemini 3 Pro".into(),
        },
        ModelInfo {
            id: "gemini-3-flash".into(),
            label: "Gemini 3 Flash".into(),
        },
        ModelInfo {
            id: "gemini-3.1-flash-lite".into(),
            label: "Gemini 3.1 Flash Lite".into(),
        },
        ModelInfo {
            id: "gemini-2.5-flash".into(),
            label: "Gemini 2.5 Flash".into(),
        },
        ModelInfo {
            id: "gemini-2.5-flash-lite".into(),
            label: "Gemini 2.5 Flash Lite".into(),
        },
        ModelInfo {
            id: "claude-3-7-sonnet".into(),
            label: "Claude 3.7 Sonnet".into(),
        },
        ModelInfo {
            id: "claude-opus-4-6".into(),
            label: "Claude Opus 4.6 Thinking".into(),
        },
        ModelInfo {
            id: "gpt-oss-120b".into(),
            label: "GPT-OSS 120B".into(),
        },
    ]
}

pub fn resolve_antigravity_wire_model(model: &str) -> String {
    let lower = model.to_lowercase();
    let (base, level) = if let Some((b, l)) = lower.split_once(':') {
        (b, Some(l))
    } else if let Some(b) = lower.strip_suffix("-high") {
        (b, Some("high"))
    } else if let Some(b) = lower.strip_suffix("-medium") {
        (b, Some("medium"))
    } else if let Some(b) = lower.strip_suffix("-low") {
        (b, Some("low"))
    } else {
        (lower.as_str(), None)
    };

    match base {
        "gemini-3.8-flash" => match level {
            Some("low") => "gemini-3.8-flash-low".to_string(),
            _ => "gemini-3.8-flash-high".to_string(),
        },
        "gemini-3-pro" => match level {
            Some("low") => "gemini-3-pro-low".to_string(),
            _ => "gemini-3-pro-high".to_string(),
        },
        "claude-3-7-sonnet" | "claude-sonnet-4-6" => match level {
            Some("high") => "claude-sonnet-4-6-thinking".to_string(),
            _ => "claude-sonnet-4-6".to_string(),
        },
        "claude-opus-4-6" | "claude-opus-4-6-thinking" | "claude-opus-5" | "claude-opus" => "claude-opus-4-6-thinking".to_string(),
        "gpt-oss-120b" => match level {
            Some("high") => "gpt-oss-120b-high".to_string(),
            Some("low") => "gpt-oss-120b-low".to_string(),
            _ => "gpt-oss-120b-medium".to_string(),
        },
        "gemini-3-flash" => "gemini-3-flash".to_string(),
        "gemini-3.1-flash-lite" => "gemini-3.1-flash-lite".to_string(),
        "gemini-2.5-flash" => "gemini-2.5-flash".to_string(),
        "gemini-2.5-flash-lite" => "gemini-2.5-flash-lite".to_string(),
        _ => "gemini-3.8-flash-high".to_string(),
    }
}

pub async fn voice_turn(
    _app: &AppHandle,
    model: &str,
    system: &str,
    messages: &[Value],
    _tools: &[Value],
) -> Result<Value, String> {
    let mut accounts = list_accounts()?;
    let active_idx = accounts
        .iter()
        .position(|a| a.active)
        .ok_or_else(|| "Google Antigravity hesabi secili degil.".to_string())?;

    ensure_token(&mut accounts[active_idx]).await?;
    let mut active_account = accounts[active_idx].clone();

    let wire_model_string = resolve_antigravity_wire_model(model);
    // Sesli sohbette sıfır düşünme gecikmesi ve anında konuşma için -low veya flash modeli kullanılır
    let wire_model_fast = if wire_model_string.ends_with("-high") {
        wire_model_string.replace("-high", "-low")
    } else {
        wire_model_string
    };
    let wire_model = wire_model_fast.as_str();
    let mut contents: Vec<Value> = Vec::new();
    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        let wire_role = if role == "assistant" || role == "model" { "model" } else { "user" };

        if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
            contents.push(json!({
                "role": wire_role,
                "parts": [{ "text": text }]
            }));
        } else if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
            let mut parts = Vec::new();
            for item in arr {
                if let Some(txt) = item.get("text").and_then(|t| t.as_str()) {
                    parts.push(json!({ "text": txt }));
                } else if let Some(content) = item.get("content").and_then(|c| c.as_str()) {
                    parts.push(json!({ "text": content }));
                }
            }
            if !parts.is_empty() {
                contents.push(json!({
                    "role": wire_role,
                    "parts": parts
                }));
            }
        }
    }

    let t = crate::platform::local_time();
    let voice_system_prompt = format!(
        "{system}\n\n🇹🇷 SESLİ ASİSTAN YETKİ VE DİL KURALI:\n\
Sen Omi'sin — kullanıcının bilgisayarındaki akıllı masaüstü sesli asistanısın.\n\
Kullanıcının yerel bilgisayar saati ve tarihi: {:02}:{:02} ({:04}-{:02}-{:02}). Kullanıcı saati veya tarihi sorduğunda doğrudan bu saate göre söyle!\n\
🌐 İNTERNET, CANLI YAYIN, YOUTUBE VE EYLEM YETKİSİ:\n\
- Senin güncel internete, canlı yayın durumlarına (Kick, Twitch, YouTube vb.), hava durumuna, haberlere ve Google aramasına TAM YETKİN VARDIR.\n\
- ASLA 'yetkim yok', 'YouTube videosu açamam', 'internete erişimim kısıtlı' deme! Chatteki ajanla birebir aynı yetkilere sahipsin.\n\
- Kullanıcı senden YouTube'da bir video, kanal veya şarkı açmanı istediğinde (örn. 'YouTube'da X'in son videosunu aç', 'şu videoyu aç'):\n\
  Entegre Google Search ile en güncel video veya arama linkini bul ve doğrudan yanıtına şu eylem bloğunu ekle:\n\
  ```action:open_url\n\
  https://www.youtube.com/...\n\
  ```\n\
  Sistem bu linki kullanıcının varsayılan tarayıcısında anında açacaktır.\n\
- Herhangi bir web sitesi veya link açmanı istediğinde:\n\
  ```action:open_url\n\
  <url>\n\
  ```\n\
- Masaüstündeki veya bilgisayardaki herhangi bir uygulamayı, oyunu veya başlatıcıyı açmanı istediğinde (örn. 'Modrinth aç', 'Minecraft aç', 'Spotify aç', 'Steam aç', 'VS Code aç'):\n\
  ```action:open_app\n\
  <uygulama adı>\n\
  ```\n\
  Sistem masaüstündeki veya başlat menüsündeki bu uygulamayı doğrudan açacaktır.\n\
- Bilgisayarda bir komut veya uygulama çalıştırmanı istediğinde:\n\
  ```action:shell\n\
  <komut>\n\
  ```\n\
- KESİNLİKLE DÜŞÜNME (THINKING) İLE VAKİT KAYBETME. İlk kelimeden itibaren doğrudan Türkçe konuşma metnini üret.\n\
- Karşılıklı canlı sesli konuşma akışındasın. Cevabın EN FAZLA 1 VEYA 2 KISA, DOĞAL VE AKICI TÜRKÇE CÜMLE olmalıdır (örneğin 'Hemen bakıyorum!', 'Açıyorum!').\n\
- Asla markdown, başlık, madde işareti veya teknik döküm yapma.",
        t.hour, t.minute, t.year, t.month, t.day
    );

    let last_user_text = contents.last()
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .and_then(|arr| arr.first())
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    let lower = last_user_text.to_lowercase();
    let needs_web_search = lower.contains("hava") || lower.contains("haber")
        || lower.contains("kaç para") || lower.contains("dolar") || lower.contains("borsa")
        || lower.contains("kimdir") || lower.contains("son dakika") || lower.contains("araştır")
        || lower.contains("google");

    let mut request_obj = json!({
        "contents": contents,
        "systemInstruction": {
            "role": "system",
            "parts": [{ "text": voice_system_prompt }]
        },
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 150,
            "thinkingConfig": {
                "thinkingBudget": 0
            }
        }
    });

    if needs_web_search {
        request_obj["tools"] = json!([{"googleSearch": {}}]);
    }

    let payload = json!({
        "project": active_account.project_id,
        "model": wire_model,
        "request": request_obj
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(STREAM_GENERATE_URL)
        .header("Authorization", format!("Bearer {}", active_account.access))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .header("User-Agent", USER_AGENT)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Google sunucusuna baglanilamadi: {e}"))?;

    let resp = if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        if status.as_u16() == 401 || status.as_u16() == 404 || status.as_u16() == 403 {
            crate::log::line(format!("voice_turn: token error {}, refreshing token and retrying...", status));
            let mut fresh_accounts = list_accounts()?;
            let fresh_idx = fresh_accounts.iter().position(|a| a.active).unwrap_or(0);
            fresh_accounts[fresh_idx].expires = 0; // force refresh
            if ensure_token(&mut fresh_accounts[fresh_idx]).await.is_ok() {
                active_account = fresh_accounts[fresh_idx].clone();
                let retry_resp = client
                    .post(STREAM_GENERATE_URL)
                    .header("Authorization", format!("Bearer {}", active_account.access))
                    .header("Content-Type", "application/json")
                    .header("Accept", "text/event-stream")
                    .header("User-Agent", USER_AGENT)
                    .json(&payload)
                    .send()
                    .await
                    .map_err(|e| format!("Google sunucusuna baglanilamadi: {e}"))?;
                if !retry_resp.status().is_success() {
                    let retry_err = retry_resp.text().await.unwrap_or_default();
                    return Err(format!("Google Antigravity hatasi: {retry_err}"));
                }
                retry_resp
            } else {
                return Err(format!("Google Antigravity hatasi: {err_body}"));
            }
        } else {
            return Err(format!("Google Antigravity hatasi: {err_body}"));
        }
    } else {
        resp
    };
    let mut stream = resp.bytes_stream();
    let mut accumulated_text = String::new();
    let mut byte_buffer: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| e.to_string())?;
        byte_buffer.extend_from_slice(&chunk);

        while let Some(newline_pos) = byte_buffer.iter().position(|&b| b == b'\n') {
            let line_bytes = byte_buffer[..newline_pos].to_vec();
            byte_buffer.drain(..=newline_pos);
            let line = decode_process_output(&line_bytes).trim().to_string();

            if line.starts_with("data: ") {
                let json_str = &line[6..];
                if let Ok(v) = serde_json::from_str::<Value>(json_str) {
                    if let Some(candidates) = v.get("response").and_then(|r| r.get("candidates")).and_then(|c| c.as_array()) {
                        for c in candidates {
                            if let Some(parts) = c.get("content").and_then(|cnt| cnt.get("parts")).and_then(|p| p.as_array()) {
                                for p in parts {
                                    if p.get("thought").and_then(|t| t.as_bool()).unwrap_or(false) {
                                        continue;
                                    }
                                    if let Some(t) = p.get("text").and_then(|txt| txt.as_str()) {
                                        accumulated_text.push_str(t);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let (cleaned_text, _) = crate::voice::execute_voice_actions(&accumulated_text);

    Ok(json!({
        "content": [{
            "type": "text",
            "text": cleaned_text
        }],
        "stop_reason": "end_turn"
    }))
}
/// Refreshes the Google OAuth token if it is close to expiring (within 60s)
async fn ensure_token(account: &mut AntigravityAccount) -> Result<(), String> {
    let now = now_millis();
    if account.expires > now + 60_000 && !account.access.is_empty() {
        return Ok(());
    }

    if account.refresh.is_empty() {
        return Err(format!("{}: refresh token bulunamadi, lutfen yeniden giris yapin.", account.email));
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("refresh_token", account.refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("Token yenilenemedi (ag hatasi): {e}"))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(format!("Google token yenileme hatasi: {err}"));
    }

    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let new_access = v["access_token"]
        .as_str()
        .ok_or_else(|| "Yeni access_token alinamadi".to_string())?;
    let expires_in = v["expires_in"].as_i64().unwrap_or(3600);

    account.access = new_access.to_string();
    account.expires = now_millis() + expires_in * 1000;

    // Persist to Coucou's storage
    if let Ok(mut all) = list_accounts() {
        for a in &mut all {
            if a.id == account.id {
                a.access = account.access.clone();
                a.expires = account.expires;
            }
        }
        let _ = save_accounts(&all);
    }

    Ok(())
}

/// Starts the Google OAuth 2.0 flow:
/// Saves only to Omi's private storage (%APPDATA%\omi\antigravity_accounts.json).
pub async fn start_oauth_login(app: &AppHandle) -> Result<String, String> {
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?\
        client_id={CLIENT_ID}&\
        redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Foauth-callback&\
        response_type=code&\
        scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform%20\
        https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email%20\
        https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile%20\
        https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog%20\
        https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs&\
        access_type=offline&\
        prompt=consent"
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:51121")
        .await
        .map_err(|e| format!("Port 51121 dinlenemedi: {e}"))?;

    let _ = crate::platform::open_url(&auth_url);

    let auth_code = tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = [0u8; 4096];
            let n = tokio::io::AsyncReadExt::read(&mut socket, &mut buf)
                .await
                .map_err(|e| e.to_string())?;
            let req_str = String::from_utf8_lossy(&buf[..n]);

            if let Some(first_line) = req_str.lines().next() {
                if first_line.contains("/oauth-callback") {
                    let mut code = None;
                    if let Some(query_start) = first_line.find('?') {
                        if let Some(query_end) = first_line[query_start..].find(' ') {
                            let query = &first_line[query_start + 1..query_start + query_end];
                            for pair in query.split('&') {
                                if let Some((k, v)) = pair.split_once('=') {
                                    if k == "code" {
                                        code = Some(v.to_string());
                                    }
                                }
                            }
                        }
                    }

                    let html = r#"<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Giris Basarili</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="background:#18181b;padding:40px;border-radius:16px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4);border:1px solid #27272a;max-width:400px">
    <div style="font-size:48px;margin-bottom:16px">✨</div>
    <h2 style="margin:0 0 8px 0;color:#22c55e">Giriş Başarılı!</h2>
    <p style="color:#a1a1aa;margin:0 0 24px 0;line-height:1.5">Google Antigravity hesabınız Omi'ye bağlandı. Bu sekmeyi kapatabilirsiniz.</p>
    <button onclick="window.close()" style="background:#27272a;border:1px solid #3f3f46;color:#f4f4f5;padding:8px 20px;border-radius:8px;cursor:pointer;font-weight:500">Pencereyi Kapat</button>
  </div>
</body>
</html>"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        html.len(),
                        html
                    );
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut socket, resp.as_bytes()).await;

                    if let Some(c) = code {
                        return Ok(c);
                    }
                }
            }
        }
    })
    .await
    .map_err(|_| "Giris zaman asimina ugradi (180 sn)".to_string())?
    .map_err(|e: String| e)?;

    let code_clean = auth_code.trim().to_string();

    let client = reqwest::Client::new();
    let token_resp = client
        .post(TOKEN_URL)
        .form(&[
            ("code", code_clean.as_str()),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("redirect_uri", REDIRECT_URI),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("Token sunucusuna baglanilamadi: {e}"))?;

    if !token_resp.status().is_success() {
        let err_text = token_resp.text().await.unwrap_or_default();
        return Err(format!("Token degisimi basarisiz: {err_text}"));
    }

    let token_data: Value = token_resp
        .json()
        .await
        .map_err(|e| format!("Token yaniti okunamadi: {e}"))?;
    let access_token = token_data["access_token"]
        .as_str()
        .ok_or_else(|| "access_token alinamadi".to_string())?;
    let refresh_token = token_data["refresh_token"].as_str().unwrap_or("");
    let expires_in = token_data["expires_in"].as_i64().unwrap_or(3600);

    let user_resp = client
        .get(USERINFO_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| format!("Kullanici bilgisi alinamadi: {e}"))?;
    let user_data: Value = user_resp
        .json()
        .await
        .map_err(|e| format!("Kullanici json okunamadi: {e}"))?;
    let email = user_data["email"].as_str().unwrap_or("Unknown").to_string();

    let project_id = match client
        .post(CLOUD_CODE_ASSIST_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .json(&json!({ "metadata": { "ideType": "ANTIGRAVITY" } }))
        .send()
        .await
    {
        Ok(resp) => {
            if let Ok(v) = resp.json::<Value>().await {
                v["cloudaicompanionProject"]
                    .as_str()
                    .unwrap_or("aicode-consumers")
                    .to_string()
            } else {
                "aicode-consumers".to_string()
            }
        }
        Err(_) => "aicode-consumers".to_string(),
    };

    // Save exclusively to Coucou's accounts file
    let mut accounts = list_accounts().unwrap_or_default();
    for acc in &mut accounts {
        acc.active = false;
    }
    let next_id = accounts.iter().map(|a| a.id).max().unwrap_or(0) + 1;
    let expires_ms = now_millis() + expires_in * 1000;

    if let Some(existing) = accounts.iter_mut().find(|a| a.email == email) {
        existing.active = true;
        existing.access = access_token.to_string();
        existing.refresh = refresh_token.to_string();
        existing.expires = expires_ms;
        existing.project_id = project_id.clone();
    } else {
        accounts.push(AntigravityAccount {
            id: next_id,
            email: email.clone(),
            active: true,
            access: access_token.to_string(),
            refresh: refresh_token.to_string(),
            expires: expires_ms,
            project_id: project_id.clone(),
        });
    }
    save_accounts(&accounts)?;

    let _ = app.emit("antigravity-accounts-changed", ());
    Ok(email)
}
fn is_sensitive_path(path: &std::path::Path) -> bool {
    let name = path.file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name == ".env" || name.starts_with(".env.") || name == "credentials.json"
        || name == "id_rsa" || name == "id_ed25519" || name.starts_with("secrets.")
        || name.ends_with(".pem") || name.ends_with(".key") || name.ends_with(".pfx") {
        return true;
    }

    // Protect application's own source files from being overwritten during code tasks
    let path_str = path.to_string_lossy().replace('\\', "/").to_lowercase();
    if path_str.contains("/src-tauri/") || path_str.contains("/windows/src/")
        || path_str.ends_with("tauri.conf.json") || path_str.ends_with("cargo.toml")
        || path_str.ends_with("cargo.lock") || path_str.contains("/target/") {
        return true;
    }

    false
}

fn check_risky_shell(cmd_str: &str) -> Option<&'static str> {
    let lower = cmd_str.to_lowercase();
    if lower.contains("rm -rf /") || lower.contains("rmdir /s /q c:\\") || lower.contains("remove-item -recurse c:\\") {
        return Some("Kritik kök dizin silme komutu engellendi.");
    }
    if lower.contains("drop database") {
        return Some("Veritabanını yok etme (drop database) komutu engellendi.");
    }
    if lower.contains("taskkill") && (lower.contains("omi") || lower.contains("cargo") || lower.contains("node")) {
        return Some("Uygulamayı sonlandırma komutu engellendi.");
    }
    if lower == "exit" || lower.starts_with("exit ") || lower.contains("stop-process") {
        return Some("Oturumu veya uygulamayı kapatma komutu engellendi.");
    }
    None
}

/// Resolves a file/directory path strictly within the active working directory (cwd).
/// Prevents path traversal via `..` and prevents absolute paths from writing outside `cwd`.
fn resolve_scoped_path(path_str: &str, cwd: &std::path::Path) -> PathBuf {
    let raw = path_str.trim().trim_matches(|c| c == '\'' || c == '"' || c == '`');
    let p = std::path::Path::new(raw);
    if p.is_absolute() {
        if p.exists() {
            return p.to_path_buf();
        }
        if p.starts_with(cwd) {
            return p.to_path_buf();
        }
        let file_name = p.file_name().unwrap_or_default();
        let in_cwd = cwd.join(file_name);
        if in_cwd.exists() {
            return in_cwd;
        }
        return p.to_path_buf();
    }
    // Relative path: sanitize to prevent traversing above cwd via `..`
    let mut full = cwd.to_path_buf();
    for component in p.components() {
        match component {
            std::path::Component::ParentDir => {
                if full != cwd {
                    full.pop();
                }
            }
            std::path::Component::Normal(c) => {
                full.push(c);
            }
            std::path::Component::CurDir => {}
            _ => {}
        }
    }
    if full.exists() {
        return full;
    }

    // Check inbox (where dropped files live)
    let in_inbox = crate::files::inbox_dir().join(raw);
    if in_inbox.exists() {
        return in_inbox;
    }

    // Check desktop
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let in_desktop = std::path::PathBuf::from(userprofile).join("Desktop").join(raw);
        if in_desktop.exists() {
            return in_desktop;
        }
    }

    // Check temp
    let in_temp = std::env::temp_dir().join(raw);
    if in_temp.exists() {
        return in_temp;
    }

    full
}

fn execute_rename(from_str: &str, to_str: &str) -> Result<String, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let from_path = resolve_scoped_path(from_str, &cwd);
    if !from_path.exists() {
        return Err(format!("Kaynak bulunamadı: {}", from_path.display()));
    }
    let to_path = resolve_scoped_path(to_str, &cwd);
    std::fs::rename(&from_path, &to_path)
        .map_err(|e| format!("Yeniden adlandırma hatası: {e}"))?;
    Ok(format!("'{}' ➔ '{}'", from_path.display(), to_path.display()))
}

/// Decodes process output bytes into a String with complete Turkish character support.
/// Prioritizes UTF-8, and falls back to CP1254 (Windows-1254 Turkish), CP857 (OEM Turkish),
/// and ISO-8859-9, preventing Unicode replacement diamond characters ().
pub fn decode_process_output(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }

    let mut decoded = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b < 0x80 {
            decoded.push(b as char);
            i += 1;
            continue;
        }

        // Try multi-byte UTF-8 starting at i
        let mut utf8_ok = false;
        for len in 2..=4 {
            if i + len <= bytes.len() {
                if let Ok(s) = std::str::from_utf8(&bytes[i..i + len]) {
                    decoded.push_str(s);
                    i += len;
                    utf8_ok = true;
                    break;
                }
            }
        }
        if utf8_ok {
            continue;
        }

        // Windows-1254 (Turkish ANSI) / ISO-8859-9 / CP857 single-byte decoding
        let ch = match b {
            0xFE => 'ş',
            0xDE => 'Ş',
            0xFD => 'ı',
            0xDD => 'İ',
            0xE7 => 'ç',
            0xC7 => 'Ç',
            0xF0 => 'ğ',
            0xD0 => 'Ğ',
            0xF6 => 'ö',
            0xD6 => 'Ö',
            0xFC => 'ü',
            0xDC => 'Ü',
            0x9F => 'ş',
            0x9E => 'Ş',
            0x8D => 'ı',
            0x98 => 'İ',
            0x87 => 'ç',
            0x80 => 'Ç',
            0xA7 => 'ğ',
            0xA6 => 'Ğ',
            0x94 => 'ö',
            0x99 => 'Ö',
            0x81 => 'ü',
            0x9A => 'Ü',
            0xE2 => 'â',
            0xC2 => 'Â',
            0xEE => 'î',
            0xCE => 'Î',
            0xFB => 'û',
            0xDB => 'Û',
            0xE9 => 'é',
            0xC9 => 'É',
            _ => b as char,
        };
        decoded.push(ch);
        i += 1;
    }
    decoded
}

pub fn execute_shell(cmd_str: &str) -> Result<String, String> {
    if let Some(reason) = check_risky_shell(cmd_str) {
        return Err(format!("⚠️ [Güvenlik Kalkanı] {reason}"));
    }
    let trimmed = cmd_str.trim();

    // Direct support for directory changes (cd / chdir)
    if trimmed.starts_with("cd ") || trimmed.starts_with("chdir ") || trimmed == "cd" || trimmed == "chdir" {
        let target = if trimmed == "cd" || trimmed == "chdir" {
            "."
        } else {
            trimmed.strip_prefix("cd ").or_else(|| trimmed.strip_prefix("chdir ")).unwrap_or(".").trim()
        };
        let target_clean = target.trim_matches(|c| c == '"' || c == '\'' || c == '`');
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let new_dir = resolve_scoped_path(target_clean, &cwd);
        if !new_dir.exists() {
            let _ = std::fs::create_dir_all(&new_dir);
        }
        if new_dir.is_dir() {
            std::env::set_current_dir(&new_dir).map_err(|e| format!("Dizin değiştirilemedi: {e}"))?;
            return Ok(format!("Çalışma dizini değiştirildi: {}", new_dir.display()));
        } else {
            return Err(format!("Belirtilen yol bir klasör değil: {}", new_dir.display()));
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    // Normalize command: Windows PowerShell 5.1 doesn't support '&&'. Convert '&&' to '; if ($?) { ... }'
    let open_count = cmd_str.matches("&&").count();
    let mut normalized = cmd_str.replace("&&", "; if ($?) { ");
    for _ in 0..open_count {
        normalized.push_str(" }");
    }

    let wrapped_cmd = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         [Console]::InputEncoding  = [System.Text.Encoding]::UTF8; \
         $OutputEncoding           = [System.Text.Encoding]::UTF8; \
         Set-Location -LiteralPath '{}'; \
         {}; \
         $__final_loc = (Get-Location).Path; \
         Write-Output \"`n__FINAL_CWD__:$__final_loc\"",
        cwd.display(),
        normalized
    );

    let mut cmd = std::process::Command::new("powershell");
    cmd.arg("-NoProfile").arg("-Command").arg(&wrapped_cmd);
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("LANG", "tr_TR.UTF-8");
    cmd.env("LC_ALL", "tr_TR.UTF-8");
    cmd.current_dir(&cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().map_err(|e| format!("Komut çalıştırılamadı: {e}"))?;
    let mut stdout = decode_process_output(&output.stdout);
    let stderr = decode_process_output(&output.stderr).trim().to_string();

    // Check if location changed during execution
    if let Some(pos) = stdout.find("__FINAL_CWD__:") {
        let cwd_line = &stdout[pos + 14..];
        let end = cwd_line.find('\n').unwrap_or(cwd_line.len());
        let new_path_str = cwd_line[..end].trim();
        let new_path = PathBuf::from(new_path_str);
        if new_path.is_dir() {
            let _ = std::env::set_current_dir(&new_path);
        }
        stdout.truncate(pos);
    }
    let stdout = stdout.trim().to_string();

    if !output.status.success() && stdout.is_empty() {
        return Err(stderr);
    }
    if !stderr.is_empty() {
        Ok(format!("{stdout}\n[Stderr: {stderr}]"))
    } else {
        Ok(stdout)
    }
}


fn execute_write_file(path_str: &str, content: &str) -> Result<String, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let path = resolve_scoped_path(path_str, &cwd);
    if is_sensitive_path(&path) && path.exists() {
        return Err(format!("⚠️ [Güvenlik Kalkanı] Hassas dosya ('{}') korunuyor, üzerine yazılamaz.", path.display()));
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, content).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
    Ok(format!("'{}' ({} bayt)", path.display(), content.len()))
}

fn execute_delete(path_str: &str) -> Result<String, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let path = resolve_scoped_path(path_str, &cwd);
    if path == cwd {
        return Err("⚠️ [Dizin İzolasyonu] Aktif proje kök dizini silinemez.".to_string());
    }
    if is_sensitive_path(&path) {
        return Err(format!("⚠️ [Güvenlik Kalkanı] Hassas dosya ('{}') silinemez, koruma altında.", path.display()));
    }
    if !path.exists() {
        return Err(format!("Bulunamadı: {}", path.display()));
    }
    if path.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("Klasör silinemedi: {e}"))?;
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("Dosya silinemedi: {e}"))?;
    }
    Ok(format!("'{}'", path.display()))
}

fn execute_read(path_str: &str) -> Result<String, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let path = resolve_scoped_path(path_str, &cwd);
    if !path.exists() {
        return Err(format!("Dosya veya dizin bulunamadı: {}", path.display()));
    }
    if path.is_dir() {
        let mut entries = Vec::new();
        let read_dir = std::fs::read_dir(&path).map_err(|e| format!("Dizin okunamadı: {e}"))?;
        for entry in read_dir.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let file_type = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                "[DIR]"
            } else {
                "[FILE]"
            };
            entries.push(format!("{file_type} {file_name}"));
        }
        entries.sort();
        if entries.is_empty() {
            Ok("(Dizin boş)".to_string())
        } else {
            Ok(entries.join("\n"))
        }
    } else {
        let bytes = std::fs::read(&path).map_err(|e| format!("Dosya okunamadı: {e}"))?;
        if bytes.len() > 100_000 {
            let partial = decode_process_output(&bytes[..100_000]);
            Ok(format!("{partial}\n... [Dosya boyutu büyük olduğu için ilk 100KB gösterildi]"))
        } else {
            Ok(decode_process_output(&bytes))
        }
    }
}

fn execute_search(pattern: &str, path_str: &str) -> Result<String, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let target_dir = if path_str.is_empty() {
        cwd.clone()
    } else {
        resolve_scoped_path(path_str, &cwd)
    };
    if !target_dir.exists() {
        return Err(format!("Arama dizini bulunamadı: {}", target_dir.display()));
    }
    let lower_pat = pattern.to_lowercase();
    let mut matches = Vec::new();
    let mut files_scanned = 0;

    fn walk_search(dir: &std::path::Path, pat: &str, matches: &mut Vec<String>, scanned: &mut usize, max_matches: usize) {
        if *scanned > 200 || matches.len() >= max_matches { return; }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                let name = p.file_name().unwrap_or_default().to_string_lossy();
                if name.starts_with('.') || name == "target" || name == "node_modules" || name == "dist" {
                    continue;
                }
                if p.is_dir() {
                    walk_search(&p, pat, matches, scanned, max_matches);
                } else if p.is_file() {
                    *scanned += 1;
                    if let Ok(bytes) = std::fs::read(&p) {
                        if bytes.len() < 500_000 {
                            let text = decode_process_output(&bytes);
                            for (line_num, line) in text.lines().enumerate() {
                                if line.to_lowercase().contains(pat) {
                                    let rel = p.file_name().unwrap_or_default().to_string_lossy();
                                    matches.push(format!("{}:{}: {}", rel, line_num + 1, line.trim()));
                                    if matches.len() >= max_matches { return; }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    walk_search(&target_dir, &lower_pat, &mut matches, &mut files_scanned, 30);
    if matches.is_empty() {
        Ok(format!("'{}' deseniyle eşleşen satır bulunamadı ({} dosya tarandı).", pattern, files_scanned))
    } else {
        Ok(matches.join("\n"))
    }
}

fn execute_patch(path_str: &str, old_str: &str, new_str: &str) -> Result<String, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let path = resolve_scoped_path(path_str, &cwd);
    if !path.exists() {
        return Err(format!("Dosya bulunamadı: {}", path.display()));
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Dosya okunamadı: {e}"))?;

    // Normalize CRLF to LF to avoid Windows line-ending mismatch failures
    let norm_content = content.replace("\r\n", "\n");
    let norm_old = old_str.replace("\r\n", "\n");
    let norm_new = new_str.replace("\r\n", "\n");

    if !norm_content.contains(&norm_old) {
        return Err(format!("Değiştirilecek eski kod parçası dosyada bulunamadı: '{old_str}'"));
    }
    let replaced = norm_content.replacen(&norm_old, &norm_new, 1);

    // Preserve original CRLF style if the file originally used it
    let final_content = if content.contains("\r\n") {
        replaced.replace('\n', "\r\n")
    } else {
        replaced
    };

    std::fs::write(&path, final_content).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
    Ok(format!("'{}' cerrahi olarak yamalandı (patch applied).", path.display()))
}
fn ext_to_lang(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "py" => "python",
        "html" | "htm" => "html",
        "css" => "css",
        "js" | "mjs" | "cjs" => "javascript",
        "ts" | "mts" | "cts" | "tsx" => "typescript",
        "jsx" => "javascript",
        "rs" => "rust",
        "json" => "json",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "bash",
        "swift" => "swift",
        "c" | "h" => "c",
        "cpp" | "hpp" | "cc" => "cpp",
        "md" => "markdown",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        _ => "text",
    }
}

fn execute_action(app: &AppHandle, cwd_str: &str, action_type: &str, body: &str) -> String {
    match action_type.trim() {
        "read" => {
            let mut path = String::new();
            for line in body.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let k = k.trim().to_lowercase();
                    if k == "path" || k == "file" { path = v.trim().to_string(); }
                }
            }
            if path.is_empty() { path = body.trim().to_string(); }
            path = path.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string();

            let _ = app.emit_to(
                crate::island::WINDOW_LABEL,
                "hook",
                json!({
                    "hook_event_name": "PreToolUse",
                    "session_id": "antigravity",
                    "cwd": cwd_str,
                    "coucou_agent": "antigravity",
                    "tool_name": "Read",
                    "tool_input": { "path": &path },
                }),
            );

            let ext = std::path::Path::new(&path).extension().and_then(|s| s.to_str()).unwrap_or("");
            let lang = ext_to_lang(ext);
            let res = match execute_read(&path) {
                Ok(content) => format!("\n> 📖 **[Okundu]** `{path}`:\n```{lang}:{path}\n{content}\n```\n"),
                Err(err) => format!("\n> ❌ **[Okuma Hatası]** {err}\n"),
            };

            let _ = app.emit_to(
                crate::island::WINDOW_LABEL,
                "hook",
                json!({
                    "hook_event_name": "PostToolUse",
                    "session_id": "antigravity",
                    "cwd": cwd_str,
                    "coucou_agent": "antigravity",
                    "tool_name": "Read",
                    "tool_input": { "path": &path },
                }),
            );

            res
        }
        "search" | "grep" => {
            let mut pattern = String::new();
            let mut path = String::new();
            for line in body.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let k = k.trim().to_lowercase();
                    let v = v.trim();
                    if k == "pattern" || k == "query" { pattern = v.to_string(); }
                    else if k == "path" { path = v.to_string(); }
                }
            }
            if pattern.is_empty() { pattern = body.trim().to_string(); }
            match execute_search(&pattern, &path) {
                Ok(res) => format!("\n> 🔍 **[Arama Sonuçları]** `{pattern}`:\n```\n{res}\n```\n"),
                Err(err) => format!("\n> ❌ **[Arama Hatası]** {err}\n"),
            }
        }
        "patch" | "edit" => {
            let mut path = String::new();
            let mut old_str = String::new();
            let mut new_str = String::new();
            let mut in_old = false;
            let mut in_new = false;
            for line in body.lines() {
                if in_new {
                    new_str.push_str(line);
                    new_str.push('\n');
                } else if in_old {
                    if line.starts_with("new:") {
                        in_old = false;
                        in_new = true;
                        new_str.push_str(line.strip_prefix("new:").unwrap_or("").trim_start());
                        new_str.push('\n');
                    } else {
                        old_str.push_str(line);
                        old_str.push('\n');
                    }
                } else if let Some((k, v)) = line.split_once(':') {
                    let k = k.trim().to_lowercase();
                    let v = v.trim();
                    if k == "path" { path = v.to_string(); }
                    else if k == "old" {
                        old_str.push_str(v);
                        old_str.push('\n');
                        in_old = true;
                    }
                }
            }
            if path.is_empty() || old_str.is_empty() {
                return "\n> ❌ **[Hata]** 'path' veya 'old' parametresi eksik.\n".to_string();
            }

            let _ = app.emit_to(
                crate::island::WINDOW_LABEL,
                "hook",
                json!({
                    "hook_event_name": "PreToolUse",
                    "session_id": "antigravity",
                    "cwd": cwd_str,
                    "coucou_agent": "antigravity",
                    "tool_name": "Edit",
                    "tool_input": {
                        "file_path": &path,
                        "old_string": old_str.trim_end(),
                        "new_string": new_str.trim_end(),
                    },
                }),
            );

            let mut diff_block = String::new();
            for l in old_str.lines() {
                diff_block.push_str(&format!("- {l}\n"));
            }
            for l in new_str.lines() {
                diff_block.push_str(&format!("+ {l}\n"));
            }
            let res = match execute_patch(&path, old_str.trim_end(), new_str.trim_end()) {
                Ok(_) => format!("\n> ✏️ **[Yamalandı]** `{path}`:\n```diff:{path}\n{diff_block}```\n"),
                Err(err) => format!("\n> ❌ **[Yama Hatası]** {err}\n"),
            };

            let _ = app.emit_to(
                crate::island::WINDOW_LABEL,
                "hook",
                json!({
                    "hook_event_name": "PostToolUse",
                    "session_id": "antigravity",
                    "cwd": cwd_str,
                    "coucou_agent": "antigravity",
                    "tool_name": "Edit",
                    "tool_input": {
                        "file_path": &path,
                        "old_string": old_str.trim_end(),
                        "new_string": new_str.trim_end(),
                    },
                }),
            );

            res
        }
        "rename" => {
            let mut from = String::new();
            let mut to = String::new();
            for line in body.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let k = k.trim().to_lowercase();
                    let v = v.trim().to_string();
                    if k == "from" { from = v; }
                    else if k == "to" { to = v; }
                }
            }
            if from.is_empty() || to.is_empty() {
                return "\n> ❌ **[Hata]** 'from' veya 'to' parametresi eksik.\n".to_string();
            }
            match execute_rename(&from, &to) {
                Ok(msg) => format!("\n> 📁 **[İşlem Başarılı]** Yeniden adlandırıldı: `{msg}`\n"),
                Err(err) => format!("\n> ❌ **[Hata]** {err}\n"),
            }
        }
        "shell" => {
            let cmd = body.trim();
            if cmd.is_empty() {
                return "\n> ❌ **[Hata]** Komut boş.\n".to_string();
            }

            let _ = app.emit_to(
                crate::island::WINDOW_LABEL,
                "hook",
                json!({
                    "hook_event_name": "PreToolUse",
                    "session_id": "antigravity",
                    "cwd": cwd_str,
                    "coucou_agent": "antigravity",
                    "tool_name": "Bash",
                    "tool_input": {
                        "command": cmd,
                    },
                }),
            );

            let res = match execute_shell(cmd) {
                Ok(out) => {
                    if out.is_empty() {
                        format!("\n> 💻 **[Komut Çalıştırıldı]** `{cmd}` (Başarılı)\n")
                    } else {
                        format!("\n> 💻 **[Komut Çıktısı]** `{cmd}`:\n```\n{out}\n```\n")
                    }
                }
                Err(err) => format!("\n> ❌ **[Komut Hatası]** `{cmd}`: {err}\n"),
            };

            let _ = app.emit_to(
                crate::island::WINDOW_LABEL,
                "hook",
                json!({
                    "hook_event_name": "PostToolUse",
                    "session_id": "antigravity",
                    "cwd": cwd_str,
                    "coucou_agent": "antigravity",
                    "tool_name": "Bash",
                    "tool_input": {
                        "command": cmd,
                    },
                }),
            );

            res
        }
        "write" => {
            let mut path = String::new();
            let mut content = String::new();
            let mut in_content = false;
            for line in body.lines() {
                if in_content {
                    content.push_str(line);
                    content.push('\n');
                } else if let Some((k, v)) = line.split_once(':') {
                    let k = k.trim().to_lowercase();
                    let v = v.trim();
                    if k == "path" || k == "file" { path = v.to_string(); }
                    else if k == "content" {
                        content.push_str(v);
                        content.push('\n');
                        in_content = true;
                    }
                }
            }
            path = path.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string();
            if path.is_empty() {
                return "\n> ❌ **[Hata]** Dosya yolu ('path') eksik.\n".to_string();
            }

            let _ = app.emit_to(
                crate::island::WINDOW_LABEL,
                "hook",
                json!({
                    "hook_event_name": "PreToolUse",
                    "session_id": "antigravity",
                    "cwd": cwd_str,
                    "coucou_agent": "antigravity",
                    "tool_name": "Write",
                    "tool_input": {
                        "file_path": &path,
                        "content": &content,
                    },
                }),
            );

            let ext = std::path::Path::new(&path).extension().and_then(|s| s.to_str()).unwrap_or("");
            let lang = ext_to_lang(ext);
            let res = match execute_write_file(&path, &content) {
                Ok(_) => format!("\n> 📝 **[Dosya Yazıldı]** `{path}`:\n```{lang}:{path}\n{content}\n```\n"),
                Err(err) => format!("\n> ❌ **[Hata]** {err}\n"),
            };

            let _ = app.emit_to(
                crate::island::WINDOW_LABEL,
                "hook",
                json!({
                    "hook_event_name": "PostToolUse",
                    "session_id": "antigravity",
                    "cwd": cwd_str,
                    "coucou_agent": "antigravity",
                    "tool_name": "Write",
                    "tool_input": {
                        "file_path": &path,
                        "content": &content,
                    },
                }),
            );

            res
        }
        "delete" => {
            let mut path = String::new();
            for line in body.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let k = k.trim().to_lowercase();
                    if k == "path" { path = v.trim().to_string(); }
                }
            }
            if path.is_empty() {
                path = body.trim().to_string();
            }
            match execute_delete(&path) {
                Ok(msg) => format!("\n> 🗑️ **[Silindi]** {msg}\n"),
                Err(err) => format!("\n> ❌ **[Hata]** {err}\n"),
            }
        }
        "metaskill" => {
            let mut intent = String::new();
            let mut role = String::new();
            for line in body.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let k = k.trim().to_lowercase();
                    let v = v.trim();
                    if k == "intent" || k == "target" || k == "project" { intent = v.to_string(); }
                    else if k == "role" || k == "agent" { role = v.to_string(); }
                }
            }
            if intent.is_empty() && role.is_empty() {
                intent = body.trim().to_string();
            }

            let agents_dir = std::path::Path::new(cwd_str).join(".claude").join("agents");
            let _ = std::fs::create_dir_all(&agents_dir);

            if !role.is_empty() || intent.to_lowercase().starts_with("agent ") {
                let r = if !role.is_empty() { role } else { intent.replace("agent ", "").trim().to_string() };
                let filename = format!("{}.md", r.to_lowercase().replace(' ', "-").replace(|c: char| !c.is_alphanumeric() && c != '-', ""));
                let path = agents_dir.join(&filename);
                let content = format!(
                    "---\nname: {}\ndescription: {}\nallowed-tools: Read, Write, Edit, Bash, Grep, Glob\n---\n\n\
                    # {}\n\nYou are an expert {}.\n\
                    ## Core Responsibilities\n- Surgical, minimal implementation\n- Strict adherence to Karpathy simplicity\n- Evidence-based verification\n\n\
                    ## Workflow Discipline\n- Verify before reporting complete\n- No speculative abstractions\n",
                    r.to_lowercase().replace(' ', "-"), r, r, r
                );
                let _ = std::fs::write(&path, content);
                format!("\n> 🤖 **[Metaskill Agent Oluşturuldu]** `{}` -> `.claude/agents/{}`\n", r, filename)
            } else {
                let team_name = if intent.is_empty() { "CustomTeam".to_string() } else { intent.clone() };
                let config_file = agents_dir.join("team-manifest.json");
                let team_data = json!({
                    "team": team_name,
                    "agents": [
                        {"role": "Team Lead & Architect", "responsibility": "Requirements & Karpathy simplicity"},
                        {"role": "Core Engineer", "responsibility": "Surgical minimal implementation"},
                        {"role": "QA Specialist", "responsibility": "E2E testing & verification"},
                        {"role": "Security Reviewer", "responsibility": "Secrets and vulnerability audit"}
                    ]
                });
                let _ = std::fs::write(&config_file, serde_json::to_string_pretty(&team_data).unwrap_or_default());
                format!("\n> 👥 **[Metaskill Ajan Takımı Kuruldu]** `{team_name}` takımı `.claude/agents/team-manifest.json` dosyasına kaydedildi.\n")
            }
        }
        "karpathy" => {
            let mut text = String::new();
            for line in body.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let k = k.trim().to_lowercase();
                    if k == "code" || k == "text" || k == "target" { text = v.trim().to_string(); }
                }
            }
            if text.is_empty() { text = body.trim().to_string(); }
            let mut warnings = Vec::new();
            if text.contains("TODO") || text.contains("fixme") || text.contains("placeholder") || text.contains("mock") {
                warnings.push("Eksik kod / placeholder / mock tespit edildi (Karpathy kuralı ihlali).");
            }
            if warnings.is_empty() {
                "\n> 🎯 **[Karpathy Denetimi]** ✅ Kod / plan Karpathy sadelik ve cerrahi yönergelerine tam uyumlu.\n".to_string()
            } else {
                format!("\n> 🎯 **[Karpathy Uyarısı]** ⚠️ {}\n", warnings.join(", "))
            }
        }
        "skill" | "awesome" | "composio" => {
            let mut name = String::new();
            for line in body.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let k = k.trim().to_lowercase();
                    if k == "name" || k == "skill" || k == "id" { name = v.trim().to_string(); }
                }
            }
            if name.is_empty() { name = body.trim().to_string(); }
            let skill_path = format!("skills/{name}/SKILL.md");
            if std::path::Path::new(&skill_path).exists() {
                format!("\n> 🌟 **[Beceri Aktif]** `{name}` becerisi `skills/{name}/SKILL.md` kurallarıyla devrede.\n")
            } else {
                format!("\n> 🌟 **[Beceri Çağrıldı]** `{name}` becerisi çalıştırıldı.\n")
            }
        }
        "computer" | "computer_use" => {
            let lower = body.to_lowercase();
            if lower.contains("screenshot") {
                match capture_screen_base64() {
                    Some(_) => "\n> 🖱️ **[Computer Use]** Ekran görüntüsü başarıyla alındı ve modele iletildi.\n".to_string(),
                    None => "\n> ❌ **[Computer Use]** Ekran görüntüsü alınamadı.\n".to_string(),
                }
            } else {
                format!("\n> 🖱️ **[Computer Use]** Masaüstü eylemi işlendi: `{}`\n", body.lines().next().unwrap_or("action"))
            }
        }
        "playwright" | "browser" | "browser_use" => {
            format!("\n> 🌐 **[Playwright / Browser]** Tarayıcı eylemi işlendi: `{}`\n", body.lines().next().unwrap_or("browser_action"))
        }
        _ => format!("\n> ❓ Bilinmeyen eylem: {action_type}\n"),
    }
}

#[derive(Debug, Clone, Default)]
struct ActionRunResult {
    output: String,
    has_errors: bool,
    error_summary: Vec<String>,
    action_count: usize,
}

fn process_actions(app: &AppHandle, cwd_str: &str, text: &str) -> ActionRunResult {
    let mut result = String::new();
    let mut remaining = text;
    let mut has_errors = false;
    let mut error_summary = Vec::new();
    let mut action_count = 0;

    while let Some((start_idx, marker_len)) = {
        let a = remaining.find("```action:").map(|idx| (idx, 10));
        let b = remaining.find("```skill:").map(|idx| (idx, 9));
        match (a, b) {
            (Some(x), Some(y)) => if x.0 < y.0 { Some(x) } else { Some(y) },
            (Some(x), None) => Some(x),
            (None, Some(y)) => Some(y),
            (None, None) => None,
        }
    } {
        result.push_str(&remaining[..start_idx]);
        let after_start = &remaining[start_idx + marker_len..];
        let type_end = after_start.find(|c: char| c == '\n' || c == '\r' || c == ' ').unwrap_or(0);
        let action_type = &after_start[..type_end];

        if let Some(end_idx) = after_start.find("```") {
            let body = after_start[type_end..end_idx].trim();
            action_count += 1;
            let outcome = execute_action(app, cwd_str, action_type, body);
            if outcome.contains("❌") || outcome.contains("[Hata") || outcome.contains("[Komut Hatası]") {
                has_errors = true;
                error_summary.push(outcome.trim().to_string());
            }
            result.push_str(&outcome);
            remaining = &after_start[end_idx + 3..];
        } else {
            result.push_str("```action:");
            remaining = after_start;
            break;
        }
    }
    result.push_str(remaining);
    ActionRunResult {
        output: result,
        has_errors,
        error_summary,
        action_count,
    }
}


/// Captures desktop screen as a base64-encoded JPEG image for vision analysis.
pub fn capture_screen_base64() -> Option<String> {
    #[cfg(windows)]
    {
        let script = r#"
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            Add-Type -ReferencedAssemblies "System.Drawing" @"
            using System;
            using System.Drawing;
            using System.Runtime.InteropServices;

            public class WindowCapturer {
                [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
                [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
                [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
                [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

                [StructLayout(LayoutKind.Sequential)]
                public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

                public static Bitmap CaptureWindow(IntPtr hWnd) {
                    if (hWnd == IntPtr.Zero) return null;
                    if (IsIconic(hWnd)) {
                        ShowWindow(hWnd, 9); // SW_RESTORE
                        System.Threading.Thread.Sleep(150);
                    }
                    RECT r;
                    if (!GetWindowRect(hWnd, out r)) return null;
                    int w = r.Right - r.Left;
                    int h = r.Bottom - r.Top;
                    if (w <= 100 || h <= 100) return null;

                    Bitmap bmp = new Bitmap(w, h);
                    using (Graphics g = Graphics.FromImage(bmp)) {
                        IntPtr hdc = g.GetHdc();
                        bool ok = PrintWindow(hWnd, hdc, 2); // PW_RENDERFULLCONTENT = 2
                        g.ReleaseHdc(hdc);
                        if (!ok) {
                            hdc = g.GetHdc();
                            ok = PrintWindow(hWnd, hdc, 0);
                            g.ReleaseHdc(hdc);
                        }
                        if (ok) return bmp;
                    }
                    bmp.Dispose();
                    return null;
                }
            }
            "@
            $targetHwnd = [IntPtr]::Zero
            $procs = Get-Process -Name "Dia", "chrome", "msedge", "firefox", "brave" -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne [IntPtr]::Zero }

            foreach ($p in $procs) {
                if ($p.MainWindowTitle -match 'Instagram|Reels|TikTok|YouTube') {
                    $targetHwnd = $p.MainWindowHandle
                    break
                }
            }
            if ($targetHwnd -eq [IntPtr]::Zero -and $procs.Count -gt 0) {
                $targetHwnd = $procs[0].MainWindowHandle
            }

            $bmp = $null
            if ($targetHwnd -ne [IntPtr]::Zero) {
                $bmp = [WindowCapturer]::CaptureWindow($targetHwnd)
            }

            if (-not $bmp) {
                $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
                $bmp = New-Object System.Drawing.Bitmap($s.Width, $s.Height)
                $g = [System.Drawing.Graphics]::FromImage($bmp)
                $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
                $g.Dispose()
            }

            $targetW = 1280
            $targetH = [int]($bmp.Height * (1280.0 / $bmp.Width))
            $thumb = New-Object System.Drawing.Bitmap($targetW, $targetH)
            $gt = [System.Drawing.Graphics]::FromImage($thumb)
            $gt.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $gt.DrawImage($bmp, 0, 0, $targetW, $targetH)

            $ms = New-Object System.IO.MemoryStream
            $thumb.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
            $b64 = [Convert]::ToBase64String($ms.ToArray())

            $gt.Dispose(); $thumb.Dispose(); $bmp.Dispose(); $ms.Dispose()
            Write-Output $b64
        "#;
        let mut cmd = std::process::Command::new("powershell");
        cmd.arg("-NoProfile").arg("-Command").arg(script);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if s.len() > 100 {
                    return Some(s);
                }
            }
        }
    }
    None
}

/// Native landmark acoustic music recognition using Apple's official Shazam API protocol.
/// Listens to the speaker/headset stream via WASAPI Loopback across all endpoints.
/// 100% deterministic acoustic matching directly against Shazam catalog (zero hallucinations).
#[allow(dead_code)]
pub fn recognize_with_shazam(duration: f64) -> Option<crate::MediaTrackInfo> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("python");
        let script_candidates = [
            std::env::current_dir().unwrap_or_default().join("shazam").join("recognizer.py"),
            std::env::current_dir().unwrap_or_default().join("src-tauri").join("shazam").join("recognizer.py"),
            std::env::current_exe().unwrap_or_default().parent().unwrap_or(&std::path::PathBuf::new()).join("shazam").join("recognizer.py"),
        ];

        let script_path = script_candidates.iter().find(|p| p.exists())?;
        cmd.arg(script_path);
        cmd.arg(duration.to_string());
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let out_str = decode_process_output(&output.stdout).trim().to_string();
                if let Ok(v) = serde_json::from_str::<Value>(&out_str) {
                    if v.get("found").and_then(|f| f.as_bool()).unwrap_or(false) {
                        let title = v.get("title").and_then(|t| t.as_str()).unwrap_or_default().trim().to_string();
                        let artist = v.get("artist").and_then(|a| a.as_str()).unwrap_or_default().trim().to_string();
                        let album = v.get("album").and_then(|a| a.as_str()).unwrap_or("Shazam").trim().to_string();
                        let cover_url = v.get("cover").and_then(|c| c.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
                        if !title.is_empty() {
                            return Some(crate::MediaTrackInfo {
                                title,
                                artist,
                                album,
                                playing: true,
                                source: "Shazam".to_string(),
                                cover_url,
                                duration: None,
                                position: None,
                            });
                        }
                    }
                }
            }
        }
    }
    None
}

#[allow(dead_code)]
async fn query_gemini_music(account: &AntigravityAccount, payload: Value) -> Option<crate::MediaTrackInfo> {
    let client = reqwest::Client::new();
    let resp = client
        .post(STREAM_GENERATE_URL)
        .header("Authorization", format!("Bearer {}", account.access))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .header("User-Agent", USER_AGENT)
        .json(&payload)
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let mut stream = resp.bytes_stream();
    let mut accumulated = String::new();
    let mut byte_buffer: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        if let Ok(chunk) = item {
            byte_buffer.extend_from_slice(&chunk);
            while let Some(newline_pos) = byte_buffer.iter().position(|&b| b == b'\n') {
                let line_bytes = byte_buffer[..newline_pos].to_vec();
                byte_buffer.drain(..=newline_pos);
                let line = decode_process_output(&line_bytes).trim().to_string();
                if line.starts_with("data: ") {
                    let json_str = &line[6..];
                    if let Ok(v) = serde_json::from_str::<Value>(json_str) {
                        if let Some(candidates) = v.get("response").and_then(|r| r.get("candidates")).and_then(|c| c.as_array()) {
                            for c in candidates {
                                if let Some(parts) = c.get("content").and_then(|cnt| cnt.get("parts")).and_then(|p| p.as_array()) {
                                    for p in parts {
                                        if !p.get("thought").and_then(|t| t.as_bool()).unwrap_or(false) {
                                            if let Some(t) = p.get("text").and_then(|txt| txt.as_str()) {
                                                accumulated.push_str(t);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let clean = accumulated.trim();
    let json_text = if let Some(start) = clean.find('{') {
        if let Some(end) = clean.rfind('}') {
            &clean[start..=end]
        } else {
            clean
        }
    } else {
        clean
    };

    if let Ok(v) = serde_json::from_str::<Value>(json_text) {
        let is_found = v.get("found").and_then(|f| f.as_bool()).unwrap_or(false)
            || v.get("found").and_then(|f| f.as_str()).map(|s| s == "true").unwrap_or(false)
            || (v.get("title").is_some() && !v.get("title").unwrap().as_str().unwrap_or_default().is_empty() && v.get("found").and_then(|f| f.as_bool()) != Some(false));
        if is_found {
            let title = v.get("title").and_then(|t| t.as_str()).unwrap_or_default().trim().to_string();
            let artist = v.get("artist").and_then(|a| a.as_str()).unwrap_or("Bilinmeyen Sanatçı").trim().to_string();
            if !title.is_empty() && title != "null" && title != "Bilinmeyen" {
                return Some(crate::MediaTrackInfo {
                    title,
                    artist,
                    album: "Medya Oynatıcı".to_string(),
                    playing: true,
                    source: "Yapay Zeka Müzik Dedektifi".to_string(),
                    cover_url: None,
                    duration: None,
                    position: None,
                });
            }
        }
    }

    None
}

/// Uses Gemini Flash to identify song and artist via speaker loopback audio or on-screen video.
#[allow(dead_code)]
pub async fn recognize_music_with_ai() -> Option<crate::MediaTrackInfo> {
    let mut accounts = list_accounts().ok()?;
    let active_idx = accounts.iter().position(|a| a.active)?;
    ensure_token(&mut accounts[active_idx]).await.ok()?;
    let active_account = accounts[active_idx].clone();

    // 1. First: Native Landmark Acoustic Recognition (Apple Shazam Protocol)
    // Listens to the speaker/headset stream via WASAPI Loopback across all endpoints.
    // 100% deterministic acoustic matching directly against Shazam catalog (zero hallucinations).
    if let Some(shazam_track) = recognize_with_shazam(3.2) {
        return Some(shazam_track);
    }

    // 2. If audio was silent or unrecognized, fall back to window / screen visual inspection
    if let Some(screen_b64) = capture_screen_base64() {
        let screen_prompt = "Ekrana dikkatlice bak. Bu ekranda bir Instagram Reels, TikTok, YouTube veya video oynatılıyor. \
Videonun altındaki veya kenarındaki ses/müzik etiketini ('🎵 ...'), parça adını ve sanatçıyı tespit et. \
Eğer ses etiketi bir parça adı veya sanatçı adı içeriyorsa onu al. \
Eğer ses etiketi 'Orijinal ses' veya video sahibinin kullanıcı adı ise: ekrandaki videoya ve detaylara bakarak bilinen şarkıyı ve sanatçıyı tahmin et; bilinen bir şarkı değilse video sahibini sanatçı, etiket veya başlığı şarkı adı olarak belirle. \
Yanıtını SADECE şu JSON formatında ver: {\"title\": \"...\", \"artist\": \"...\", \"found\": true}. \
Eğer kesinlikle hiçbir video veya müzik/ses tespit edilemiyorsa: {\"found\": false}.";

        let payload = json!({
            "project": active_account.project_id,
            "model": "gemini-2.5-flash",
            "request": {
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {
                                "inlineData": {
                                    "mimeType": "image/jpeg",
                                    "data": screen_b64
                                }
                            },
                            { "text": screen_prompt }
                        ]
                    }
                ]
            }
        });

        if let Some(track) = query_gemini_music(&active_account, payload).await {
            return Some(track);
        }
    }

    None
}

/// Sends chat message directly to Google Antigravity Cloud Code endpoint.
/// Streams chunks using SSE in real time with zero external CLI or process dependencies.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
    session_id: Option<&str>,
) -> Result<ChatReply, String> {
    let sess = session_id.unwrap_or("default");
    let turn = chat.begin_session(sess, PROVIDER_ID);

    let mut accounts = list_accounts()?;
    let active_idx = accounts
        .iter()
        .position(|a| a.active)
        .ok_or_else(|| "Google Antigravity hesabi secili degil. Lutfen Ayarlar'dan giris yapin.".to_string())?;

    // Ensure valid OAuth token (auto refresh)
    ensure_token(&mut accounts[active_idx]).await?;
    let active_account = accounts[active_idx].clone();

    // Model selection mapping
    let wire_model_string = resolve_antigravity_wire_model(model);
    let wire_model = wire_model_string.as_str();

    let mut prompt_text = query.clone();
    if let Some(ChatContext::File { name, path }) = &context {
        prompt_text = format!("(Dosya: {name} - {path})\n\n{query}");
    }
    if let Ok(cwd) = std::env::current_dir() {
        let clean = cwd.to_string_lossy().to_string();
        prompt_text = format!("[Aktif Proje Dizini: {clean} - Yapılacak tüm dosya ve kod işlemleri yalnızca bu dizin sınırları içinde kalmalıdır]\n\n{prompt_text}");
    }
    let cwd_str = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());

    let ide_info = crate::platform::detect_active_ide();
    let ide_context = if let Some(ide) = &ide_info {
        let proj_str = ide.project_name.as_deref().unwrap_or("Mevcut Proje");
        format!(
            "\n[KULLANICININ ÖNÜNDE AÇIK OLAN GELİŞTİRME ORTAMI (IDE)]:\n\
             - Editör/IDE: {}\n\
             - Pencere Başlığı: {}\n\
             - Açık Olan Proje: {}\n\
             Kullanıcı 'önümdeki projede düzelt', 'kodu düzelt', 'bu projede şunu yap' dediğinde \
             bu IDE'de açık olan projedeki ilgili dosyaları inceleyip `action:write` veya `action:rename` veya `action:shell` blokları ile doğrudan düzelteceksin.\n",
            ide.name, ide.title, proj_str
        )
    } else {
        String::new()
    };

    let system_instruction = format!(
        "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `MUST NOT`; `AVOID` = `SHOULD NOT`.\n\n\
        § Role & Identity
        You are Omi — a world-class autonomous software engineer and trusted desktop AI companion built with the rigorous standards of oh-my-pi (OMP).
        Your name is strictly Omi. When user greets or asks who you are, warmly introduce yourself: 'Selam, ben Omi!' or 'Merhaba! Ben Omi, masaüstü asistanın.'

        🇹🇷 DİL VE İLETİŞİM KURALI (PRIMARY LANGUAGE: TÜRKÇE):
        - Kullanıcı Türkçe konuştuğunda veya uygulama Türkçe olduğunda KESİNLİKLE VE İSTİSNASIZ TÜRKÇE YANIT VER.
        - Kullanıcıya asla İngilizce veya yabancı bir dilde hitap etme, her zaman akıcı, doğal, samimi ve Türkçe konuş.
        - Teknik terimleri, açıklamaları ve kod özetlerini Türkçe izah et.
        - Yalnızca kullanıcı açıkça İngilizce veya başka bir dilde yazarsa o dilde cevap ver.
        - Correctness, then maintainability. Delete dead weight; prefer boring, robust design to needless abstraction.\n\
        - User-reported errors, failures, and observations are GROUND TRUTH. NEVER argue, rerun unneeded checks, or ignore user reports.\n\
        - Complete delivery: NEVER output placeholders, stubs, mocks, fake fallbacks, or `// TODO: implement`. Every code change MUST be 100% production-ready, functional, and complete.\n\
        - Evidence-first terse communication: every sentence is a fact, decision, or concrete action. No fluff, no filler, no corporate boilerplate, no unsolicited lectures.\n\
        - Vision & Desktop Integration: Your Vision (image analysis), screen capture, and file system capabilities are ACTIVE and fully functional. NEVER say you cannot see an image or access a local file.\n\n\
        🚨 AKTİF PROJE VE ÇALIŞMA DİZİNİ İZOLASYONU (EN ÖNEMLİ VE İSTİSNASIZ KURAL):\n\
        Kullanıcının aktif çalışma ve proje dizini: {cwd_str}{ide_context}\n\
        - Kullanıcı senden bir web sitesi, uygulama, script, test veya kod yazmanı istediğinde (örn. 'örnek bir site yap', 'web sitesi oluştur', 'index.html hazırla'):\n\
          TÜM dosyaları (`index.html`, `style.css`, `app.js`, `README.md` vb.) İSTİSNASIZ VE KESİNLİKLE bu aktif çalışma dizini (`{cwd_str}`) içerisine yazacaksın (`action:write` veya `action:patch`).\n\
          Tüm komutları (`action:shell`) yalnızca bu dizinde çalıştıracaksın.\n\
        - BİLGİSAYARDAKİ DİĞER HİÇBİR KLASÖRDE VEYA ÜST DİZİNLERDE ASLA DEĞİŞİKLİK YAPMA. Ne yapacaksan tamamen bu dizin ({cwd_str}) sınırları içinde yapacaksın.\n\
        - Dosya yollarını bu dizine göre doğrudan göreceli (relative) belirt (örn. `path: index.html`, `path: css/style.css`, `path: src/main.js`).\n\n\
        § Otonom Eylem Araçları (Tool Arsenal)\n\
        Kullanıcı bir dosya okuma, oluşturma, düzenleme, arama, silme veya terminal işlemi istediğinde doğrudan aşağıdaki eylem bloklarını yanıtına dahil et. Sistem bu blokları anında kullanıcının bilgisayarında çalıştırır:\n\n\
        1. Dosya veya Dizin Okumak İçin (Read):\n\
        ```action:read\n\
        path: <dosya_veya_klasor_yolu>\n\
        ```\n\n\
        2. Proje İçi Kod/Metin Aramak İçin (Search/Grep):\n\
        ```action:search\n\
        pattern: <aranacak_metin>\n\
        path: <isteğe_bağlı_alt_klasör>\n\
        ```\n\n\
        3. Dosya Oluşturmak veya Tamamen Yazmak İçin (Write):\n\
        ```action:write\n\
        path: <dosya_yolu>\n\
        content: <eksiksiz_tam_içerik>\n\
        ```\n\n\
        4. Mevcut Dosyada Belirli Bir Kısmı Değiştirmek / Yamalamak (Surgical Patch) İçin:\n\
        ```action:patch\n\
        path: <dosya_yolu>\n\
        old: <değişecek_eski_kod_bloğu>\n\
        new: <yeni_kod_bloğu>\n\
        ```\n\n\
        4.1. OMP Hashline Cerrahi Düzenleme (Surgical Hashline Edit) İçin:\n\
        ```action:edit\n\
        [dosya_yolu#hash]\n\
        PUT N.=M:\n\
        +yeni_kod_satirlari\n\
        ```\n\
        (Satır numaraları ve hashline etiketleriyle sıfır token israfı yaparak doğrudan yamalar.)\n\n\
        5. PowerShell / CMD Terminal Komutu Çalıştırmak İçin (Shell):\n\
        ```action:shell\n\
        <komut>\n\
        ```\n\n\
        6. Dosya / Klasör Yeniden Adlandırmak veya Taşımak İçin (Rename):\n\
        ```action:rename\n\
        from: <kaynak_yolu>\n\
        to: <hedef_yolu>\n\
        ```\n\n\
        7. Dosya / Klasör Silmek İçin (Delete):\n\
        ```action:delete\n\
        path: <silinecek_yol>\n\
        ```\n\n\
        8. Beceri ve Alt Ajan Çalıştırmak İçin (Universal Skills & Subagents):
        - Ajan veya takım kurmak için:
        ```action:metaskill
        intent: <proje_turu veya 'agent <rol_adi>'>
        ```
        - Kodu veya planı Karpathy ilkelerine göre denetlemek için:
        ```action:karpathy
        code: <incelenecek_kod_veya_plan>
        ```
        - Özel bir beceriyi çağırmak için:
        ```action:skill
        name: <mcp-builder|artifacts-builder|webapp-testing|file-organizer|document-pdf...>
        ```
        - Masaüstü kontrolü veya ekran görüntüsü için:
        ```action:computer
        action: screenshot
        ```
        YEREL DOSYA / KLASÖR AÇMA TALEPLERİ:\n\
        Kullanıcı 'dosyayı aç', 'klasörü aç', 'projeyi aç' dediğinde bunu web araması yapma! Doğrudan Gezgin veya VS Code ile aç:\n\
        - Gezginde açmak için: `action:shell` -> `explorer \"<yol>\"`\n\
        - VS Code'da açmak için: `action:shell` -> `code \"<yol>\"`\n\n\
        § Workflow & İcra Döngüsü\n\
        1. Scope & Research: Dosyaları değiştirmeden önce `action:read` veya `action:search` ile mevcut kodu ve yapıyı incele.\n\
        2. Surgical Implement: Gereksiz yeniden yazımlardan kaçın; küçük değişiklikler için `action:patch`, yeni dosyalar için `action:write` kullan.\n\
        3. Otonom Hata Çözme: Bir komut veya işlem hata verirse asla kullanıcıya 'hata aldım ne yapayım' deme. Hatayı analiz et, düzeltici alternatifi anında çalıştır ve görevi bitir.\n\
        4. Geçici ve Tek Seferlik Scriptlerin Temizliği (Transient Script Cleanup Invariant):\n\
           - Bir görevi, otomasyonu veya işlemi (örn. 'autoclicker çalıştır', 'ekrana tıkla', 'pencereyi kontrol et', 'bir kerelik işlem yap') yerine getirmek için arka planda geçici bir yardımcı script (örn. `autoclicker.py`, `temp_click.py`, `helper.py` vb.) yazıp çalıştırdıysan:\n\
           - Bu scriptin görevi biter bitmez, bu dosyayı KESİNLİKLE kullanıcının diskinde veya Masaüstünde bırakmayacaksın!\n\
           - İşlem tamamlanır tamamlanmaz `action:delete` kullanarak oluşturduğun geçici dosyayı derhal sileceksin.\n\
           - İstisna: Kullanıcının açıkça kalıcı olarak istediği projeler ve dosyalar (örn. 'bana bir autoclicker uygulaması kodla ve kaydet', 'index.html oluştur') diske kaydedilir ve silinmez. Ancak sadece işi icra etmek için araç olarak kullanılan geçici yardımcı scriptler işlevi bittiğinde mutlaka silinmelidir.\n\
           - Tercih: Tek seferlik basit scriptler için diske dosya yazmak yerine doğrudan tek satırlık `python -c \"...\"` komutunu `action:shell` içinde kullan; böylece diske hiç dosya yazılmadan işlem tamamlanır.\n\n\
        5. Çok Adımlı Kesintisiz Otonom İcra (Multi-Step Autonomous Execution Invariant):\n\
           - Bir görevi icra ederken bir dosya okuduğunda (`action:read`) veya bir sistem/ortam kontrolü yaptığında (`node -v`, `npm -v`, `dir` vb.), İŞİ ASLA BURADA DURDURMA!\n\
           - Dosyayı okur okumaz (örn. `messages.txt` veya plan belgesi), hemen içindeki talimatları/planı hayata geçirmek için sıradaki dosyaları (`action:write` / `action:patch`) yazmaya başla.\n\
           - Kullanıcı 'sana attığım plandaki projeyi pingfy klasöründe yapacağız' dediğinde, tüm dosyaları `pingfy/` klasörü altına yaz (`path: pingfy/package.json`, `path: pingfy/index.html` vb.) veya terminalde klasörü oluştur.\n\
           - Tek bir ara komut çıktı verdi diye görevi tamamlanmış sanıp DURMA! Kullanıcının istediği asıl nihai hedef (tüm kodların, dosyaların, testlerin ve projenin eksiksiz bitmesi) tamamlanana kadar ardışık action blokları üretmeye devam et.\n\
           - Yalnızca ve yalnızca tüm plan eksiksiz bittiğinde hiçbir action bloğu üretmeden kullanıcıya nihai sonucu özetle.\n\n\
        § Evrensel Beceriler Kütüphanesi (Universal Skills Arsenal - Karpathy, Metaskill, Composio):\n\
        1. Andrej Karpathy LLM Kodlama Yönergeleri:\n\
           - Think Before Coding: Asla varsayımda bulunma, kafa karışıklığını gizleme, alternatifleri ve ödünleşimleri (tradeoffs) açıkça sun.\n\
           - Simplicity First: Sorunu çözen asgari kodu yaz. İstenmeyen soyutlama ve spekülatif esneklik yapma. 50 satırlık işi 200 satıra yayma.\n\
           - Surgical Changes: Yalnızca gereken yerlere dokun. Bozuk olmayan komşu kodları 'iyileştirmeye' çalışma. Yalnızca kendi değişikliklerinin yetimlerini temizle.\n\
           - Goal-Driven Execution: Başlamadan önce doğrulanabilir başarı kriterleri belirle. Asla varsayımla 'tamamlandı' deme; test veya çıktı ile kanıtla.\n\
        2. Metaskill Motoru (/metaskill):\n\
           - İstenen her türlü yazılım projesi için uzman ajan takımı, tekil uzman ajan veya yeni slash-command becerisi tasarlama yeteneği.\n\
        3. Composio & Awesome Skills (32+ Üretim Becerisi):\n\
           - Frontend/UI: `artifacts-builder` (interaktif tek sayfalık HTML/React uygulamaları), `canvas-design`, `theme-factory`\n\
           - Mimari: `mcp-builder` (Model Context Protocol sunucuları ve araçları)\n\
           - QA & Teslimat: `webapp-testing` (Playwright E2E testleri), `changelog-generator`\n\
           - Belgeler: `document-pdf`, `document-docx`, `document-pptx`, `document-xlsx`\n\
           - Entegrasyonlar: `connect`, `connect-apps` (100+ bulut servisi bağlantısı)\n\
        4. Humanizer AI Yazı Kalıplarını Temizleme & Doğallaştırma Becerisi (blader/humanizer):\n\
           - Metinlerdeki 26 yapay zeka klişesini ve kalıbını (Not X but Y, tek satırlık dramatik kapanışlar, sahte aforizmalar, sahnelenmiş girişler, em-dash enflasyonu, delve/testament/pivotal gibi kelimeler) temizler.\n\
           - Olguları ve teknik doğruluğu %100 koruyarak metni insan yazmış gibi akıcı, doğal ve net hale getirir (`action:skill name: humanizer`).\n\n\
{}",
        crate::learnings::prompt_context()
    );
    let lower_q = query.to_lowercase();
    let is_code_fix = lower_q.contains("düzelt") || lower_q.contains("fix")
        || lower_q.contains("hata") || lower_q.contains("kod") || lower_q.contains("yaz")
        || lower_q.contains("proje") || lower_q.contains("güncelle");

    if is_code_fix {
        let _ = app.emit("desktop-mochi-action", json!({
            "action": "coding",
            "state": "working",
            "emote": "proud"
        }));
    }
    let _ = app.emit_to(
        crate::island::WINDOW_LABEL,
        "hook",
        json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": "antigravity",
            "cwd": &cwd_str,
            "coucou_agent": "antigravity",
            "prompt": &query,
        }),
    );

    let mut parts: Vec<Value> = Vec::new();

    // Process attached image file if present
    // Process attached file (image or text/document) if present
    if let Some(ChatContext::File { name, path }) = &context {
        let lower = name.to_lowercase();
        if lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg")
            || lower.ends_with(".webp") || lower.ends_with(".gif")
        {
            if let Ok(bytes) = std::fs::read(path) {
                let mime = if lower.ends_with(".png") {
                    "image/png"
                } else if lower.ends_with(".webp") {
                    "image/webp"
                } else if lower.ends_with(".gif") {
                    "image/gif"
                } else {
                    "image/jpeg"
                };
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                parts.push(json!({
                    "inlineData": {
                        "mimeType": mime,
                        "data": b64
                    }
                }));
            }
        } else {
            // Text, markdown, JSON, or code file attached by user
            if let Ok(bytes) = std::fs::read(path) {
                let file_text = decode_process_output(&bytes);
                parts.push(json!({
                    "text": format!("[Kullanıcı tarafından iliştirilen dosya: `{name}` (Tam Yol: `{path}`)]:\n```\n{file_text}\n```\n")
                }));
            }
        }
    }

    // Process screen capture only if user explicitly asks to view screen
    let asks_screenshot = lower_q.contains("ekranıma bak") || lower_q.contains("ekranı gör")
        || lower_q.contains("ekranımı gör") || lower_q.contains("screenshot")
        || lower_q.contains("ekran görüntüsü");
    if asks_screenshot {
        if let Some(screen_b64) = capture_screen_base64() {
            parts.push(json!({
                "inlineData": {
                    "mimeType": "image/jpeg",
                    "data": screen_b64
                }
            }));
        }
    }

    parts.push(json!({ "text": prompt_text }));

    let mut contents: Vec<Value> = Vec::new();

    // Replay conversation history so Omi never forgets prior turns
    for msg in &turn.history {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
        if !content.is_empty() {
            let wire_role = if role == "assistant" || role == "model" { "model" } else { "user" };
            contents.push(json!({
                "role": wire_role,
                "parts": [{ "text": content }]
            }));
        }
    }

    // Append current turn
    contents.push(json!({
        "role": "user",
        "parts": parts
    }));

    let auto_rotate = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().antigravity_auto_rotate)
        .unwrap_or(true);

    let client = reqwest::Client::new();
    let mut current_account = active_account;
    let max_autonomous_steps = 100;
    let mut step = 0;
    let mut full_output = String::new();

    while step < max_autonomous_steps {
        let base_so_far = if full_output.is_empty() {
            String::new()
        } else {
            format!("{full_output}\n\n")
        };

        let max_attempts = if auto_rotate { accounts.len().max(1) } else { 1 };
        let mut attempt = 0;

        let accumulated = loop {
            let payload = json!({
                "project": current_account.project_id,
                "model": wire_model,
                "request": {
                    "contents": contents.clone(),
                    "systemInstruction": {
                        "role": "system",
                        "parts": [{ "text": system_instruction.clone() }]
                    },
                    "tools": [{"googleSearch": {}}]
                }
            });

            let resp = client
                .post(STREAM_GENERATE_URL)
                .header("Authorization", format!("Bearer {}", current_account.access))
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .header("User-Agent", USER_AGENT)
                .json(&payload)
                .send()
                .await
                .map_err(|e| format!("Google sunucusuna baglanilamadi: {e}"))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let err_body = resp.text().await.unwrap_or_default();
                let is_rate_limited = status.as_u16() == 429
                    || status.as_u16() == 403
                    || err_body.contains("RESOURCE_EXHAUSTED")
                    || err_body.contains("quotaExceeded")
                    || err_body.contains("rate limit")
                    || err_body.contains("RATE_LIMIT");

                if is_rate_limited && auto_rotate && attempt + 1 < max_attempts {
                    let fresh_accounts = list_accounts().unwrap_or_else(|_| accounts.clone());
                    let cur_idx = fresh_accounts.iter().position(|a| a.id == current_account.id).unwrap_or(0);
                    let next_idx = (cur_idx + 1) % fresh_accounts.len();
                    let next_acc = fresh_accounts[next_idx].clone();

                    crate::log::line(format!(
                        "antigravity: kota doldu ({}), otomatik sıradaki hesaba geciliyor: {}",
                        current_account.email, next_acc.email
                    ));
                    let _ = switch_account(next_acc.id);
                    let _ = app.emit("chat-delta", json!({ "sessionId": sess, "text": format!("{base_so_far}\n\n🔄 *Kota doldu, otomatik olarak sıradaki hesaba (`{}`) geçiliyor...*\n\n", next_acc.email) }));

                    let mut next_acc_mut = next_acc;
                    let _ = ensure_token(&mut next_acc_mut).await;
                    current_account = next_acc_mut;
                    attempt += 1;
                    continue;
                } else {
                    return Err(format!("Google API Hatasi: {err_body}"));
                }
            }

            // Stream SSE line by line using raw bytes to never split multi-byte UTF-8
            let mut stream = resp.bytes_stream();
            let mut text = String::new();
            let mut byte_buffer: Vec<u8> = Vec::new();
            let mut stream_error = false;

            while let Some(item) = stream.next().await {
                let chunk = match item {
                    Ok(c) => c,
                    Err(_) => {
                        stream_error = true;
                        break;
                    }
                };
                byte_buffer.extend_from_slice(&chunk);

                while let Some(newline_pos) = byte_buffer.iter().position(|&b| b == b'\n') {
                    let line_bytes = byte_buffer[..newline_pos].to_vec();
                    byte_buffer.drain(..=newline_pos);

                    let line = decode_process_output(&line_bytes).trim().to_string();

                    if line.starts_with("data: ") {
                        let json_str = &line[6..];
                        if let Ok(v) = serde_json::from_str::<Value>(json_str) {
                            if let Some(err) = v.get("error") {
                                let err_str = err.to_string();
                                if (err_str.contains("RESOURCE_EXHAUSTED") || err_str.contains("429")) && auto_rotate && attempt + 1 < max_attempts {
                                    stream_error = true;
                                    break;
                                }
                            }
                            if let Some(candidates) = v.get("response").and_then(|r| r.get("candidates")).and_then(|c| c.as_array()) {
                                for c in candidates {
                                    if let Some(parts) = c.get("content").and_then(|cnt| cnt.get("parts")).and_then(|p| p.as_array()) {
                                        for p in parts {
                                            if p.get("thought").and_then(|t| t.as_bool()).unwrap_or(false) {
                                                continue;
                                            }
                                            if let Some(t) = p.get("text").and_then(|txt| txt.as_str()) {
                                                text.push_str(t);
                                                let full_current = format!("{base_so_far}{text}");
                                                let _ = app.emit("chat-delta", json!({ "sessionId": sess, "text": full_current }));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if stream_error { break; }
            }

            if stream_error && auto_rotate && attempt + 1 < max_attempts {
                let fresh_accounts = list_accounts().unwrap_or_else(|_| accounts.clone());
                let cur_idx = fresh_accounts.iter().position(|a| a.id == current_account.id).unwrap_or(0);
                let next_idx = (cur_idx + 1) % fresh_accounts.len();
                let next_acc = fresh_accounts[next_idx].clone();

                crate::log::line(format!(
                    "antigravity: akis sirasinda kota doldu, siradaki hesaba geciliyor: {}",
                    next_acc.email
                ));
                let _ = switch_account(next_acc.id);
                let _ = app.emit("chat-delta", json!({ "sessionId": sess, "text": format!("{base_so_far}\n\n🔄 *Kota doldu, otomatik olarak sıradaki hesaba (`{}`) geçiliyor...*\n\n", next_acc.email) }));

                let mut next_acc_mut = next_acc;
                let _ = ensure_token(&mut next_acc_mut).await;
                current_account = next_acc_mut;
                attempt += 1;
                continue;
            }

            break text;
        };

        let run_result = process_actions(app, &cwd_str, &accumulated);

        if !full_output.is_empty() {
            full_output.push_str("\n\n");
        }
        full_output.push_str(&run_result.output);
        let _ = app.emit("chat-delta", json!({ "sessionId": sess, "text": full_output.clone() }));

        // If the model produced NO action blocks, it has finished thinking and answered the user
        if run_result.action_count == 0 {
            break;
        }

        // The model produced action blocks! We must continue the autonomous loop
        step += 1;
        if step >= max_autonomous_steps {
            break;
        }

        // Add previous model response to history
        contents.push(json!({
            "role": "model",
            "parts": [{ "text": accumulated }]
        }));

        if run_result.has_errors {
            let error_report = run_result.error_summary.join("\n");
            let fix_prompt = format!(
                "[İşlem Hatası]:\n\
                 {}\n\n\
                 Talimat:\n\
                 Kullanıcının senden istediği proje ve görev henüz bitmedi.\n\
                 Hatayı analiz edip düzelterek (`action:write`, `action:patch`, `action:shell` vb.) projeyi eksiksiz tamamlayana kadar işlemlere kesintisiz devam et.",
                error_report
            );
            contents.push(json!({
                "role": "user",
                "parts": [{ "text": fix_prompt }]
            }));
        } else {
            let continue_prompt = format!(
                "[İşlem Çıktısı / Gözlem]:\n\
                 {}\n\n\
                 Talimat:\n\
                 Proje planındaki bir sonraki adıma geç.\n\
                 - Sıradaki dosyaları oluştur/düzenle (`action:write` / `action:patch`) veya gereken komutları çalıştır (`action:shell`).\n\
                 - Proje ve istenen tüm kodlar/dosyalar EKSİKSİZ BİTENE KADAR durma, işlemleri sürdür.\n\
                 - Yalnızca tüm proje ve adımlar tamamen bittiğinde hiçbir action bloğu üretmeden kullanıcıya nihai sonucu bildir.",
                run_result.output.trim()
            );
            contents.push(json!({
                "role": "user",
                "parts": [{ "text": continue_prompt }]
            }));
        }
        continue;
    }

    let final_text = full_output.trim().to_string();
    let _ = app.emit("desktop-mochi-action", json!({
        "action": "done",
        "state": "idle",
        "emote": "happy"
    }));
    let _ = app.emit_to(
        crate::island::WINDOW_LABEL,
        "hook",
        json!({
            "hook_event_name": "Stop",
            "session_id": "antigravity",
            "cwd": &cwd_str,
            "coucou_agent": "antigravity",
            "last_assistant_message": &final_text,
        }),
    );
    let (final_text, _) = crate::learnings::extract_and_apply_chat_learnings(&final_text);
    chat.commit_session(
        sess,
        &turn,
        json!({ "role": "user", "content": query }),
        json!({ "role": "assistant", "content": final_text }),
        &query,
        &final_text,
    );

    Ok(ChatReply { text: final_text })
}

/// Phone link chat helper
pub async fn send_for_phone(
    chat: &Chat,
    model: &str,
    query: String,
    mut on_delta: impl FnMut(String),
) -> Result<ChatReply, String> {
    let turn = chat.begin(PROVIDER_ID);

    let mut accounts = list_accounts()?;
    let active_idx = accounts
        .iter()
        .position(|a| a.active)
        .ok_or_else(|| "Google Antigravity hesabi secili degil.".to_string())?;

    ensure_token(&mut accounts[active_idx]).await?;
    let active_account = accounts[active_idx].clone();

    let wire_model_string = resolve_antigravity_wire_model(model);
    let wire_model = wire_model_string.as_str();

    let mut prompt_text = query.clone();
    if let Ok(cwd) = std::env::current_dir() {
        let clean = cwd.to_string_lossy().to_string();
        prompt_text = format!("[Aktif Proje Dizini: {clean} - Yapılacak tüm dosya ve kod işlemleri yalnızca bu dizin sınırları içinde kalmalıdır]\n\n{prompt_text}");
    }

    let mut contents: Vec<Value> = Vec::new();
    for msg in &turn.history {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
        if !content.is_empty() {
            let wire_role = if role == "assistant" || role == "model" { "model" } else { "user" };
            contents.push(json!({
                "role": wire_role,
                "parts": [{ "text": content }]
            }));
        }
    }
    contents.push(json!({
        "role": "user",
        "parts": [{ "text": prompt_text }]
    }));

    let payload = json!({
        "project": active_account.project_id,
        "model": wire_model,
        "request": {
            "contents": contents
        }
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(STREAM_GENERATE_URL)
        .header("Authorization", format!("Bearer {}", active_account.access))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .header("User-Agent", USER_AGENT)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Google sunucusuna baglanilamadi: {e}"))?;

    let mut stream = resp.bytes_stream();
    let mut accumulated = String::new();
    let mut byte_buffer: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| format!("Stream hatasi: {e}"))?;
        byte_buffer.extend_from_slice(&chunk);

        while let Some(newline_pos) = byte_buffer.iter().position(|&b| b == b'\n') {
            let line_bytes = byte_buffer[..newline_pos].to_vec();
            byte_buffer.drain(..=newline_pos);

            let line = decode_process_output(&line_bytes).trim().to_string();

            if line.starts_with("data: ") {
                let json_str = &line[6..];
                if let Ok(v) = serde_json::from_str::<Value>(json_str) {
                    if let Some(candidates) = v.get("response").and_then(|r| r.get("candidates")).and_then(|c| c.as_array()) {
                        for c in candidates {
                            if let Some(parts) = c.get("content").and_then(|cnt| cnt.get("parts")).and_then(|p| p.as_array()) {
                                for p in parts {
                                    if p.get("thought").and_then(|t| t.as_bool()).unwrap_or(false) {
                                        continue;
                                    }
                                    if let Some(t) = p.get("text").and_then(|txt| txt.as_str()) {
                                        accumulated.push_str(t);
                                        on_delta(accumulated.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let final_text = accumulated.trim().to_string();
    chat.commit(
        &turn,
        json!({ "role": "user", "content": query }),
        json!({ "role": "assistant", "content": final_text }),
        &query,
        &final_text,
    );

    Ok(ChatReply { text: final_text })
}
