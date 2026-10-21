// « OK Coucou » on Windows and Linux: say it, then ask anything. Port of the
// Mac's Voice/ (VoiceEngine.swift and its friends).
//
// While it is on, the microphone is open and a cheap energy detector cuts what
// you say into stretches; only a stretch of speech goes to Parakeet, on this
// computer, and only a stretch that starts with « OK Coucou » goes further:
// what you said after it goes to Claude with your own key (brain.rs), never
// the audio. Mochi shows it all in the pill at the bottom of the screen —
// listening, thinking, then the answer, said out loud by the system's voice
// (the pill's speechSynthesis) or ElevenLabs with your key.
//
// It stops listening while you dictate, while a call is recorded and while it
// speaks itself.

pub mod brain;
pub mod wake;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::flow::pill;
use crate::speech::{self, audio};

/// What the pill shows of a conversation.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceView {
    /// "listening", "thinking", "speaking".
    pub phase: String,
    /// What you said (after « OK Coucou »).
    pub heard: String,
    /// Coucou's answer.
    pub answer: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerMsg {
    ToggleConversation,
    #[allow(dead_code)]
    StopConversation,
}

struct Running {
    stop: Arc<AtomicBool>,
    trigger: mpsc::Sender<TriggerMsg>,
}

/// Silence hangover for interactive conversation (13 * 30ms = 390ms).
/// Drastically cuts latency between user stopping speech and AI beginning to answer.
const CONVERSATIONAL_HANGOVER: usize = 13;
/// Silence hangover for wake-word detection (15 * 30ms = 450ms).
const WAKE_HANGOVER: usize = 15;
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

/// Rust waits on these for the island's answers and the end of speech.
fn pending() -> &'static Mutex<HashMap<u64, mpsc::Sender<String>>> {
    static P: OnceLock<Mutex<HashMap<u64, mpsc::Sender<String>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Whether « OK Coucou » can run: the voice model and a Claude key.
pub fn requirements_met() -> bool {
    speech::is_ready() && (crate::antigravity::has_active_account() || crate::secrets::present(crate::claude::KEY))
}

/// Starts or stops listening to follow the preference.
pub fn sync(app: &AppHandle) {
    let wanted = crate::flow::get(app).is_some_and(|f| f.store.lock().unwrap().prefs.voice);
    let mut running = RUNNING.lock().unwrap();
    match (wanted && requirements_met(), running.is_some()) {
        (true, false) => {
            let stop = Arc::new(AtomicBool::new(false));
            let (tx, rx) = mpsc::channel();
            let app2 = app.clone();
            let stop2 = stop.clone();
            std::thread::Builder::new().name("omi-voice".into()).spawn(move || run(app2, stop2, rx)).ok();
            *running = Some(Running { stop, trigger: tx });
            speech::preload();
            crate::log::line("voice: « OK Coucou » listening");
        }
        (false, true) => {
            if let Some(r) = running.take() {
                r.stop.store(true, Ordering::Relaxed);
            }
            let dictation = crate::flow::get(app).is_some_and(|f| f.store.lock().unwrap().prefs.enabled);
            if !dictation && !crate::notes::is_recording(app) {
                speech::unload();
            }
            crate::log::line("voice: « OK Coucou » off");
        }
        _ => {}
    }
}

/// « OK Coucou » is listening (the voice model stays loaded).
pub fn is_listening() -> bool {
    RUNNING.lock().unwrap().is_some()
}

/// Starts again on another microphone.
pub fn restart(app: &AppHandle) {
    if let Some(r) = RUNNING.lock().unwrap().take() {
        r.stop.store(true, Ordering::Relaxed);
    }
    sync(app);
}

/// Toggles continuous conversation mode on demand (e.g. from global shortcut).
pub fn toggle_conversation(app: &AppHandle) {
    let mut running = RUNNING.lock().unwrap();
    if let Some(r) = running.as_ref() {
        let _ = r.trigger.send(TriggerMsg::ToggleConversation);
    } else {
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let app2 = app.clone();
        let stop2 = stop.clone();
        let _ = tx.send(TriggerMsg::ToggleConversation);
        std::thread::Builder::new().name("omi-voice".into()).spawn(move || run(app2, stop2, rx)).ok();
        *running = Some(Running { stop, trigger: tx });
        speech::preload();
        crate::log::line("voice: on-demand conversation started via shortcut");
    }
}

#[tauri::command]
pub fn voice_toggle_conversation(app: AppHandle) {
    toggle_conversation(&app);
}

fn show(app: &AppHandle, view: Option<VoiceView>) {
    pill::update(app, |s| s.voice = view);
}

enum Mode {
    /// Waiting for « OK Coucou ».
    Wake,
    /// Heard « OK Coucou » alone: what comes next is the question.
    Command { text: String, until: Instant },
    /// Coucou asked something back: an answer comes without « OK Coucou ».
    #[allow(dead_code)]
    FollowUp { until: Instant },
    /// Continuous back-and-forth conversational mode.
    Conversational { until: Instant },
}

fn run(app: AppHandle, stop: Arc<AtomicBool>, trigger_rx: mpsc::Receiver<TriggerMsg>) {
    let mic = crate::flow::get(&app).map(|f| f.store.lock().unwrap().prefs.mic.clone()).unwrap_or_default();
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let capture = audio::Capture::start(audio::Source::Mic(if mic.is_empty() { None } else { Some(mic) }), move |s| {
        let _ = tx.send(s.to_vec());
    });
    let mut capture = match capture {
        Ok(c) => c,
        Err(err) => {
            crate::log::line(format!("voice: microphone: {err}"));
            *RUNNING.lock().unwrap() = None;
            return;
        }
    };
    let mut vad = wake::Vad::default();
    let mut mode = Mode::Wake;
    let mut brain = brain::Brain::default();
    let mut hide_at: Option<Instant> = None;
    while !stop.load(Ordering::Relaxed) {
        while let Ok(msg) = trigger_rx.try_recv() {
            match msg {
                TriggerMsg::ToggleConversation => {
                    match mode {
                        Mode::Conversational { .. } => {
                            crate::log::line("voice: conversation stopped by shortcut toggle");
                            mode = Mode::Wake;
                            vad.hangover = WAKE_HANGOVER;
                            show(&app, None);
                            let continuous = crate::flow::get(&app).is_some_and(|f| f.store.lock().unwrap().prefs.voice);
                            if !continuous {
                                stop.store(true, Ordering::Relaxed);
                                break;
                            }
                        }
                        _ => {
                            crate::log::line("voice: conversation started by shortcut toggle");
                            let silence_timeout_secs = crate::flow::get(&app)
                                .map(|f| f.store.lock().unwrap().prefs.voice_silence_timeout)
                                .unwrap_or(8)
                                .max(3);
                            mode = Mode::Conversational { until: Instant::now() + Duration::from_secs(silence_timeout_secs) };
                            vad.hangover = CONVERSATIONAL_HANGOVER;
                            hide_at = None;
                            show(&app, Some(VoiceView { phase: "listening".into(), heard: String::new(), answer: String::new() }));
                        }
                    }
                }
                TriggerMsg::StopConversation => {
                    if matches!(mode, Mode::Conversational { .. }) {
                        mode = Mode::Wake;
                        vad.hangover = WAKE_HANGOVER;
                        show(&app, None);
                        let continuous = crate::flow::get(&app).is_some_and(|f| f.store.lock().unwrap().prefs.voice);
                        if !continuous {
                            stop.store(true, Ordering::Relaxed);
                            break;
                        }
                    }
                }
            }
        }
        if stop.load(Ordering::Relaxed) {
            break;
        }

        let chunk = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(c) => Some(c),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let now = Instant::now();
        // The pill's last answer goes away after a while.
        if hide_at.is_some_and(|t| now > t) {
            hide_at = None;
            show(&app, None);
        }
        match &mode {
            Mode::Conversational { until } if now > *until => {
                crate::log::line("voice: conversation ended by silence timeout");
                mode = Mode::Wake;
                vad.hangover = WAKE_HANGOVER;
                show(&app, None);
                let continuous = crate::flow::get(&app).is_some_and(|f| f.store.lock().unwrap().prefs.voice);
                if !continuous {
                    stop.store(true, Ordering::Relaxed);
                    break;
                }
            }
            Mode::Command { until, .. } | Mode::FollowUp { until } if now > *until => {
                mode = Mode::Wake;
                vad.hangover = WAKE_HANGOVER;
                show(&app, None);
            }
            _ => {}
        }
        if pill::dictating(&app) || crate::notes::is_recording(&app) {
            vad.reset();
            continue;
        }
        let Some(chunk) = chunk else { continue };
        for segment in vad.feed(&chunk) {
            if segment.len() < speech::SAMPLE_RATE as usize * 35 / 100 {
                continue;
            }
            let Some(heard) = speech::transcribe(&segment).map(|t| t.text.trim().to_string()) else { continue };
            if heard.is_empty() {
                continue;
            }
            let in_conv = matches!(mode, Mode::Conversational { .. });
            let question = match &mut mode {
                Mode::Conversational { .. } => {
                    hide_at = None;
                    Some(heard)
                }
                Mode::Wake => match wake::after_wake(&heard) {
                    Some(rest) => {
                        crate::log::line("voice: « OK Coucou » heard");
                        hide_at = None;
                        if crate::flow::text::word_count(&rest) >= 2 {
                            Some(rest)
                        } else {
                            show(&app, Some(VoiceView { phase: "listening".into(), heard: rest.clone(), answer: String::new() }));
                            mode = Mode::Command { text: rest, until: now + Duration::from_secs(7) };
                            // A question may come with pauses in it.
                            vad.hangover = CONVERSATIONAL_HANGOVER;
                            None
                        }
                    }
                    None => None,
                },
                Mode::Command { text, .. } => {
                    let full = format!("{text} {heard}").trim().to_string();
                    Some(full)
                }
                Mode::FollowUp { .. } => Some(heard),
            };
            let Some(question) = question else { continue };
            if in_conv {
                mode = Mode::Conversational { until: Instant::now() + Duration::from_secs(60) };
            } else {
                mode = Mode::Wake;
            }
            vad.hangover = WAKE_HANGOVER;
            show(&app, Some(VoiceView { phase: "thinking".into(), heard: question.clone(), answer: String::new() }));
            let reply = brain.respond(&app, &question);
            let answer = reply.as_ref().map(|r| r.text.clone()).unwrap_or_default();
            if answer.is_empty() {
                let done = reply.is_some_and(|r| r.acted);
                show(&app, Some(VoiceView {
                    phase: "speaking".into(),
                    heard: question,
                    answer: if done { "✓".into() } else { "Omi yanıt veremedi: Lütfen bağlantınızı veya Google / Claude hesabınızı kontrol edin.".to_string() },
                }));
                if in_conv {
                    let silence_timeout_secs = crate::flow::get(&app)
                        .map(|f| f.store.lock().unwrap().prefs.voice_silence_timeout)
                        .unwrap_or(8)
                        .max(3);
                    mode = Mode::Conversational { until: Instant::now() + Duration::from_secs(silence_timeout_secs) };
                    vad.hangover = CONVERSATIONAL_HANGOVER;
                    show(&app, Some(VoiceView { phase: "listening".into(), heard: String::new(), answer: String::new() }));
                } else {
                    hide_at = Some(Instant::now() + Duration::from_secs(5));
                }
                continue;
            }
            speak_and_show(&app, &question, &answer);
            vad.reset();
            // Drop what the microphone heard of Coucou's own voice.
            while rx.try_recv().is_ok() {}
            if in_conv {
                let silence_timeout_secs = crate::flow::get(&app)
                    .map(|f| f.store.lock().unwrap().prefs.voice_silence_timeout)
                    .unwrap_or(8)
                    .max(3);
                mode = Mode::Conversational { until: Instant::now() + Duration::from_secs(silence_timeout_secs) };
                vad.hangover = CONVERSATIONAL_HANGOVER;
                show(&app, Some(VoiceView { phase: "listening".into(), heard: String::new(), answer: String::new() }));
            } else {
                // Wake word ("OK Omi") triggered this: single question -> single answer -> close immediately!
                mode = Mode::Wake;
                vad.hangover = WAKE_HANGOVER;
                hide_at = Some(Instant::now() + Duration::from_secs(4));
            }
        }
    }
    capture.stop();
    show(&app, None);
    let mut running = RUNNING.lock().unwrap();
    if let Some(r) = running.as_ref() {
        if Arc::ptr_eq(&r.stop, &stop) {
            *running = None;
        }
    }
}

// ── Speaking ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Say {
    id: u64,
    text: String,
    lang: Option<&'static str>,
    /// ElevenLabs' MP3, base64.
    audio: Option<String>,
    gender: String,
}

/// Prepares speech and reveals text at the exact same instant, so speech starts immediately when text appears.
fn speak_and_show(app: &AppHandle, question: &str, text: &str) {
    let (output, gender) = crate::flow::get(app)
        .map(|f| {
            let p = &f.store.lock().unwrap().prefs;
            (p.voice_output.clone(), p.voice_gender.clone())
        })
        .unwrap_or_else(|| ("system".into(), "female".into()));
    if output == "off" {
        show(app, Some(VoiceView { phase: "speaking".into(), heard: question.to_string(), answer: text.to_string() }));
        std::thread::sleep(Duration::from_millis(1500));
        return;
    }
    let audio = if output == "elevenlabs" {
        elevenlabs(text, &gender).map(|mp3| base64(&mp3))
    } else if output == "piper" {
        piper(app, text)
    } else {
        None
    };

    // Reveal text in the pill and start speech playback at the exact same moment!
    show(app, Some(VoiceView { phase: "speaking".into(), heard: question.to_string(), answer: text.to_string() }));

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending().lock().unwrap().insert(id, tx);
    let _ = app.emit_to(pill::LABEL, "voice-say", Say { id, text: text.into(), lang: wake::speech_lang(text), audio, gender });
    let words = crate::flow::text::word_count(text) as u64;
    let _ = rx.recv_timeout(Duration::from_millis(4000 + words * 600));
    pending().lock().unwrap().remove(&id);
}

/// The pill says it has finished speaking (`id`), or the island answers a question.
#[tauri::command]
pub fn voice_done(id: u64, text: Option<String>) {
    if let Some(tx) = pending().lock().unwrap().remove(&id) {
        let _ = tx.send(text.unwrap_or_default());
    }
}

/// Where the webview has no voice (WebKitGTK often): speech-dispatcher or
/// espeak-ng, when installed.
#[tauri::command]
pub async fn voice_say_native(text: String, lang: Option<String>) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "linux")]
        {
            let lang = lang.unwrap_or_default();
            let short = lang.split('-').next().unwrap_or("").to_string();
            if let Some(spd) = crate::platform::find_on_path("spd-say") {
                let mut cmd = std::process::Command::new(spd);
                cmd.arg("-w");
                if !short.is_empty() {
                    cmd.args(["-l", &short]);
                }
                return cmd.arg(&text).status().is_ok_and(|s| s.success());
            }
            if let Some(espeak) = crate::platform::find_on_path("espeak-ng") {
                let mut cmd = std::process::Command::new(espeak);
                if !short.is_empty() {
                    cmd.args(["-v", &short]);
                }
                return cmd.arg(&text).status().is_ok_and(|s| s.success());
            }
            false
        }
        #[cfg(windows)]
        {
            let _ = (text, lang);
            false
        }
    })
    .await
    .unwrap_or(false)
}

/// ElevenLabs' MP3 for `text`, with the user's key; None and the system voice speaks.
fn elevenlabs(text: &str, gender: &str) -> Option<Vec<u8>> {
    let key = crate::secrets::get("elevenlabs-api-key")?;
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().ok()?;
        let voices: Value = client.get("https://api.elevenlabs.io/v1/voices").header("xi-api-key", &key).send().await.ok()?.json().await.ok()?;
        let voice = pick_voice(voices["voices"].as_array()?, gender)?;
        let response = client
            .post(format!("https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128"))
            .header("xi-api-key", &key)
            .header("accept", "audio/mpeg")
            .json(&json!({ "text": text, "model_id": "eleven_flash_v2_5" }))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            crate::log::line(format!("voice: ElevenLabs {}", response.status()));
            return None;
        }
        Some(response.bytes().await.ok()?.to_vec())
    })
}

fn piper(app: &AppHandle, text: &str) -> Option<String> {
    let mut script_candidates = vec![
        std::env::current_dir().unwrap_or_default().join("scripts").join("piper_tts.py"),
        std::env::current_dir().unwrap_or_default().join("windows").join("scripts").join("piper_tts.py"),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            script_candidates.push(parent.join("scripts").join("piper_tts.py"));
            script_candidates.push(parent.join("..").join("windows").join("scripts").join("piper_tts.py"));
        }
    }

    let script = script_candidates.iter().find(|p| p.exists())?;
    let piper_voice = crate::flow::get(app)
        .map(|f| f.store.lock().unwrap().prefs.piper_voice.clone())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "tr_TR-dfki-medium".to_string());

    let mut cmd = std::process::Command::new("python");
    cmd.arg(script).arg("--model").arg(&piper_voice).arg(text);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let b64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if b64.is_empty() {
        None
    } else {
        Some(b64)
    }
}

/// Terminates any background Piper process to free all CPU and RAM when not in use.
#[tauri::command]
pub fn voice_stop_piper() {
    stop_piper();
}

pub fn stop_piper() {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("powershell");
        cmd.arg("-NoProfile").arg("-Command").arg(
            "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*piper_tts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        );
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let _ = cmd.output();
    }
}
/// First English voice of the gender (a young one first for a man); else any
/// voice of the gender; else the first one. Same choice as the Mac.
pub fn pick_voice(voices: &[Value], gender: &str) -> Option<String> {
    let label = |v: &Value, k: &str| v["labels"][k].as_str().unwrap_or("").to_lowercase();
    let english = |v: &Value| {
        let lang = label(v, "language");
        if !lang.is_empty() {
            return lang.starts_with("en");
        }
        let accent = label(v, "accent");
        accent.is_empty() || ["american", "british", "australian", "irish", "english", "us", "uk"].iter().any(|a| accent.contains(a))
    };
    let of_gender: Vec<&Value> = voices.iter().filter(|v| label(v, "gender") == gender).collect();
    let english_ones: Vec<&&Value> = of_gender.iter().filter(|v| english(v)).collect();
    let young = if gender == "male" { english_ones.iter().find(|v| label(v, "age").contains("young")).copied() } else { None };
    let v = young.or_else(|| english_ones.first().copied()).copied().or_else(|| of_gender.first().copied()).or_else(|| voices.first())?;
    v["voice_id"].as_str().map(String::from)
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

// ── The tools ─────────────────────────────────────────────────────────────────

/// Asks the island (it knows the pills and the services' data) and waits for its answer.
pub fn ask_island(app: &AppHandle, kind: &str, input: Value) -> Option<String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending().lock().unwrap().insert(id, tx);
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "voice-ask", json!({ "id": id, "kind": kind, "input": input }));
    let answer = rx.recv_timeout(Duration::from_secs(5)).ok();
    pending().lock().unwrap().remove(&id);
    answer
}

/// Runs one of Claude's tools: what goes back to Claude, and whether something changed.
pub fn run_tool(app: &AppHandle, name: &str, input: &Value) -> (String, bool) {
    match name {
        "pills" => {
            let answer = ask_island(app, "pills", input.clone()).unwrap_or_else(|| "the island did not answer".into());
            let acted = input["action"].as_str() != Some("list") && !answer.contains("unknown");
            (answer, acted)
        }
        "service_info" => (ask_island(app, "info", json!({})).unwrap_or_else(|| "no data".into()), false),
        "music" => music(app, input),
        "open_app" => open_app(input["name"].as_str().unwrap_or("")),
        "prepare_email" => {
            let to = input["recipient"].as_str().unwrap_or("").trim().to_string();
            if !to.contains('@') {
                return ("No email address: ask the user to spell it.".into(), false);
            }
            let enc = |s: &str| -> String {
                s.bytes()
                    .map(|b| match b {
                        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                        _ => format!("%{b:02X}"),
                    })
                    .collect()
            };
            let url = format!(
                "mailto:{}?subject={}&body={}",
                enc(&to).replace("%40", "@"),
                enc(input["subject"].as_str().unwrap_or("")),
                enc(input["body"].as_str().unwrap_or(""))
            );
            crate::platform::open_url(&url);
            (format!("The mail app opened with the email to {to}. Nothing is sent until the user sends it."), true)
        }
        "open_url" | "browse" => {
            let url = input["url"].as_str().or_else(|| input["query"].as_str()).unwrap_or("").trim();
            if !url.is_empty() {
                crate::platform::open_url(url);
                (format!("Opened {url} in browser"), true)
            } else {
                ("Missing url".into(), false)
            }
        }
        "youtube" => {
            let url = input["url"].as_str().unwrap_or("").trim();
            if !url.is_empty() {
                crate::platform::open_url(url);
                (format!("Opened YouTube video: {url}"), true)
            } else {
                let q = input["query"].as_str().unwrap_or("").trim();
                let encoded: String = q.chars().map(|c| if c.is_alphanumeric() { c.to_string() } else { "+".into() }).collect();
                let search_url = format!("https://www.youtube.com/results?search_query={encoded}");
                crate::platform::open_url(&search_url);
                (format!("Opened YouTube search for {q}"), true)
            }
        }
        "shell" => {
            let cmd = input["command"].as_str().unwrap_or("").trim();
            if !cmd.is_empty() {
                match crate::antigravity::execute_shell(cmd) {
                    Ok(out) => (format!("Executed command: {out}"), true),
                    Err(e) => (format!("Command error: {e}"), false),
                }
            } else {
                ("Missing command".into(), false)
            }
        }
        "learn_rule" => {
            let topic = input["topic"].as_str().unwrap_or("genel");
            let rule = input["rule"].as_str().unwrap_or("");
            if !rule.is_empty() {
                match crate::learnings::add_rule(topic, rule) {
                    Ok(_) => (format!("Kural öğrenildi ve kaydedildi: [{topic}] -> {rule}"), true),
                    Err(e) => (format!("Kural kaydedilemedi: {e}"), false),
                }
            } else {
                ("Kural içeriği boş olamaz".into(), false)
            }
        }
        _ => (format!("unknown tool {name}"), false),
    }
}

/// Parses and executes actions embedded in model output (e.g. action:open_url, action:youtube, action:shell)
pub fn execute_voice_actions(text: &str) -> (String, bool) {
    let mut cleaned = String::new();
    let mut in_action = false;
    let mut action_type = String::new();
    let mut action_body = String::new();
    let mut acted = false;

    for line in text.lines() {
        if line.starts_with("```action:") {
            in_action = true;
            action_type = line.strip_prefix("```action:").unwrap_or("").trim().to_string();
            action_body.clear();
        } else if in_action {
            if line.starts_with("```") {
                in_action = false;
                match action_type.as_str() {
                    "open_url" | "browse" => {
                        let url = action_body.trim();
                        if !url.is_empty() {
                            crate::platform::open_url(url);
                            acted = true;
                        }
                    }
                    "youtube" => {
                        let q = action_body.trim();
                        if q.starts_with("http://") || q.starts_with("https://") {
                            crate::platform::open_url(q);
                        } else {
                            let encoded: String = q.chars().map(|c| if c.is_alphanumeric() { c.to_string() } else { "+".into() }).collect();
                            crate::platform::open_url(&format!("https://www.youtube.com/results?search_query={encoded}"));
                        }
                        acted = true;
                    }
                    "open_app" => {
                        let name = action_body.trim();
                        if !name.is_empty() {
                            let (_, did) = open_app(name);
                            acted |= did;
                        }
                    }
                    "shell" => {
                        let cmd = action_body.trim();
                        if !cmd.is_empty() {
                            let _ = crate::antigravity::execute_shell(cmd);
                            acted = true;
                        }
                    }
                    "learn_rule" => {
                        let body = action_body.trim();
                        if let Some((topic, rule)) = body.split_once('|') {
                            let _ = crate::learnings::add_rule(topic.trim(), rule.trim());
                            acted = true;
                        }
                    }
                    _ => {}
                }
            } else {
                action_body.push_str(line);
                action_body.push('\n');
            }
        } else {
            cleaned.push_str(line);
            cleaned.push('\n');
        }
    }

    (cleaned.trim().to_string(), acted)
}

fn music(app: &AppHandle, input: &Value) -> (String, bool) {
    let action = input["action"].as_str().unwrap_or("");
    let (control, value) = match action {
        "play_pause" => ("playPause", None),
        "next" => ("next", None),
        "previous" => ("previous", None),
        "set_volume" => ("volume", Some(input["volume"].as_f64().unwrap_or(50.0).clamp(0.0, 100.0))),
        "search" => {
            let q = input["query"].as_str().unwrap_or("").trim();
            if q.is_empty() {
                return ("missing query".into(), false);
            }
            let encoded: String = q.chars().map(|c| if c.is_alphanumeric() { c.to_string() } else { "%20".into() }).collect();
            crate::platform::open_url(&format!("spotify:search:{encoded}"));
            return (format!("Spotify opened on a search for {q}: the user picks what to play."), true);
        }
        _ => return ("unknown action".into(), false),
    };
    let app2 = app.clone();
    let done = tauri::async_runtime::block_on(crate::spotify::spotify_control(app2, control.into(), value));
    if done {
        ("done".into(), true)
    } else {
        ("Spotify is not running or not playing: tell the user to open it.".into(), false)
    }
}

/// Opens an app whose name matches: a Start menu shortcut on Windows, a
/// .desktop entry on Linux. Nothing else is ever run.
fn open_app(name: &str) -> (String, bool) {
    let wanted = wake::normalize(name);
    if wanted.is_empty() {
        return ("no name".into(), false);
    }
    if wanted.contains("antigravity") {
        if crate::platform::open_antigravity(None) {
            return ("Antigravity açıldı".into(), true);
        }
    }
    match find_app(&wanted) {
        Some((label, launch)) => {
            launch();
            (format!("{label} opened"), true)
        }
        None => (format!("No app named {name} on this computer."), false),
    }
}

#[cfg(windows)]
fn find_app(wanted: &str) -> Option<(String, Box<dyn FnOnce()>)> {
    let mut roots = Vec::new();
    // 1. User Desktop & Public Desktop
    if let Some(p) = std::env::var_os("USERPROFILE") {
        roots.push(std::path::PathBuf::from(p).join("Desktop"));
    }
    roots.push(std::path::PathBuf::from("C:\\Users\\Public\\Desktop"));

    // 2. Start Menu Programs
    if let Some(p) = std::env::var_os("APPDATA") {
        roots.push(std::path::PathBuf::from(p).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Some(p) = std::env::var_os("ProgramData") {
        roots.push(std::path::PathBuf::from(p).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }

    // 3. User Local Programs
    if let Some(p) = std::env::var_os("LOCALAPPDATA") {
        roots.push(std::path::PathBuf::from(p).join("Programs"));
    }

    let wanted_tokens: Vec<&str> = wanted.split_whitespace().collect();
    let mentions_minecraft = wanted_tokens.iter().any(|t| t.contains("minecraft") || t.contains("mc"));

    let mut best: Option<(usize, std::path::PathBuf)> = None;
    let mut stack = roots;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Some(ext) = path.extension().and_then(|x| x.to_str()) else { continue };
            let ext_lower = ext.to_ascii_lowercase();
            if !matches!(ext_lower.as_str(), "lnk" | "url" | "exe") {
                continue;
            }

            let stem = wake::normalize(&path.file_stem().unwrap_or_default().to_string_lossy());
            if stem.is_empty() {
                continue;
            }

            // Scoring:
            // 0: exact match
            // 1: prefix match
            // 2: substring match
            // 3: token match (e.g. "modrinth minecraft" matches "modrinth app")
            // 4: minecraft alias match (e.g. "minecraft" matches "modrinth app" or "blokoyun")
            let score = if stem == wanted {
                0
            } else if stem.starts_with(wanted) || wanted.starts_with(&stem) {
                1
            } else if stem.contains(wanted) || wanted.contains(&stem) {
                2
            } else if wanted_tokens.iter().any(|t| t.len() >= 3 && (stem.contains(t) || stem.split_whitespace().any(|st| st == *t))) {
                3
            } else if mentions_minecraft && (stem.contains("modrinth") || stem.contains("blokoyun")) {
                4
            } else {
                continue;
            };

            if best.as_ref().is_none_or(|(s, p)| score < *s || (score == *s && path.as_os_str().len() < p.as_os_str().len())) {
                best = Some((score, path));
            }
        }
    }

    let (_, path) = best?;
    let label = path.file_stem()?.to_string_lossy().to_string();
    Some((label, Box::new(move || {
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
            let mut cmd = std::process::Command::new(&path);
            if let Some(parent) = path.parent() {
                cmd.current_dir(parent);
            }
            let _ = cmd.spawn();
        } else if let Some(p_str) = path.to_str() {
            crate::platform::open_url(p_str);
        } else {
            let _ = std::process::Command::new(&path).spawn();
        }
    })))
}

#[cfg(target_os = "linux")]
fn find_app(wanted: &str) -> Option<(String, Box<dyn FnOnce()>)> {
    let mut dirs = vec![std::path::PathBuf::from("/usr/share/applications"), std::path::PathBuf::from("/var/lib/flatpak/exports/share/applications")];
    dirs.push(crate::platform::home_dir().join(".local/share/applications"));
    dirs.push(crate::platform::home_dir().join(".local/share/flatpak/exports/share/applications"));
    let mut best: Option<(usize, String, String)> = None;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().is_none_or(|x| x != "desktop") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            if text.lines().any(|l| l.trim() == "NoDisplay=true") {
                continue;
            }
            let Some(app_name) = text.lines().find_map(|l| l.strip_prefix("Name=")).map(str::trim) else { continue };
            let n = wake::normalize(app_name);
            let score = if n == wanted { 0 } else if n.starts_with(wanted) { 1 } else if n.contains(wanted) { 2 } else { continue };
            let id = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
            if best.as_ref().is_none_or(|(s, _, _)| score < *s) {
                best = Some((score, app_name.to_string(), id));
            }
        }
    }
    let (_, label, id) = best?;
    Some((label, Box::new(move || {
        let _ = std::process::Command::new("gtk-launch").arg(&id).spawn();
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b""), "");
    }

    #[test]
    fn the_voice_is_picked_like_on_the_mac() {
        let voices: Vec<Value> = serde_json::from_str(r#"[
            {"voice_id":"a","labels":{"gender":"male","accent":"american","age":"middle aged"}},
            {"voice_id":"b","labels":{"gender":"male","accent":"british","age":"young"}},
            {"voice_id":"c","labels":{"gender":"female","accent":"american"}},
            {"voice_id":"d","labels":{"gender":"female","language":"fr"}}
        ]"#).unwrap();
        assert_eq!(pick_voice(&voices, "male").as_deref(), Some("b"));
        assert_eq!(pick_voice(&voices, "female").as_deref(), Some("c"));
        assert_eq!(pick_voice(&[], "female"), None);
    }
}

/// With the models downloaded: `COUCOU_TEST_WAKE_WAV=… cargo test -- --ignored wake_in`.
#[cfg(test)]
mod with_models {
    #[test]
    #[ignore]
    fn hears_the_wake_phrase_in_a_recording() {
        let path = std::env::var("COUCOU_TEST_WAKE_WAV").expect("COUCOU_TEST_WAKE_WAV");
        let bytes = std::fs::read(&path).unwrap();
        let rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
        let pcm: Vec<f32> = bytes[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
        let mut r = crate::speech::audio::Resampler::new(rate);
        let mut samples = Vec::new();
        r.process(&pcm, &mut samples);
        let mut vad = super::wake::Vad::default();
        let mut heard = Vec::new();
        for chunk in samples.chunks(1600) {
            for segment in vad.feed(chunk) {
                let text = crate::speech::transcribe(&segment).expect("models").text;
                println!("segment {:.2} s: {text}", segment.len() as f32 / 16_000.0);
                heard.push(super::wake::after_wake(&text));
            }
        }
        println!("{heard:?}");
        assert!(heard.iter().any(|h| h.as_deref().is_some_and(|q| !q.is_empty())));
    }
}
