// Persistent learning and user procedures / preferences for Omi.
// Stored in %APPDATA%\Coucou\learned_rules.json (or Linux ~/.config/coucou).
// Injected into system prompts for both voice assistant and chat so Omi remembers
// user-confirmed methods and avoids trial-and-error / token waste.

use std::path::PathBuf;
use parking_lot::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedRule {
    pub id: String,
    pub topic: String,
    pub rule: String,
    pub created_at: i64,
    #[serde(default)]
    pub usage_count: u32,
}

static FILE_LOCK: Mutex<()> = Mutex::new(());

fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn file_path() -> PathBuf {
    crate::platform::config_dir().join("learned_rules.json")
}

/// Reads all saved learning rules from disk.
pub fn list_rules() -> Vec<LearnedRule> {
    let _guard = FILE_LOCK.lock();
    let path = file_path();
    if !path.exists() {
        return Vec::new();
    }
    let Ok(data) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&data).unwrap_or_default()
}

/// Saves rules list to disk safely.
pub fn save_rules(rules: &[LearnedRule]) -> Result<(), String> {
    let _guard = FILE_LOCK.lock();
    let path = file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let data = serde_json::to_string_pretty(rules)
        .map_err(|e| format!("Serialization error: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Write error: {e}"))
}

/// Adds or updates a learning rule.
pub fn add_rule(topic: &str, rule: &str) -> Result<LearnedRule, String> {
    let topic_clean = topic.trim();
    let rule_clean = rule.trim();
    if topic_clean.is_empty() || rule_clean.is_empty() {
        return Err("Konu ve kural boş olamaz.".into());
    }

    let mut rules = list_rules();
    // Check if a rule for this topic already exists (case-insensitive)
    let existing_idx = rules.iter().position(|r| {
        r.topic.eq_ignore_ascii_case(topic_clean)
            || r.topic.to_lowercase().contains(&topic_clean.to_lowercase())
            || topic_clean.to_lowercase().contains(&r.topic.to_lowercase())
    });

    let saved_rule = if let Some(idx) = existing_idx {
        rules[idx].rule = rule_clean.to_string();
        rules[idx].usage_count += 1;
        rules[idx].created_at = now_epoch_secs();
        rules[idx].clone()
    } else {
        let new_id = format!("rule_{}_{}", now_epoch_secs(), rules.len() + 1);
        let item = LearnedRule {
            id: new_id,
            topic: topic_clean.to_string(),
            rule: rule_clean.to_string(),
            created_at: now_epoch_secs(),
            usage_count: 1,
        };
        rules.push(item.clone());
        item
    };

    save_rules(&rules)?;
    Ok(saved_rule)
}

/// Deletes a rule by ID.
pub fn remove_rule(id: &str) -> Result<bool, String> {
    let mut rules = list_rules();
    let before_len = rules.len();
    rules.retain(|r| r.id != id);
    if rules.len() < before_len {
        save_rules(&rules)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Formats the learned rules into a prompt section for the LLM.
/// Injected into system prompt for both voice assistant and chat.
pub fn prompt_context() -> String {
    let rules = list_rules();
    let mut out = String::new();

    if !rules.is_empty() {
        out.push_str("\n\n🧠 ÖĞRENİLMİŞ KULLANICI KURALLARI VE YÖNTEMLERİ (KESİNLİKLE VE ÖNCELİKLE UYGULA):\n");
        out.push_str("Kullanıcı daha önce belirli işlemler için aşağıdaki yöntemleri onaylamış veya 'bundan sonra böyle yap' demiştir.\n");
        out.push_str("Bu işlemleri gerçekleştirirken birden fazla farklı yöntem denemek, alternatif aramak veya varsayımda bulunmak YERİNE DOĞRUDAN bu öğrenilmiş yöntemleri uygula (bu sayede gereksiz denemeler yapmadan, daha az token harcayarak en verimli ve hızlı şekilde tamamla):\n");
        for r in &rules {
            out.push_str(&format!("- [{}]: {}\n", r.topic.trim(), r.rule.trim()));
        }
    }

    out.push_str("\n\n🎯 ÖĞRENİM VE METOD KURALI:\n");
    out.push_str("Kullanıcı 'bundan sonra böyle yap', 'bunu şu yöntemle yap', 'bu yöntem doğru', 'bu şekilde yapmanı istiyorum', 'artık şöyle yap' dediğinde veya bir işlemin nasıl yapılması gerektiğini öğrettiğinde:\n");
    out.push_str("1. Sesli asistandaysan: Hemen `learn_rule(topic, rule)` aracını çağırarak bu kuralı kalıcı olarak kaydet.\n");
    out.push_str("2. Normal chatteysen: Yanıtında `[LEARNED_RULE: konu | kural]` etiketini kullanarak yöntemi sisteme kaydettir. Kullanıcıya bu yöntemi öğrendiğini ve bundan sonra hep bu yöntemle çalışacağını bildir.\n");

    out
}

/// Parses and extracts any `[LEARNED_RULE: topic | rule]` tags from chat responses,
/// saves the rule to disk, and removes the tag from the output text.
pub fn extract_and_apply_chat_learnings(text: &str) -> (String, Vec<LearnedRule>) {
    let mut cleaned = String::with_capacity(text.len());
    let mut learned = Vec::new();

    let mut remaining = text;
    while let Some(start_idx) = remaining.find("[LEARNED_RULE:") {
        cleaned.push_str(&remaining[..start_idx]);
        let after_start = &remaining[start_idx + "[LEARNED_RULE:".len()..];
        if let Some(end_idx) = after_start.find(']') {
            let content = after_start[..end_idx].trim();
            if let Some((topic, rule)) = content.split_once('|') {
                if let Ok(item) = add_rule(topic.trim(), rule.trim()) {
                    learned.push(item);
                }
            }
            remaining = &after_start[end_idx + 1..];
        } else {
            cleaned.push_str(&remaining[start_idx..]);
            remaining = "";
            break;
        }
    }
    cleaned.push_str(remaining);

    (cleaned.trim().to_string(), learned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_chat_learning_tags_correctly() {
        let input = "Harika, anladım!\n[LEARNED_RULE: antigravity açma | Antigravity istendiğinde web sitesi yerine masaüstü uygulamasını çalıştır]\nBundan sonra hep bu yöntemle açacağım.";
        let (cleaned, rules) = extract_and_apply_chat_learnings(input);
        assert!(!cleaned.contains("[LEARNED_RULE:"));
        assert!(cleaned.contains("Harika, anladım!"));
        assert!(cleaned.contains("Bundan sonra hep bu yöntemle açacağım."));
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].topic, "antigravity açma");
        assert_eq!(rules[0].rule, "Antigravity istendiğinde web sitesi yerine masaüstü uygulamasını çalıştır");
    }
}
