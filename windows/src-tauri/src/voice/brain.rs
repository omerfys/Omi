// « OK Coucou »'s brain: Claude with the user's key and Coucou's tools —
// pills, music, the user's own data, opening an app, preparing an email (the
// mail app opens with it filled in; the user sends it) and Anthropic's web
// search. The conversation lives in memory only and is forgotten 90 s after
// the last turn. Port of ClaudeVoiceBrain.swift.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const FAST_MODEL: &str = "claude-haiku-4-5";
const FORGET_AFTER: Duration = Duration::from_secs(90);

pub struct Brain {
    messages: Vec<Value>,
    last: Instant,
}

impl Default for Brain {
    fn default() -> Self {
        Self { messages: Vec::new(), last: Instant::now() }
    }
}

pub struct Reply {
    pub text: String,
    pub acted: bool,
}

fn tools() -> Vec<Value> {
    vec![
        json!({
            "name": "pills",
            "description": "Add, remove, set as main or list the pills shown in the island at the top of the screen. At most 4 pills besides the main one: remove one first if needed.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["add", "remove", "set_main", "list"] },
                    "names": { "type": "array", "items": { "type": "string" }, "description": "Pill names as listed (e.g. Stripe, GitHub, Cursor). Empty for list." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "music",
            "description": "Control Spotify: play or pause, next, previous, set the volume, or search a song, an artist or a playlist in Spotify.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["play_pause", "next", "previous", "set_volume", "search"] },
                    "query": { "type": "string", "description": "What to search, for search." },
                    "volume": { "type": "integer", "description": "0-100 for set_volume." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "service_info",
            "description": "Read the user's real data that Coucou already has, as JSON: the active pills, the agent sessions (Claude Code, Codex…) and what they are doing, Claude or Codex plan usage, Spotify now playing, and the services' latest data (Stripe, GitHub, Vercel, Resend, n8n, Notion, Cal.com).",
            "input_schema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "open_app",
            "description": "Masaüstündeki veya bilgisayardaki herhangi bir uygulamayı, oyunu veya başlatıcıyı açar (örn. Modrinth, Minecraft, VS Code, Spotify, Steam, Discord, Chrome, Roblox, vb.).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Açılacak uygulamanın, oyunun veya başlatıcının adı (örn. 'Modrinth', 'Minecraft', 'Spotify', 'Steam')." }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "prepare_email",
            "description": "Open the user's mail app with an email filled in, for them to check and send (it is never sent automatically). The recipient must be an email address.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "recipient": { "type": "string", "description": "An email address." },
                    "subject": { "type": "string" },
                    "body": { "type": "string", "description": "The full email text, written for the user." }
                },
                "required": ["recipient", "subject", "body"]
            }
        }),
        json!({
            "name": "open_url",
            "description": "Open any web URL in the user's default browser (e.g. YouTube video, website, article).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The full http or https URL to open." }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "youtube",
            "description": "Search and play a video or channel on YouTube in the browser. Example: query 'Eray son video'.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query or video name." },
                    "url": { "type": "string", "description": "Optional direct YouTube video URL." }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "shell",
            "description": "Run a system command or launch a tool on the user's computer.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command to run." }
                },
                "required": ["command"]
            }
        }),
        json!({
            "name": "learn_rule",
            "description": "Kullanıcı 'bundan sonra böyle yap', 'bunu şu yöntemle yap', 'bu yöntem doğru' dediğinde veya belirli bir işlem için bir yöntem/tercih öğrettiğinde bu kuralı kalıcı olarak kaydeder.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "topic": { "type": "string", "description": "Öğrenilen işlemin veya konunun kısa adı (örn. 'antigravity açma', 'youtube arama', 'müzik çalma')." },
                    "rule": { "type": "string", "description": "Kullanıcının istediği kesin yöntem, adım adım kural veya tercih." }
                },
                "required": ["topic", "rule"]
            }
        }),
        json!({ "type": "web_search_20250305", "name": "web_search", "max_uses": 3 }),
    ]
}

fn system_prompt(pills: &str) -> String {
    let t = crate::platform::local_time();
    let os = if cfg!(windows) { "Windows" } else { "Linux" };
    let learnings = crate::learnings::prompt_context();
    format!(
        "Sen Omi'sin — kullanıcının {os} bilgisayarının başında yaşayan akıllı, yetenekli ve samimi sesli asistanısın. \
Tarih ve saat: {:04}-{:02}-{:02} {:02}:{:02}.\n\n\
🇹🇷 DİL VE İLETİŞİM KURALI: Kullanıcı seninle Türkçe konuştuğunda veya varsayılan dilde KESİNLİKLE VE İSTİSNASIZ TÜRKÇE YANIT VER. \
Asla kullanıcıya İngilizce cevap verme! Doğal, akıcı, sıcak ve Türkçe konuş.\n\
⚡ SESLİ SOHBET HIZI VE SIFIR DÜŞÜNME GECİKMESİ:\n\
- Düşünme (thinking) aşamasıyla vakit kaybetme, ilk andan itibaren doğrudan konuşmaya başla.\n\
- Karşılıklı canlı konuşma temposundasın. Cevapların HER ZAMAN 1 veya EN FAZLA 2 KISA konuşma cümlesi olmalıdır.\n\
- Asla markdown formatı, başlıklar, madde işaretleri, emojiler veya teknik açıklamalar kullanma.\n\
Tarif etmek yerine araçları kullanarak doğrudan eyleme geç: open_app (Masaüstündeki veya bilgisayardaki uygulamaları/oyunları açma: Modrinth, Minecraft, Spotify, Steam vb.), youtube (YouTube'da video veya müzik açma), open_url (web sitesi veya link açma), shell (sistem komutları), pills, music (şarkı çalma/durdurma), learn_rule (yeni kural/yöntem öğrenme), prepare_email ve web_search.\n\
Kullanıcı senden bir uygulama açmanı istediğinde (örn. 'Modrinth aç', 'Minecraft aç', 'Spotify aç') hemen open_app aracını çalıştır. YouTube'da bir video veya site istediğinde youtube veya open_url araçlarını hemen çalıştır.\n\
Kullanıcıdan bilgiye ihtiyacın olduğunda sonunda tek bir kısa soru sor. Aksi halde asla soruyla bitirme.\n\
Pills: {pills}\
{learnings}",
        t.year, t.month, t.day, t.hour, t.minute
    )
}

impl Brain {
    pub fn respond(&mut self, app: &AppHandle, transcript: &str) -> Option<Reply> {
        if self.last.elapsed() > FORGET_AFTER {
            self.messages.clear();
        }
        self.last = Instant::now();

        // ── LAYA SYSTEM 1 FAST-PATH (Zero-LLM Instant Direct Actions) ─────────
        let laya_decision = crate::laya::classify_voice_intent(transcript);
        crate::log::line(format!(
            "laya: voice intent -> {:?}, target: {:?}, conf: {:.2}, fallback: {}",
            laya_decision.intent, laya_decision.target, laya_decision.confidence, laya_decision.fallback
        ));

        if laya_decision.confidence >= 0.55 {
            match laya_decision.intent {
                crate::laya::VoiceIntentKind::Music => {
                    let lower = transcript.to_lowercase();
                    let (action, spoken_reply) = if lower.contains("sonraki") || lower.contains("geç") || lower.contains("atla") {
                        ("next", "Sonraki şarkıya geçiyorum.")
                    } else if lower.contains("önceki") || lower.contains("başa sar") {
                        ("previous", "Önceki şarkıya geçiyorum.")
                    } else if lower.contains("durdur") || lower.contains("dur") || lower.contains("kapat") || lower.contains("kes") {
                        ("play_pause", "Müziği durdurdum.")
                    } else if lower.contains("devam") || lower.contains("oynat") || lower.contains("çal") {
                        if let Some(target) = laya_decision.target.as_deref().filter(|t| !t.is_empty()) {
                            let (_, did) = super::run_tool(app, "music", &json!({ "action": "search", "query": target }));
                            return Some(Reply { text: format!("{target} çalınıyor."), acted: did });
                        } else {
                            ("play_pause", "Müziği devam ettiriyorum.")
                        }
                    } else {
                        ("play_pause", "Müzik ayarlandı.")
                    };
                    let (_, did) = super::run_tool(app, "music", &json!({ "action": action }));
                    return Some(Reply { text: spoken_reply.to_string(), acted: did });
                }
                crate::laya::VoiceIntentKind::OpenApp => {
                    if let Some(app_name) = laya_decision.target.as_deref().filter(|a| !a.is_empty()) {
                        let (res, did) = super::run_tool(app, "open_app", &json!({ "name": app_name }));
                        if did {
                            return Some(Reply { text: format!("{app_name} açılıyor."), acted: true });
                        } else {
                            crate::log::line(format!("laya: open_app failed: {res}, falling back to conversational LLM"));
                        }
                    }
                }
                crate::laya::VoiceIntentKind::YouTube => {
                    if let Some(query) = laya_decision.target.as_deref().filter(|q| !q.is_empty()) {
                        let (_, did) = super::run_tool(app, "youtube", &json!({ "query": query }));
                        return Some(Reply { text: format!("YouTube'da {query} açılıyor."), acted: did });
                    }
                }
                _ => {}
            }
        }

        let user_content = format!("[DİL: TÜRKÇE - Lütfen cevabını tamamen Türkçe olarak seslendir]\n{transcript}");
        self.messages.push(json!({ "role": "user", "content": user_content }));
        self.trim();
        let pills = super::ask_island(app, "pills", json!({ "action": "list" })).unwrap_or_default();
        let system = system_prompt(&pills);

        // ── LAYA TOOL PRUNING (Strips unneeded tools to minimize TTFT) ────────
        let all_tools = tools();
        let tools = crate::laya::prune_tools(transcript, &all_tools);
        let (chat_model, _chat_provider) = app
            .try_state::<crate::Shared>()
            .map(|s| {
                let st = s.settings.lock().unwrap();
                let provider = st.chat_provider.clone();
                let model = if provider == "anthropic" {
                    st.model.clone()
                } else if let Some(m) = st.chat_models.get(&provider) {
                    m.clone()
                } else if provider == crate::antigravity::PROVIDER_ID {
                    "gemini-3.8-flash".to_string()
                } else {
                    st.model.clone()
                };
                (model, provider)
            })
            .unwrap_or_default();

        let voice_model_pref = crate::flow::get(app)
            .map(|f| f.store.lock().unwrap().prefs.voice_model.clone())
            .unwrap_or_else(|| "antigravity/gemini-3.8-flash".into());

        let (provider, model_name) = if voice_model_pref.starts_with("antigravity/") {
            let m = voice_model_pref.trim_start_matches("antigravity/");
            let fast_m = match m {
                "gemini-3.8-flash" | "gemini-3.8-flash-high" | "gemini-3.8-flash-medium" => "gemini-3.8-flash-low",
                "gemini-3-pro" | "gemini-3-pro-high" => "gemini-3-pro-low",
                _ => m,
            };
            ("google-antigravity", fast_m)
        } else if voice_model_pref.starts_with("claude/") {
            ("anthropic", FAST_MODEL)
        } else if voice_model_pref.starts_with("openai/") {
            ("openai", voice_model_pref.trim_start_matches("openai/"))
        } else if crate::antigravity::has_active_account() {
            ("google-antigravity", "gemini-3.8-flash-low")
        } else {
            ("anthropic", FAST_MODEL)
        };
        let use_antigravity = provider == crate::antigravity::PROVIDER_ID || crate::antigravity::has_active_account();

        let mut acted = false;
        let mut spoken = String::new();
        for _ in 0..5 {
            let turn = tauri::async_runtime::block_on(async {
                if use_antigravity {
                    crate::antigravity::voice_turn(app, model_name, &system, &self.messages, &tools).await
                } else {
                    match crate::claude::voice_turn(model_name, &system, &self.messages, &tools).await {
                        Ok(v) => Ok(v),
                        Err(err) if !chat_model.is_empty() => {
                            crate::log::line(format!("voice: {err}; the chat's model instead"));
                            crate::claude::voice_turn(&chat_model, &system, &self.messages, &tools).await
                        }
                        Err(err) => Err(err),
                    }
                }
            });
            let turn = match turn {
                Ok(t) => t,
                Err(err) => {
                    crate::log::line(format!("voice turn failed: {err}"));
                    if self.messages.last().is_some_and(|m| m["content"].is_string()) {
                        self.messages.pop();
                    }
                    return Some(Reply { text: format!("Hata: {err}"), acted });
                }
            };
            let content = turn["content"].as_array().cloned().unwrap_or_default();
            self.messages.push(json!({ "role": "assistant", "content": content.clone() }));
            let text: String = content.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(" ");
            if !text.trim().is_empty() {
                spoken = text;
            }
            let stop = turn["stop_reason"].as_str().unwrap_or("end_turn");
            if stop == "pause_turn" {
                continue;
            }
            let uses: Vec<&Value> = content.iter().filter(|b| b["type"] == "tool_use").collect();
            if stop != "tool_use" || uses.is_empty() {
                break;
            }
            let mut results = Vec::new();
            for u in uses {
                let (result, did) = super::run_tool(app, u["name"].as_str().unwrap_or(""), &u["input"]);
                acted |= did;
                results.push(json!({ "type": "tool_result", "tool_use_id": u["id"], "content": result }));
            }
            self.messages.push(json!({ "role": "user", "content": results }));
            spoken.clear();
        }
        let (cleaned_spoken, action_acted) = super::execute_voice_actions(&spoken);
        acted |= action_acted;
        self.repair();
        Some(Reply { text: spoken_text(&cleaned_spoken), acted })
    }
    /// Keeps the last exchanges, never cutting between a tool call and its result.
    fn trim(&mut self) {
        if self.messages.len() <= 24 {
            return;
        }
        let mut cut = self.messages.len() - 24;
        while cut < self.messages.len() && !(self.messages[cut]["role"] == "user" && self.messages[cut]["content"].is_string()) {
            cut += 1;
        }
        self.messages.drain(..cut.min(self.messages.len() - 1));
    }

    /// The API refuses a history ending on a tool call with no result after it.
    fn repair(&mut self) {
        let Some(last) = self.messages.last() else { return };
        if last["role"] != "assistant" {
            return;
        }
        let calls = last["content"].as_array().is_some_and(|c| c.iter().any(|b| b["type"] == "tool_use"));
        if calls {
            self.messages.pop();
        }
    }
}

/// What Claude wrote, ready to be said: citations and markdown left out.
pub fn spoken_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut skip = 0;
    for c in text.chars() {
        match c {
            '[' => skip += 1,
            ']' if skip > 0 => skip -= 1,
            '*' | '#' | '`' | '_' if skip == 0 => {}
            _ if skip == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_and_citations_are_not_read_aloud() {
        assert_eq!(spoken_text("**Done** — Stripe [1] is in the island."), "Done — Stripe is in the island.");
        assert_eq!(spoken_text("  Il fait  20 °C à Bordeaux. "), "Il fait 20 °C à Bordeaux.");
    }

    #[test]
    fn every_tool_has_a_schema() {
        for tool in tools() {
            assert!(tool["name"].is_string());
            assert!(tool.get("input_schema").is_some() || tool["type"] == "web_search_20250305");
        }
    }
}
