//! Omi Laya System 1 Decision Engine
//! Provides sub-second typed decision evaluation for voice, computer use, and chat:
//! 1. Voice Intent (Zero-LLM instant action routing for music, apps, youtube, system)
//! 2. Dynamic Tool Pruning (strips unneeded tools to reduce Gemini/Claude TTFT)
//! 3. Computer Use Intent & Risk Assessment (safeguards destructive OS actions)
//! 4. Model Triage (routes between fast Flash vs deep Reasoning models)

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const LAYA_PORT: u16 = 41420;
const LAYA_URL: &str = "http://127.0.0.1:41420";
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);

static DAEMON_STARTED: AtomicBool = AtomicBool::new(false);

/// Ensures the local Laya decision worker daemon is running in background.
pub fn ensure_daemon() {
    if DAEMON_STARTED.load(Ordering::Relaxed) {
        return;
    }

    // Check if already responding
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(250))
        .build();
    if let Ok(c) = client {
        if c.get(format!("{LAYA_URL}/health")).send().is_ok() {
            DAEMON_STARTED.store(true, Ordering::Relaxed);
            return;
        }
    }

    // Spawn python laya_worker.py --server
    let mut script_candidates = vec![
        std::env::current_dir().unwrap_or_default().join("scripts").join("laya_worker.py"),
        std::env::current_dir().unwrap_or_default().join("windows").join("scripts").join("laya_worker.py"),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            script_candidates.push(parent.join("scripts").join("laya_worker.py"));
            script_candidates.push(parent.join("..").join("windows").join("scripts").join("laya_worker.py"));
        }
    }

    if let Some(script) = script_candidates.iter().find(|p| p.exists()) {
        let mut cmd = std::process::Command::new("python");
        cmd.arg(script).arg("--server").arg("--port").arg(LAYA_PORT.to_string());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        if let Ok(child) = cmd.spawn() {
            crate::log::line(format!("laya: spawned daemon with PID {}", child.id()));
            DAEMON_STARTED.store(true, Ordering::Relaxed);
        }
    }
}

pub fn stop_daemon() {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("powershell");
        cmd.arg("-NoProfile").arg("-Command").arg(
            "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*laya_worker*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        );
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let _ = cmd.output();
    }
    DAEMON_STARTED.store(false, Ordering::Relaxed);
}

// ── 1. Voice Intent ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceIntentKind {
    Music,
    OpenApp,
    YouTube,
    System,
    Chat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceIntentDecision {
    pub intent: VoiceIntentKind,
    pub target: Option<String>,
    pub confidence: f64,
    pub fallback: bool,
}

#[derive(Deserialize)]
struct RawVoiceIntentResponse {
    intent: String,
    confidence: f64,
    #[serde(default)]
    fallback: bool,
}

/// Classifies a voice command using Laya System 1 decision engine.
pub fn classify_voice_intent(text: &str) -> VoiceIntentDecision {
    ensure_daemon();
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .ok();

    if let Some(client) = client {
        let payload = serde_json::json!({ "text": text });
        if let Ok(res) = client.post(format!("{LAYA_URL}/voice_intent")).json(&payload).send() {
            if let Ok(data) = res.json::<RawVoiceIntentResponse>() {
                let kind = match data.intent.as_str() {
                    "music" => VoiceIntentKind::Music,
                    "open_app" => VoiceIntentKind::OpenApp,
                    "youtube" => VoiceIntentKind::YouTube,
                    "system" => VoiceIntentKind::System,
                    _ => VoiceIntentKind::Chat,
                };
                let target = extract_target_from_text(text, kind);
                return VoiceIntentDecision {
                    intent: kind,
                    target,
                    confidence: data.confidence,
                    fallback: data.fallback,
                };
            }
        }
    }

    // Heuristic fallback if daemon not responding yet
    fallback_voice_intent(text)
}

fn extract_target_from_text(text: &str, kind: VoiceIntentKind) -> Option<String> {
    let lower = text.trim();
    match kind {
        VoiceIntentKind::OpenApp => {
            // Strip common command endings
            let clean = lower
                .replace(" açar mısın", "")
                .replace(" aç", "")
                .replace(" başlatır mısın", "")
                .replace(" başlat", "")
                .replace(" çalıştır", "")
                .replace(" uygulamasını", "")
                .replace(" uygulamasını aç", "")
                .trim()
                .to_string();
            if clean.is_empty() { None } else { Some(clean) }
        }
        VoiceIntentKind::YouTube => {
            let clean = lower
                .replace("youtube'da", "")
                .replace("youtubeda", "")
                .replace("youtube", "")
                .replace(" video aç", "")
                .replace(" video ara", "")
                .replace(" videosunu aç", "")
                .replace(" izle", "")
                .replace(" aç", "")
                .trim()
                .to_string();
            if clean.is_empty() { None } else { Some(clean) }
        }
        VoiceIntentKind::Music => {
            let clean = lower
                .replace("spotify", "")
                .replace("şarkı", "")
                .replace("müzik", "")
                .replace("aç", "")
                .replace("çal", "")
                .trim()
                .to_string();
            if clean.is_empty() { None } else { Some(clean) }
        }
        _ => None,
    }
}

fn fallback_voice_intent(text: &str) -> VoiceIntentDecision {
    let lower = text.to_lowercase();
    if lower.contains("şarkı") || lower.contains("müzik") || lower.contains("spotify")
        || lower.contains("sonraki parça") || lower.contains("şarkıyı durdur") || lower.contains("sesi aç") || lower.contains("sesi kıs")
    {
        return VoiceIntentDecision {
            intent: VoiceIntentKind::Music,
            target: extract_target_from_text(text, VoiceIntentKind::Music),
            confidence: 0.95,
            fallback: true,
        };
    }
    if lower.contains("youtube") || lower.contains("video aç") || lower.contains("video izle") {
        return VoiceIntentDecision {
            intent: VoiceIntentKind::YouTube,
            target: extract_target_from_text(text, VoiceIntentKind::YouTube),
            confidence: 0.95,
            fallback: true,
        };
    }
    if (lower.contains("aç") || lower.contains("başlat"))
        && !lower.contains("nasıl") && !lower.contains("nedir") && !lower.contains("anlat")
    {
        return VoiceIntentDecision {
            intent: VoiceIntentKind::OpenApp,
            target: extract_target_from_text(text, VoiceIntentKind::OpenApp),
            confidence: 0.90,
            fallback: true,
        };
    }
    VoiceIntentDecision {
        intent: VoiceIntentKind::Chat,
        target: None,
        confidence: 0.80,
        fallback: true,
    }
}

// ── 2. Tool Pruning ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ToolPruningDecision {
    pub needs_web: bool,
    pub needs_computer_use: bool,
    pub needs_email: bool,
    #[serde(default)]
    pub fallback: bool,
}

/// Evaluates a query and prunes unneeded tool definitions before sending to LLM.
/// This significantly reduces prompt token size and TTFT (time-to-first-token).
pub fn prune_tools(text: &str, all_tools: &[Value]) -> Vec<Value> {
    ensure_daemon();
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .ok();

    let pruning: ToolPruningDecision = client
        .and_then(|c| {
            let payload = serde_json::json!({ "text": text });
            c.post(format!("{LAYA_URL}/tool_pruning"))
                .json(&payload)
                .send()
                .ok()?
                .json::<ToolPruningDecision>()
                .ok()
        })
        .unwrap_or_else(|| {
            let lower = text.to_lowercase();
            ToolPruningDecision {
                needs_web: lower.contains("hava") || lower.contains("haber") || lower.contains("araştır") || lower.contains("fiyat"),
                needs_computer_use: lower.contains("tıkla") || lower.contains("fare") || lower.contains("ekran"),
                needs_email: lower.contains("mail") || lower.contains("e-posta") || lower.contains("eposta"),
                fallback: true,
            }
        });

    all_tools
        .iter()
        .filter(|tool| {
            let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
            match name {
                "web_search" => pruning.needs_web,
                "prepare_email" => pruning.needs_email,
                "computer_use" | "playwright" => pruning.needs_computer_use,
                // Keep lightweight desktop control tools available by default
                _ => true,
            }
        })
        .cloned()
        .collect()
}

// ── 3. Computer Use Intent & Risk ─────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ComputerUseRisk {
    pub is_destructive: bool,
    pub risk_score: f64,
    pub confidence: f64,
    #[serde(default)]
    pub fallback: bool,
}

/// Evaluates if an automated OS action carries danger or destructive risk.
pub fn check_computer_use_risk(action: &str) -> ComputerUseRisk {
    ensure_daemon();
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .ok();

    if let Some(client) = client {
        let payload = serde_json::json!({ "action": action });
        if let Ok(res) = client.post(format!("{LAYA_URL}/computer_use_risk")).json(&payload).send() {
            if let Ok(risk) = res.json::<ComputerUseRisk>() {
                return risk;
            }
        }
    }

    let lower = action.to_lowercase();
    let destructive = lower.contains("sil") || lower.contains("delete") || lower.contains("remove")
        || lower.contains("kapat") || lower.contains("format") || lower.contains("kill");
    ComputerUseRisk {
        is_destructive: destructive,
        risk_score: if destructive { 1.8 } else { 0.2 },
        confidence: 0.90,
        fallback: true,
    }
}

// ── 4. Model Triage ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ModelRecommendation {
    pub target_model: String, // "flash" | "reasoning"
    pub difficulty: f64,
    #[serde(default)]
    pub fallback: bool,
}

/// Determines whether to route a prompt to an ultra-fast Flash model or a deep Reasoning model.
pub fn triage_model(prompt: &str) -> ModelRecommendation {
    ensure_daemon();
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .ok();

    if let Some(client) = client {
        let payload = serde_json::json!({ "prompt": prompt });
        if let Ok(res) = client.post(format!("{LAYA_URL}/model_triage")).json(&payload).send() {
            if let Ok(triage) = res.json::<ModelRecommendation>() {
                return triage;
            }
        }
    }

    let is_reasoning = prompt.len() > 300 || prompt.contains("refactor") || prompt.contains("mimari") || prompt.contains("debug");
    ModelRecommendation {
        target_model: if is_reasoning { "reasoning".to_string() } else { "flash".to_string() },
        difficulty: if is_reasoning { 1.5 } else { 0.3 },
        fallback: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fallback_voice_intent() {
        let music = fallback_voice_intent("Spotify sonraki parça");
        assert_eq!(music.intent, VoiceIntentKind::Music);

        let app = fallback_voice_intent("Minecraft açar mısın");
        assert_eq!(app.intent, VoiceIntentKind::OpenApp);
        assert_eq!(app.target.as_deref(), Some("Minecraft"));

        let yt = fallback_voice_intent("YouTube'da video izle");
        assert_eq!(yt.intent, VoiceIntentKind::YouTube);

        let chat = fallback_voice_intent("Bana Türkiye'nin başkentini söyle");
        assert_eq!(chat.intent, VoiceIntentKind::Chat);
    }

    #[test]
    fn test_fallback_computer_use_risk() {
        let safe = check_computer_use_risk("Pencere başlığını oku");
        assert!(!safe.is_destructive);
        assert!(safe.risk_score < 1.0);

        let dangerous = check_computer_use_risk("Tüm verileri sil");
        assert!(dangerous.is_destructive);
        assert!(dangerous.risk_score > 1.2);
    }

    #[test]
    fn test_fallback_model_triage() {
        let simple = triage_model("Merhaba günaydın");
        assert_eq!(simple.target_model, "flash");

        let hard = triage_model("Bu mimariyi refactor edip thread-safe hale getirelim");
        assert_eq!(hard.target_model, "reasoning");
    }
}
