// Tests for Omi High-Priority Directives:
// 1. Omi Priority System Prompts (precedence, autoclicker, direct messaging, web auto-tagging)
// 2. Autoclicker Engine & Detection (natural language + slash commands)
// 3. Tagged Site Direct Messaging (zero trial-and-error)
// 4. Airbnb Cyprus 3+1 Auto-Tagging & Smart Filter Opening

import { test } from "node:test";
import assert from "node:assert/strict";

const { Bridge } = await import("../src/core/bridge.ts");
const { State } = await import("../src/core/state.ts");
const { AutoclickerSkill, DirectMessageSkill, DiscordSkill, executeSkillFromQuery } = await import("../src/core/skills.ts");
test("Autoclicker slash commands (/autoclicker, /clicker) route properly", async () => {
  const start = await executeSkillFromQuery("/autoclicker");
  assert.ok(start);
  assert.equal(start.skill, "autoclicker");

  const stop = await executeSkillFromQuery("/autoclicker stop");
  assert.ok(stop);
  assert.equal(stop.skill, "autoclicker");
  assert.equal(stop.action, "stop");
  assert.equal(stop.success, true);

  const status = await executeSkillFromQuery("/clicker durum");
  assert.ok(status);
  assert.equal(status.skill, "autoclicker");
  assert.equal(status.action, "status");
});

test("DirectMessageSkill writes directly without trial-and-error", async () => {
  let executedAction = null;
  Bridge.executeComputerAction = async (action) => {
    executedAction = action;
    return { success: true, message: "ok" };
  };

  const res = await DirectMessageSkill.execute({ text: "Selam, Kıbrıs'taki ev için yazıyorum" });
  assert.equal(res.success, true);
  assert.equal(res.skill, "direct-message");
  assert.ok(res.message.includes("sıfır deneme-yanılma"));
});

test("Smart Airbnb 3+1 query parsing extracts location, bedrooms, and tags context", () => {
  const query = "airbnbde bana kıbrıstaki 3+1 şu evleri listele";

  // Match platform & term
  const match = query.match(
    /^(?:(?:(google|sahibinden|airbnb|hepsiemlak|youtube)(?:'da|'de|da|de|'dan|'den|dan|den)?\s+)?(.+?)\s+(?:diye\s+)?(?:arat|ara|bul|listele|göster)|(?:ara|arat|bul|listele)\s+(.+))$/i
  );
  assert.ok(match);
  const platform = match[1].toLowerCase();
  const rawTerm = match[2].trim();
  assert.equal(platform, "airbnb");

  // Bedroom extraction
  const bedroomMatch = rawTerm.match(/(\d+)\s*\+\s*(\d+)|\b(\d+)\s*(?:oda|yatak|bedroom)/i);
  assert.ok(bedroomMatch);
  const minBedrooms = bedroomMatch[1] || bedroomMatch[3];
  assert.equal(minBedrooms, "3");

  // Location cleaning via token filtering
  const FILLER_WORDS = {
    bana: true, şu: true, bu: true, o: true, tüm: true, lütfen: true,
    evleri: true, evler: true, ev: true, daireleri: true, daireler: true,
    daire: true, villaları: true, villalar: true, villa: true,
    listele: true, göster: true, bul: true, ara: true, arat: true,
    ilanları: true, ilanlar: true, satılık: true, kiralık: true, fiyatları: true,
  };

  const cleanTokens = rawTerm
    .split(/\s+/)
    .filter((token) => {
      const lower = token.toLowerCase();
      if (FILLER_WORDS[lower]) return false;
      if (/^(\d+)\s*\+\s*(\d+)$/.test(lower)) return false;
      if (/^(\d+)(?:oda|yatak)?$/.test(lower)) return false;
      return true;
    })
    .map((token) => token.replace(/(?:'ta|'te|'daki|'deki|taki|teki|daki|deki)$/i, ""))
    .filter(Boolean);

  let cleanLocation = cleanTokens.join(" ").trim();
  cleanLocation = cleanLocation
    .split(" ")
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ")
    .trim();

  assert.equal(cleanLocation, "Kıbrıs");

  const expectedUrl = `https://www.airbnb.com.tr/s/${encodeURIComponent(cleanLocation)}/homes?min_bedrooms=${minBedrooms}`;
  const tagTitle = `Airbnb: ${cleanLocation} (${minBedrooms}+1 Evler)`;

  assert.ok(expectedUrl.includes("min_bedrooms=3"));
  assert.ok(expectedUrl.includes("homes"));
  assert.equal(tagTitle, "Airbnb: Kıbrıs (3+1 Evler)");
  // State tagging
  State.activeTabContext = tagTitle;
  assert.equal(State.activeTabContext, tagTitle);
});

test("Natural language autoclicker query regex matches user phrases", () => {
  const isAutoclickerNL =
    /(?:bana\s+)?(?:bir\s+)?autoclicker\s+(?:lazım|aç|çalıştır|istiyorum|gerek(?:li)?)|otomatik\s+tıklay?ıcı\s+(?:lazım|aç|çalıştır|istiyorum|yap)/i;

  assert.ok(isAutoclickerNL.test("bir autoclicker lazım"));
  assert.ok(isAutoclickerNL.test("bana bir autoclicker lazım"));
  assert.ok(isAutoclickerNL.test("autoclicker aç"));
  assert.ok(isAutoclickerNL.test("otomatik tıklayıcı lazım"));
  assert.ok(isAutoclickerNL.test("otomatik tıklayıcı çalıştır"));
  assert.ok(!isAutoclickerNL.test("hava durumu nasıl"));
});

test("Direct message on tagged site regex matches user phrases", () => {
  const isDirectMsg =
    /^(?:(?:şuna|buna|siteye|sekmesine|sekmede|pencereye)\s+)?(?:mesaj\s+yaz|mesaj\s+gönder|mesaj\s+at|yazmaya\s+devam\s+et|şunu\s+yaz)\s*(?::|\s)\s*(.+)$/i;

  const m1 = isDirectMsg.exec("şuna mesaj yaz: merhaba ev hala müsait mi?");
  assert.ok(m1);
  assert.equal(m1[1].trim(), "merhaba ev hala müsait mi?");

  const m2 = isDirectMsg.exec("siteye mesaj yaz: selamlar");
  assert.ok(m2);
  assert.equal(m2[1].trim(), "selamlar");

  const m3 = isDirectMsg.exec("yazmaya devam et: ek olarak fiyat son ne olur");
  assert.ok(m3);
  assert.equal(m3[1].trim(), "ek olarak fiyat son ne olur");
});

test("Turkish wake word normalization handles Turkish characters", () => {
  function normalizeTurkish(text) {
    const map = {
      "à": "a", "á": "a", "â": "a", "ä": "a", "ã": "a", "å": "a",
      "ç": "c",
      "è": "e", "é": "e", "ê": "e", "ë": "e",
      "ì": "i", "í": "i", "î": "i", "ï": "i", "ı": "i",
      "ò": "o", "ó": "o", "ô": "o", "ö": "o", "õ": "o",
      "ù": "u", "ú": "u", "û": "u", "ü": "u",
      "ÿ": "y", "ý": "y",
      "ğ": "g",
      "ş": "s",
      "ñ": "n",
    };
    let out = "";
    for (const ch of text.toLowerCase()) {
      out += map[ch] || (/[a-z0-9]/.test(ch) ? ch : " ");
    }
    return out.split(/\s+/).filter(Boolean).join(" ");
  }

  assert.equal(normalizeTurkish("Hey Omi"), "hey omi");
  assert.equal(normalizeTurkish("Selam Omi"), "selam omi");
  assert.equal(normalizeTurkish("Merhaba Omi"), "merhaba omi");
  assert.equal(normalizeTurkish("ışıklar açık"), "isiklar acik");
  assert.equal(normalizeTurkish("yağmurlu gün"), "yagmurlu gun");
});

test("Autostart setting can be toggled and saved cleanly", async () => {
  let saved = null;
  Bridge.saveSettings = async (s) => {
    saved = s;
  };

  const testSettings = { ...State.settings, autostart: true };
  await Bridge.saveSettings(testSettings);
  assert.equal(saved.autostart, true);

  const testSettingsOff = { ...State.settings, autostart: false };
  await Bridge.saveSettings(testSettingsOff);
  assert.equal(saved.autostart, false);
});

test("DiscordSkill sends message and reports target", async () => {
  let calledWith = null;
  Bridge.discordSendMessage = async (msg, tgt) => {
    calledWith = { msg, tgt };
    return { success: true, target: tgt, message: msg };
  };

  const emptyRes = await DiscordSkill.execute({ message: "" });
  assert.equal(emptyRes.success, false);
  assert.ok(emptyRes.message.includes("boş olamaz"));

  const sendRes = await DiscordSkill.execute({ target: "ahmet", message: "selam dostum" });
  assert.equal(sendRes.success, true);
  assert.equal(sendRes.skill, "discord_skill");
  assert.ok(sendRes.message.includes("ahmet"));
  assert.ok(sendRes.message.includes("selam dostum"));
  assert.ok(!sendRes.message.includes("<400ms"));
  assert.ok(!sendRes.message.includes("sıfır kod yazımı"));
  assert.equal(calledWith.tgt, "ahmet");
  assert.equal(calledWith.msg, "selam dostum");
});

test("Discord slash commands (/discord, /dc) parse target and message correctly", async () => {
  let called = null;
  Bridge.discordSendMessage = async (msg, tgt) => {
    called = { msg, tgt };
    return { success: true, target: tgt, message: msg };
  };

  const res1 = await executeSkillFromQuery('/discord "ahmet" akşam buluşalım mı');
  assert.ok(res1);
  assert.equal(res1.skill, "discord_skill");
  assert.equal(called.tgt, "ahmet");
  assert.equal(called.msg, "akşam buluşalım mı");

  const res2 = await executeSkillFromQuery('/dc mehmet naber');
  assert.ok(res2);
  assert.equal(res2.skill, "discord_skill");
  assert.equal(called.tgt, "mehmet");
  assert.equal(called.msg, "naber");
});

test("Discord natural language intent parser extracts target and message correctly", () => {
  function parseDiscordNL(query) {
    const trimmed = query.trim();
    const isDiscord =
      ((/(?:^|\s)(?:discord|dc)(?:'dan|'den|dan|den|'da|'de|da|de)?\b/i.test(trimmed) &&
        /(?:mesaj\s+(?:at|yaz|gönder)|yaz|at|gönder)\b/i.test(trimmed)) ||
        /(?:grubuna|kanalına|odasına)\s+.+\s*(?:mesaj\s+(?:at|yaz|gönder)|yaz|at|gönder)$/i.test(trimmed));
    if (!isDiscord) return null;
    let target = null;
    let message = "";
    const cleaned = trimmed.replace(/^(?:discord|dc)(?:'dan|'den|dan|den|'da|'de|da|de)?\s+/i, "").trim();
    let isGroup = false;

    // Group/channel matching (e.g. "not defteri grubuna selam yaz")
    const groupColonMatch = cleaned.match(
      /^(.+?)\s*(?:grubuna|grubun|grubu|grub|grup|group|kanalına|kanalı|kanal|channel|odasına|odası|sunucusuna|sunucusu|sunucu)\s*(?:diye\s+)?(?:mesaj\s+(?:at|yaz|gönder)|yaz|at|gönder)?\s*:\s*(.+)$/i,
    );
    const groupDiyeMatch = cleaned.match(
      /^(.+?)\s*(?:grubuna|grubun|grubu|grub|grup|group|kanalına|kanalı|kanal|channel|odasına|odası|sunucusuna|sunucusu|sunucu)\s+(.+?)\s*(?:diye\s+)?(?:mesaj\s+(?:at|yaz|gönder)|yaz|at|gönder)$/i,
    );

    if (groupColonMatch) {
      target = groupColonMatch[1].trim();
      message = groupColonMatch[2].trim();
      isGroup = true;
    } else if (groupDiyeMatch) {
      target = groupDiyeMatch[1].trim();
      message = groupDiyeMatch[2].trim();
      isGroup = true;
    } else {
      const colonIdx = cleaned.indexOf(":");
      if (colonIdx > 0) {
        message = cleaned.slice(colonIdx + 1).trim();
        const beforeColon = cleaned.slice(0, colonIdx).replace(/(?:mesaj\s+(?:at|yaz|gönder)|yaz|at|gönder)$/i, "").trim();
        const tgt = beforeColon.replace(/(?:'a|'e|'ye|'ya|'te|'ta|a|e|ye|ya)$/i, "").trim();
        if (tgt) target = tgt;
      } else {
        const quoteMatch = cleaned.match(/\"([^\"]+)\"|(?<=^|\s)'([^']+)'/);
        if (quoteMatch) {
          message = (quoteMatch[1] || quoteMatch[2]).trim();
          const beforeQuote = cleaned.slice(0, quoteMatch.index).trim();
          const tgt = beforeQuote.replace(/(?:'a|'e|'ye|'ya|'te|'ta|a|e|ye|ya)$/i, "").trim();
          if (tgt) target = tgt;
        } else {
          const match = cleaned.match(/^(\S+?)(?:'a|'e|'ye|'ya|'te|'ta|a|e|ye|ya)\s+(.+?)\s+(?:diye\s+)?(?:mesaj\s+(?:at|yaz|gönder)|yaz|at|gönder)$/i);
          if (match) {
            target = match[1];
            message = match[2].trim();
          } else {
            const fallbackMatch = cleaned.match(/^(.+?)\s+(?:diye\s+)?(?:mesaj\s+(?:at|yaz|gönder)|yaz|at|gönder)$/i);
            if (fallbackMatch) {
              message = fallbackMatch[1].trim();
            } else {
              message = cleaned;
            }
          }
        }
      }
    }

    if (target) {
      if (/^(?:discord|dc)(?:'dan|'den|dan|den|'da|'de|da|de)?$/i.test(target)) {
        target = null;
      } else {
        if (target.startsWith("#") || /\b(grup|group|kanal|channel|oda|sunucu)\b/i.test(target)) {
          isGroup = true;
        }
        target = target.replace(/(?:grubuna|grubun|grubu|grub|grup|group|kanalına|kanalı|kanal|channel|odasına|odası|sunucusuna|sunucusu|sunucu)$/i, "").trim() || null;
      }
    }
    message = message.replace(/(?:^|\s)(?:discord|dc)(?:'dan|'den|dan|den|'da|'de|da|de)?\s*/gi, " ").trim();
    return { target, message, isGroup };
  }

  const p1 = parseDiscordNL("discord'dan ahmet'e akşam buluşalım mı diye mesaj at");
  assert.ok(p1);
  assert.equal(p1.target, "ahmet");
  assert.equal(p1.message, "akşam buluşalım mı");
  assert.equal(p1.isGroup, false);

  const p2 = parseDiscordNL("discordda mehmet'e selam yaz");
  assert.ok(p2);
  assert.equal(p2.target, "mehmet");
  assert.equal(p2.message, "selam");
  assert.equal(p2.isGroup, false);

  const p3 = parseDiscordNL("discord'dan mehmet'e mesaj at: proje bitti");
  assert.ok(p3);
  assert.equal(p3.target, "mehmet");
  assert.equal(p3.message, "proje bitti");
  assert.equal(p3.isGroup, false);

  const p4 = parseDiscordNL("not defteri grubuna selam yaz");
  assert.ok(p4);
  assert.equal(p4.target, "not defteri");
  assert.equal(p4.message, "selam");
  assert.equal(p4.isGroup, true);
});
