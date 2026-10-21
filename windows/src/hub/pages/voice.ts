// « OK Coucou »: say it, then ask anything. Turning it on, how Coucou answers
// out loud, and what leaves the computer. Port of the Mac's Settings → Voice.

import { h, clear } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { Bridge } from "../../core/bridge";
import { SHORTCUTS, effective, displayKeys, recordPress } from "../../core/shortcuts";
import type { FlowPrefs, VoiceOutput } from "../../core/flow";
import type { HubContext } from "../shell";
import { button, card, divider, label, row, segmented, toggle } from "../ui";
import { modelsControl } from "./flowsettings";

const ELEVEN = "elevenlabs-api-key";
/** Where secrets.rs keeps the keys on this OS (same words as Notch → Chat). */
const KEY_STORE = navigator.userAgent.includes("Windows") ? "Windows Credential Manager" : "Secret Service (GNOME Keyring, KWallet)";

function elevenKey(): HTMLElement {
  const box = h("div", { style: "display:flex;align-items:center;gap:8px" });
  const draw = async () => {
    const present = (await Bridge.secretPresent(ELEVEN)) ?? false;
    clear(box);
    if (present) {
      box.append(
        h("span", { class: "hub-note", style: "color:var(--hub-green)", text: `✓ ${t("Key saved in the {store}.", { store: KEY_STORE })}` }),
        button(t("Remove"), () => void Bridge.secretClear(ELEVEN).then(draw), "", true),
      );
      return;
    }
    const input = h("input", { class: "hub-input", type: "password", placeholder: t("ElevenLabs key"), autocomplete: "off", spellcheck: "false", style: "width:220px" }) as HTMLInputElement;
    const save = button(t("Save key"), () => {
      const value = input.value.trim();
      if (!value) return;
      void Bridge.secretSet(ELEVEN, value).then(draw, () => input.classList.add("err"));
    }, "primary", true);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save.click();
    });
    box.append(input, save);
  };
  void draw();
  return box;
}

export async function voicePage(page: HTMLElement, ctx: HubContext) {
  const status = await ctx.refresh();
  const prefs = status.prefs;
  page.append(ctx.hero("voice", "OK Omi", t("Say « OK Omi », then ask anything: add a pill, play music, the weather, an email to prepare.")));

  const ready = status.models.parakeet.state === "ready";
  page.append(label(t("Listening")));
  const main = card(
    row(t("Listen for « OK Omi »"), t("The microphone stays open; only what follows « OK Omi » goes further."),
      toggle(prefs.voice, (on) => void ctx.setPrefs((p: FlowPrefs) => { p.voice = on; }).then(() => ctx.navigate("voice")))),
    divider(),
    row(t("Parakeet, on your computer"), t("Hears « OK Omi » here, without the internet."), modelsControl(ctx, () => ctx.navigate("voice"))),
  );
  if (prefs.voice && !status.hasClaudeKey) {
    main.append(h("div", { class: "hub-warn", text: t("Omi answers with Google Antigravity or Claude: log in with Google or add your key in Notch → Chat.") }));
  } else if (prefs.voice && !ready) {
    main.append(h("div", { class: "hub-warn", text: t("Download the voice model so Omi can hear you.") }));
  }
  page.append(main);

  page.append(label(t("Karşılıklı Sesli Sohbet & Kısayol")));
  const boot = await Bridge.boot();
  const appSettings = boot?.settings;
  const shortcutDef = SHORTCUTS.find((s) => s.id === "talkToOmi")!;
  let binding = effective(shortcutDef, appSettings?.shortcuts);
  const shortcutKeycap = h("button", {
    class: "keycap",
    style: "background:rgba(255,255,255,0.08);color:var(--ink);border:1px solid rgba(255,255,255,0.18);border-radius:6px;padding:4px 12px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;transition:all 0.15s ease;",
    text: binding.keys ? displayKeys(binding.keys) : "Yok",
  }) as HTMLButtonElement;

  let recording = false;
  shortcutKeycap.addEventListener("click", () => {
    if (recording) return;
    recording = true;
    shortcutKeycap.classList.add("recording");
    shortcutKeycap.style.borderColor = "#38bdf8";
    shortcutKeycap.style.color = "#38bdf8";
    shortcutKeycap.textContent = "Tuşlara basın...";
    void Bridge.shortcutsSuspend(true);

    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const result = recordPress(e);
      if (result.kind === "pending") return;
      finish();

      if (result.kind === "keys") {
        if (appSettings) {
          const next = {
            ...appSettings,
            shortcuts: {
              ...appSettings.shortcuts,
              talkToOmi: { keys: result.keys, enabled: true },
            },
          };
          await Bridge.saveSettings(next);
        }
        binding = { keys: result.keys, enabled: true };
        shortcutKeycap.textContent = displayKeys(result.keys);
      } else if (result.kind === "clear") {
        if (appSettings) {
          const next = {
            ...appSettings,
            shortcuts: {
              ...appSettings.shortcuts,
              talkToOmi: { keys: "", enabled: binding.enabled },
            },
          };
          await Bridge.saveSettings(next);
        }
        binding = { keys: "", enabled: binding.enabled };
        shortcutKeycap.textContent = "Yok";
      } else {
        shortcutKeycap.textContent = binding.keys ? displayKeys(binding.keys) : "Yok";
      }
    };

    const onBlur = () => finish();

    function finish() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      recording = false;
      shortcutKeycap.classList.remove("recording");
      shortcutKeycap.style.borderColor = "rgba(255,255,255,0.18)";
      shortcutKeycap.style.color = "var(--ink)";
      void Bridge.shortcutsSuspend(false);
    }

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  });

  const silenceOptions: [string, string][] = [
    ["5", "5 sn"],
    ["8", "8 sn (Varsayılan)"],
    ["10", "10 sn"],
    ["15", "15 sn"],
    ["20", "20 sn"],
  ];
  const currentTimeout = String(prefs.voiceSilenceTimeout || 8);

  const conversationCard = card(
    row(
      t("Omi ile Konuş Kısayolu"),
      t("Bu kısayola basarak Omi ile kesintisiz karşılıklı konuşmayı başlatabilirsiniz. Tekrar basarak da sohbeti sonlandırabilirsiniz."),
      shortcutKeycap,
    ),
    divider(),
    row(
      t("Susma Süresi (Sessizlik Zaman Aşımı)"),
      t("Karşılıklı konuşurken kaç saniye sessiz kalırsanız Omi dinlemeyi otomatik sonlandırsın."),
      segmented(silenceOptions, currentTimeout, (val) => {
        const secs = parseInt(val, 10) || 8;
        void ctx.setPrefs((p: FlowPrefs) => { p.voiceSilenceTimeout = secs; });
      }),
    ),
  );
  page.append(conversationCard);
  page.append(label(t("Voice Assistant AI Model")));
  const modelOptions = [
    { id: "antigravity/gemini-3.8-flash", name: "Gemini 3.8 Flash (Google Antigravity - Hızlı & Akıllı)" },
    { id: "antigravity/gemini-3-pro", name: "Gemini 3 Pro (Google Antigravity - Derin Akıl Yürütme)" },
    { id: "antigravity/gemini-2.5-flash", name: "Gemini 2.5 Flash (Google Antigravity - Düşük Gecikme)" },
    { id: "antigravity/claude-3-7-sonnet", name: "Claude 3.7 Sonnet (Google Antigravity)" },
    { id: "claude/haiku", name: "Claude 3.5 Haiku (Anthropic API Anahtarı)" },
    { id: "openai/gpt-4o-mini", name: "GPT-4o Mini (OpenAI API Anahtarı)" },
  ];
  const currentVoiceModel = (prefs.voiceModel && prefs.voiceModel !== "chat") ? prefs.voiceModel : "antigravity/gemini-3.8-flash";
  const modelSelect = h("select", {
    class: "hub-select",
    style: "background:rgba(255,255,255,0.06);color:var(--ink);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;",
    onchange: (e: Event) => {
      const val = (e.target as HTMLSelectElement).value;
      void ctx.setPrefs((p: FlowPrefs) => { p.voiceModel = val; }).then(() => ctx.navigate("voice"));
    },
  });
  for (const opt of modelOptions) {
    const optEl = h("option", { value: opt.id, text: opt.name }) as HTMLOptionElement;
    if (opt.id === currentVoiceModel) optEl.selected = true;
    modelSelect.append(optEl);
  }
  const modelCard = card(
    row(
      t("AI Model"),
      t("Sesli asistanın sorularınıza yanıt verirken ve komutları çalıştırırken kullanacağı yapay zeka beyni."),
      modelSelect,
    ),
  );
  page.append(modelCard);

  page.append(label(t("Answers")));
  const outputs: [VoiceOutput, string][] = [
    ["system", t("System voice")],
    ["piper", "Piper TTS"],
    ["elevenlabs", "ElevenLabs"],
    ["off", t("Text only")],
  ];
  const answers = card(
    row(t("Omi answers out loud"), null, segmented(outputs, prefs.voiceOutput, (v) => {
      if (v !== "piper") {
        void Bridge.voiceStopPiper();
      }
      void ctx.setPrefs((p: FlowPrefs) => { p.voiceOutput = v; }).then(() => ctx.navigate("voice"));
    })),
  );
  if (prefs.voiceOutput === "piper") {
    const piperVoices = [
      { id: "tr_TR-dfki-medium", name: "Türkçe (tr_TR - DFKI)" },
      { id: "en_US-lessac-medium", name: "English (US - Lessac)" },
      { id: "en_US-amy-medium", name: "English (US - Amy)" },
      { id: "en_GB-alba-medium", name: "English (UK - Alba)" },
      { id: "de_DE-thorsten-medium", name: "Deutsch (de_DE - Thorsten)" },
      { id: "fr_FR-siwis-medium", name: "Français (fr_FR - Siwis)" },
      { id: "es_ES-sharvard-medium", name: "Español (es_ES - Sharvard)" },
      { id: "it_IT-paola-medium", name: "Italiano (it_IT - Paola)" },
      { id: "ru_RU-dmitri-medium", name: "Русский (ru_RU - Dmitri)" },
      { id: "ar_JO-kareem-medium", name: "العربية (ar_JO - Kareem)" },
      { id: "pt_BR-faber-medium", name: "Português (pt_BR - Faber)" },
    ];
    const currentPiperVoice = prefs.piperVoice || "tr_TR-dfki-medium";
    const piperSelect = h("select", {
      class: "hub-select",
      style: "background:rgba(255,255,255,0.06);color:var(--ink);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;",
      onchange: (e: Event) => {
        const val = (e.target as HTMLSelectElement).value;
        void Bridge.voiceStopPiper();
        void ctx.setPrefs((p: FlowPrefs) => { p.piperVoice = val; }).then(() => ctx.navigate("voice"));
      },
    });
    for (const pv of piperVoices) {
      const optEl = h("option", { value: pv.id, text: pv.name }) as HTMLOptionElement;
      if (pv.id === currentPiperVoice) optEl.selected = true;
      piperSelect.append(optEl);
    }

    answers.append(
      divider(),
      row(
        t("Piper Ses Modeli ve Dili"),
        t("Sesli yanıtların üretileceği Piper yapay zeka ses modelini ve dil versiyonunu seçin."),
        piperSelect,
      ),
      divider(),
      row("Piper 1 Neural Voice", t("Seçilen model tamamen yerel çalışır; ilk kullanımda otomatik indirilir, internet gerektirmez ve ultra hızlıdır.")),
    );
  } else if (prefs.voiceOutput === "elevenlabs") {
    answers.append(
      divider(),
      row(t("Voice"), null, segmented([["female", t("Female")], ["male", t("Male")]], prefs.voiceGender, (g) => void ctx.setPrefs((p: FlowPrefs) => { p.voiceGender = g; }))),
      divider(),
      row(t("ElevenLabs key"), null, elevenKey()),
    );
  }
  page.append(answers);

  page.append(label(t("Privacy")));
  page.append(card(
    h("div", { class: "hub-note", text: t("Your voice never leaves this computer: Parakeet turns it into text here. Only the words after « OK Omi » go to Anthropic with your Claude key, and to ElevenLabs if you picked it for the answers.") }),
    divider(),
    h("div", { class: "hub-note", text: t("An email is never sent by Omi: your mail app opens with it written, and you send it.") }),
  ));
}
