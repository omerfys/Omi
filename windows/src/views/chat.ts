// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView /
// ModelPickerView from IslandViewContent.swift.
//
// Answers are rendered as Markdown (markdown.ts). A local model streams its
// answer: Rust sends `chat-delta` events with the text visible so far. The
// model name above the text field opens the picker: provider chips, then the
// models of the chosen provider, asked for only once it is picked.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import { Bridge, IS_TAURI, onEvent, type ChatContext, type ModelInfo } from "../core/bridge";
import {
  activeModel, pickModel, providerDef, visibleProviders, withModel, type ProviderDef,
} from "../core/providers";
import { Sound } from "../core/sound";
import { State, MAX_CHAT_SESSIONS, type ChatMessage } from "../core/state";
import type { ViewHost, ViewActions } from "./views";
import { N_, t, tl, language } from "../i18n/i18n";
import { fileLanguage } from "../core/languages";
import { parseTestOutput, formatTestBadge } from "../core/testout";

import { runAutonomousVisualLoop } from "../core/visualLoop";
import { executeSkillFromQuery, formatSkillResultMarkdown } from "../core/skills";
const STRINGS = {
  placeholderFirst: N_("Ask me anything…"),
  placeholderNext: N_("Continue…"),
  send: N_("Send"),
  switchModel: N_("Switch provider or model"),
  noModel: N_("Choose a model"),
  loading: N_("Loading models…"),
  noKey: N_("No API key — add it in Settings."),
  openSettings: N_("Open Settings"),
};

let nextId = 1;

const bubbleCache = new Map<number, HTMLElement>();

function bubble(message: ChatMessage): HTMLElement {
  const cached = bubbleCache.get(message.id);
  if (cached) return cached;

  let el: HTMLElement;
  if (message.role === "user") {
    el = h(
      "div",
      { class: "chat-row user", "data-msg-id": String(message.id) },
      h("div", { class: "bubble", text: message.content }),
    );
  } else {
    const reply = h("div", { class: "reply" });
    renderMarkdown(reply, message.content);

    const testSummary = parseTestOutput(message.content);
    if (testSummary) {
      const badge = h("div", {
        style: "display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);margin-bottom:8px;",
        text: formatTestBadge(testSummary),
      });
      reply.prepend(badge);
    }
    el = h("div", { class: "chat-row", "data-msg-id": String(message.id) }, reply);
  }

  bubbleCache.set(message.id, el);
  return el;
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string, onRemove?: () => void, onClick?: () => void): HTMLElement {
  const lang = fileLanguage(label);
  const langBadge = lang
    ? h("span", {
        style: `font-size:9.5px;font-weight:700;padding:1px 5px;border-radius:4px;background:${lang.color}25;color:${lang.color};margin-right:4px;`,
        text: lang.label,
      })
    : null;
  const removeBtn = onRemove
    ? h(
        "button",
        {
          class: "link-btn chip-remove",
          title: "Dosyayı Kaldır",
          "aria-label": "Dosyayı Kaldır",
          onclick: (e: Event) => {
            e.stopPropagation();
            onRemove();
          },
        },
        "✕",
      )
    : null;
  const chip = h(
    "div",
    {
      class: "chip",
      style: onClick ? "cursor:pointer;" : "",
      title: onClick ? "Önizlemek ve çizim yapmak için tıklayın" : "",
      onclick: onClick
        ? (e: Event) => {
            e.stopPropagation();
            onClick();
          }
        : undefined,
    },
    h("i", { class: "chip-dot" }),
    ...(langBadge ? [langBadge] : []),
    h("span", { text: label }),
    ...(removeBtn ? [removeBtn] : []),
  );
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

function saveSettings() {
  void Bridge.saveSettings(State.settings);
}

// ── Model picker ──────────────────────────────────────────────────────────────

interface Picker {
  el: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Provider chips, then the chosen provider's models — ModelPickerView. */
function buildPicker(onChange: () => void): Picker {
  const topBar = h("div", {
    class: "picker-top",
    style: "display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;padding:2px 0 6px;",
  });
  const chips = h("div", { class: "picker-chips", style: "display:flex;align-items:center;gap:4px;flex-wrap:wrap;" });
  const levelRow = h("div", {
    class: "picker-levels",
    style: "display:inline-flex;align-items:center;gap:2px;background:rgba(255,255,255,0.06);padding:2px;border-radius:6px;flex-shrink:0;",
  });
  topBar.append(chips, levelRow);
  const list = h("div", { class: "picker-list" });
  const el = h("div", { class: "picker" }, topBar, h("div", { class: "picker-rule", style: "margin:2px 0;" }), list);

  /** Models already asked for, by provider; a model server is asked again each time. */
  const cache = new Map<string, ModelInfo[]>();
  let isOpen = false;
  let request = 0;

  function drawChips() {
    clear(chips);
    for (const p of visibleProviders(State.settings)) {
      const on = p.id === State.settings.chatProvider;
      const chip = h(
        "button",
        { class: on ? "picker-chip on" : "picker-chip", style: `--accent:${p.accent}` },
        h("i", { class: "picker-dot" }),
        h("span", { text: t(p.name) }),
      );
      chip.addEventListener("click", () => {
        if (p.id === State.settings.chatProvider) return;
        State.settings = { ...State.settings, chatProvider: p.id };
        saveSettings();
        Sound.play("pop");
        drawChips();
        void loadModels();
        onChange();
      });
      chips.append(chip);
    }
  }

  function drawLevels() {
    clear(levelRow);
    const currentLevel = State.settings.thinkingLevel || "high";

    const levels: { id: "low" | "medium" | "high"; label: string }[] = [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ];

    for (const lvl of levels) {
      const active = lvl.id === currentLevel;
      const btn = h("button", {
        class: active ? "level-btn on" : "level-btn",
        style: `font-size:10.5px;font-weight:${active ? "700" : "500"};padding:2px 8px;border:0;border-radius:4px;cursor:pointer;transition:all 0.12s;background:${active ? "rgba(232,121,249,0.22)" : "transparent"};color:${active ? "#e879f9" : "var(--dim-2)"};line-height:1.3;`,
        onclick: (e: Event) => {
          e.stopPropagation();
          State.settings.thinkingLevel = lvl.id;
          const current = activeModel(State.settings);
          const base = current.split(":")[0];
          const newModelId = `${base}:${lvl.id}`;
          State.settings = withModel(State.settings, State.settings.chatProvider, newModelId);
          saveSettings();
          Sound.play("pop");
          drawLevels();
          void loadModels();
          onChange();
        },
      }, lvl.label);
      levelRow.append(btn);
    }
  }
  function status(text: string, withSettings = false) {
    clear(list);
    const line = h("div", { class: "picker-status", text });
    if (withSettings) {
      line.append(
        h("button", {
          class: "picker-link",
          text: tl(STRINGS.openSettings),
          onclick: () => void Bridge.openSettingsWindow(),
        }),
      );
    }
    list.append(line);
  }

  function drawModels(p: ProviderDef, models: ModelInfo[]) {
    clear(list);
    const current = activeModel(State.settings);
    const currentBase = current.split(":")[0];
    const currentLevel = State.settings.thinkingLevel || "high";

    for (const m of models) {
      const on = m.id === currentBase || m.id === current;
      const row = h(
        "button",
        { class: on ? "picker-model on" : "picker-model", style: `--accent:${p.accent}`, title: `${m.id}:${currentLevel}` },
        h("span", { class: "picker-model-name", text: m.label }),
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      row.addEventListener("click", () => {
        const selectedModelId = `${m.id}:${currentLevel}`;
        State.settings = withModel(State.settings, p.id, selectedModelId);
        saveSettings();
        Sound.play("blip");
        close();
      });
      list.append(row);
    }
    list.querySelector(".picker-model.on")?.scrollIntoView({ block: "nearest" });
  }

  async function loadModels() {
    const p = providerDef(State.settings.chatProvider);
    const ticket = ++request;
    const cached = p.urlField ? undefined : cache.get(p.id);
    if (cached) {
      drawModels(p, cached);
      return;
    }
    // Nothing is asked of a provider that has no key yet.
    if (p.key && !(await Bridge.secretPresent(p.key))) {
      if (ticket === request) status(t(STRINGS.noKey), true);
      return;
    }
    if (ticket !== request) return;
    status(t(STRINGS.loading));
    try {
      const models = await Bridge.chatModels(p.id);
      if (ticket !== request) return;
      if (!p.urlField) cache.set(p.id, models);
      const keep = pickModel(p, models.map((m) => m.id), activeModel(State.settings));
      if (keep && keep !== activeModel(State.settings)) {
        State.settings = withModel(State.settings, p.id, keep);
        saveSettings();
        onChange();
      }
      drawModels(p, models);
    } catch (err) {
      if (ticket === request) status(String(err).replace(/^Error:\s*/, ""), Boolean(p.key));
    }
  }

  function open() {
    isOpen = true;
    el.classList.add("on");
    drawChips();
    drawLevels();
    onChange();
    void loadModels();
  }

  function close() {
    isOpen = false;
    request++;
    el.classList.remove("on");
    onChange();
  }

  return {
    el,
    open,
    close,
    get isOpen() {
      return isOpen;
    },
  };
}

// ── View ──────────────────────────────────────────────────────────────────────

export function buildPrompt(onHeightChange: () => void, actions?: ViewActions): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const busySessions = new Set<string>();
  const abortControllers = new Map<string, AbortController>();
  const isCurrentBusy = () => Boolean(State.activeSessionId && busySessions.has(State.activeSessionId));

  function updateSendButton() {
    clear(send);
    if (isCurrentBusy()) {
      send.classList.add("stop");
      send.title = "İşlemi Durdur";
      send.setAttribute("aria-label", "İşlemi Durdur");
      send.append(svg(ICONS.stop, 10));
    } else {
      send.classList.remove("stop");
      send.title = t(STRINGS.send);
      send.setAttribute("aria-label", t(STRINGS.send));
      send.append(svg(ICONS.arrowUp, 11));
    }
  }

  function stopPrompt(sessionId = State.activeSessionId) {
    if (!sessionId) return;
    const ctrl = abortControllers.get(sessionId);
    if (ctrl) {
      ctrl.abort();
      abortControllers.delete(sessionId);
    }
    busySessions.delete(sessionId);
    liveTextBySession.delete(sessionId);
    void Bridge.chatReset(sessionId);

    if (State.activeSessionId === sessionId) {
      State.stateOverride = null;
      input.disabled = false;
      Sound.play("blip");

      updateSendButton();
      drawModelButton();

      const dots = log.querySelector(".typing");
      if (dots) {
        dots.closest(".chat-row")?.remove();
      }
      const liveEl = log.querySelector(".live-reply");
      if (liveEl) {
        liveEl.closest(".chat-row")?.remove();
      }

      const session = State.chatSessions.find((s) => s.id === sessionId);
      if (session) {
        const stopMsg: ChatMessage = {
          id: nextId++,
          role: "assistant",
          content: "⏹️ *İşlem durduruldu.*",
        };
        session.messages.push(stopMsg);
        State.chatHistory = [...session.messages];
      }

      State.saveCurrentSession();
      updateSessionsBtnState();
      State.notify();
      onHeightChange();
      scrollToBottom();
      input.focus();
    }
  }
  const liveTextBySession = new Map<string, string>();
  const log = h("div", { class: "chat-log" });
  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
    window.setTimeout(() => {
      log.scrollTop = log.scrollHeight;
    }, 40);
    window.setTimeout(() => {
      log.scrollTop = log.scrollHeight;
    }, 120);
  }
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: t(STRINGS.placeholderFirst),
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: tl(STRINGS.send) }, svg(ICONS.arrowUp, 11));
  const cameraBtn = h(
    "button",
    {
      class: "camera-btn",
      title: "Ekran Görüntüsü Al ve Etiketle (Shift+Tık: Aktif Pencere)",
      "aria-label": "Ekran Görüntüsü Al",
      onclick: async (e: Event) => {
        if (isCurrentBusy()) return;
        const me = e as MouseEvent;
        const mode = me.shiftKey ? "window" : "fullscreen";
        cameraBtn.style.opacity = "0.4";
        try {
          const shot = await Bridge.takeScreenshot(mode);
          State.droppedFile = { name: shot.name, path: shot.path };
          State.promptContext = { kind: "file", name: shot.name, path: shot.path };
          Sound.play("blip");
          State.notify();
          onHeightChange();
          input.placeholder = shot.title
            ? `"${shot.title}" ekranı hakkında bir şey sor...`
            : "Ekran görüntüsü hakkında bir şey sor veya analiz ettir...";
          input.focus();
        } catch (err) {
          console.error("Screenshot error:", err);
          Sound.play("error");
        } finally {
          cameraBtn.style.opacity = "1";
        }
      },
    },
    svg(ICONS.camera, 13),
  );
  interface SlashCommandDef {
    cmd: string;
    args?: string;
    desc: string;
    cat: string;
  }

  const SLASH_COMMANDS: SlashCommandDef[] = [
    { cmd: "/skills", desc: "Bütün modeller için aktif Evrensel Beceriler kataloğunu listeler", cat: "Skills" },
    { cmd: "/karpathy", args: "[check <kod>]", desc: "Andrej Karpathy kodlama yönergeleri ve sadelik kontrolü", cat: "Engineering" },
    { cmd: "/metaskill", args: "<proje veya 'agent <rol>'>", desc: "Tek komutla uzman ajan takımı veya tekil subagent mimarisi üretir", cat: "Subagents" },
    { cmd: "/replica", args: "[url veya uygulama]", desc: "Herhangi bir uygulamayı 11 aşamada clean-room tersine mühendislikle klonlar", cat: "Cloning" },
    { cmd: "/ponytail", args: "[review|debt|audit]", desc: "Kıdemli geliştirici minimalizmi: gereksiz kodu siler, en sade mimariyi zorlar", cat: "Engineering" },
    { cmd: "/i-have-adhd", desc: "ADHD odak modu: doğrudan eylemle başlayan, adım adım numaralı net yanıtlar", cat: "Productivity" },
    { cmd: "/composio", desc: "Composio & Awesome Skills (32+ araç) kataloğunu açar", cat: "Skills" },
    { cmd: "/mcp", args: "[isim]", desc: "Model Context Protocol (MCP) sunucusu ve istemcisi inşa eder", cat: "MCP & Tools" },
    { cmd: "/artifact", args: "[konu]", desc: "Tek dosyalık interaktif React/Tailwind/HTML web uygulaması üretir", cat: "Frontend" },
    { cmd: "/webapp-test", args: "[url]", desc: "Playwright / Cypress ile otomatik E2E senaryo ve test oluşturur", cat: "Testing" },
    { cmd: "/changelog", args: "[versiyon]", desc: "Git commitlerinden Keep A Changelog uyumlu sürüm notu hazırlar", cat: "Git" },
    { cmd: "/doc", args: "<pdf|docx|pptx|xlsx>", desc: "PDF, Word, PowerPoint veya Excel belgelerini inceler ve düzenler", cat: "Documents" },
    { cmd: "/organize", args: "[klasör]", desc: "Karışık dizinleri analiz edip kategorilerine göre düzenler", cat: "Productivity" },
    { cmd: "/computer", args: "<click|type|key|screenshot>", desc: "Windows yerel masaüstü otomasyonu (tıklama, yazma, ekran)", cat: "Desktop" },
    { cmd: "/playwright", args: "<navigate|scrape|click>", desc: "Chromium/Edge tarayıcı kontrolü ve web veri kazıma", cat: "Browser" },
    { cmd: "/browser-use", args: "<search|click|type>", desc: "Doğal dil veya indeks numaralarıyla web otomasyonu", cat: "Browser" },
    { cmd: "/gemini", desc: "Google Gemini API, Live WebSocket ve Omni Flash Video becerileri", cat: "Gemini" },
    { cmd: "/review", args: "[hedef]", desc: "OMP P0-P3 otomatik kod inceleme ve release denetimi", cat: "OMP" },
    { cmd: "/commit", args: "[mesaj]", desc: "OMP atomik commit ayırıcı ve bağımlılık kontrolü", cat: "OMP" },
    { cmd: "/security", args: "[dizin]", desc: "Depoyu secret sızıntıları ve güvenlik açıklarına karşı tarar", cat: "Security" },
    { cmd: "/autoclicker", args: "[start|stop]", desc: "Sistemde varsa autoclicker'ı açar, yoksa Omi'nin yerleşik tıklayıcısını başlatır", cat: "Automation" },
    { cmd: "/discord", args: "[hedef] <mesaj>", desc: "Discord'da kişiye veya kanala sıfır kod yazımıyla anında (<400ms) mesaj atar", cat: "Automation" },
    { cmd: "/clear", desc: "Mevcut sohbet mesajlarını temizler", cat: "Sistem" },
  ];

  const suggestBox = h("div", {
    class: "slash-suggest-box",
    style:
      "display:none;position:absolute;bottom:48px;left:84px;right:16px;max-height:140px;overflow-y:auto;background:rgba(18,19,23,0.96);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,0.1);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.65);z-index:100;padding:4px;box-sizing:border-box;",
  });
  let selectedSuggestIdx = 0;
  let activeMatches: SlashCommandDef[] = [];

  function closeSuggest() {
    if (suggestBox.style.display !== "none") {
      suggestBox.style.display = "none";
      activeMatches = [];
      onHeightChange();
    }
  }

  function pickAndExecute(cmd: SlashCommandDef) {
    closeSuggest();
    if (cmd.cmd === "/metaskill") {
      input.value = cmd.cmd + " ";
      input.focus();
      return;
    }
    input.value = cmd.cmd;
    void submit();
  }

  function renderSuggest(query: string, scroll = true) {
    const q = query.slice(1).trim().toLowerCase();
    activeMatches = SLASH_COMMANDS.filter(
      (c) =>
        c.cmd.slice(1).toLowerCase().startsWith(q) ||
        c.cmd.toLowerCase().includes(q) ||
        c.desc.toLowerCase().includes(q) ||
        c.cat.toLowerCase().includes(q),
    );

    if (activeMatches.length === 0) {
      closeSuggest();
      return;
    }

    if (selectedSuggestIdx >= activeMatches.length) {
      selectedSuggestIdx = 0;
    }

    clear(suggestBox);
    const listWrap = h("div", { style: "display:flex;flex-direction:column;gap:2px;" });

    activeMatches.forEach((item, idx) => {
      const isSel = idx === selectedSuggestIdx;
      const row = h(
        "div",
        {
          style: `display:flex;align-items:center;justify-content:space-between;padding:4px 8px;border-radius:6px;cursor:pointer;user-select:none;background:${
            isSel ? "rgba(255,255,255,0.08)" : "transparent"
          };border-left:2px solid ${isSel ? "#38bdf8" : "transparent"};transition:background 0.1s ease;`,
          onmouseenter: () => {
            selectedSuggestIdx = idx;
            renderSuggest(input.value, false);
          },
          onpointerdown: (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            pickAndExecute(item);
          },
          onclick: (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            pickAndExecute(item);
          },
        },
        h(
          "div",
          { style: "display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;" },
          h(
            "div",
            { style: "display:flex;align-items:baseline;gap:6px;" },
            h("span", { style: "font-weight:700;color:#38bdf8;font-family:var(--mono);font-size:12px;", text: item.cmd }),
            item.args ? h("span", { style: "color:#94a3b8;font-size:10.5px;font-family:var(--mono);", text: item.args }) : null,
          ),
          h("span", { style: "color:#cbd5e1;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", text: item.desc }),
        ),
        h("span", {
          style: "font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,0.06);color:#94a3b8;font-weight:600;margin-left:8px;flex-shrink:0;",
          text: item.cat,
        }),
      );
      listWrap.append(row);
    });

    const hintBar = h(
      "div",
      {
        style:
          "display:flex;align-items:center;justify-content:space-between;padding:4px 8px 0;font-size:10px;color:#64748b;border-top:1px solid rgba(255,255,255,0.06);margin-top:3px;",
      },
      h("span", { text: "Tab / ↵ ile çalıştır" }),
      h("span", { text: "↑↓ gezin" }),
      h("span", { text: "Esc kapat" }),
    );
    suggestBox.append(listWrap, hintBar);
    const wasHidden = suggestBox.style.display === "none";
    suggestBox.style.display = "block";
    if (wasHidden) {
      onHeightChange();
    }
    if (scroll) {
      const selRow = listWrap.children[selectedSuggestIdx] as HTMLElement | undefined;
      selRow?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  const bar = h("div", { class: "chat-bar" }, cameraBtn, input, send);

  const modelDot = h("i", { class: "model-dot" });
  const modelName = h("span", { class: "model-name" });
  const modelBtn = h(
    "button",
    { class: "model-btn", title: tl(STRINGS.switchModel) },
    modelDot,
    modelName,
    svg(ICONS.chevronUpDown, 9, { stroke: 2 }),
  );
  const accountBadge = h("button", {
    class: "model-account-badge",
    style: "display:none;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:12px;background:rgba(232,121,249,0.12);color:#e879f9;border:1px solid rgba(232,121,249,0.25);cursor:pointer;margin-left:auto;",
    title: "Google Antigravity Hesabı (Ayarlardan değiştir)",
    onclick: () => void Bridge.openSettingsWindow(),
  });

  let currentDir = "";
  const dirBadge = h("button", {
    class: "model-dir-badge",
    style: "display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;padding:2px 8px;border-radius:12px;background:rgba(255,255,255,0.06);color:#94a3b8;border:1px solid rgba(255,255,255,0.12);cursor:pointer;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:6px;transition:all 0.15s ease;",
    title: "Çalışma dizini (Değiştirmek için tıklayın veya 'cd <yol>' yazın)",
  });
  dirBadge.addEventListener("mouseenter", () => {
    dirBadge.style.background = "rgba(255,255,255,0.12)";
    dirBadge.style.color = "#f8fafc";
  });
  dirBadge.addEventListener("mouseleave", () => {
    dirBadge.style.background = "rgba(255,255,255,0.06)";
    dirBadge.style.color = "#94a3b8";
  });
  async function updateDirBadge() {
    currentDir = (await Bridge.getCurrentDir()) || currentDir || "Desktop";
    const parts = currentDir.replace(/[\\/]+$/, "").split(/[\\/]/);
    const folderName = parts[parts.length - 1] || currentDir;
    clear(dirBadge);
    dirBadge.append(
      svg(ICONS.folder, 12),
      h("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:4px;", text: folderName }),
    );
    dirBadge.title = `Çalışma Dizini: ${currentDir}\n(Klasör seçmek için tıklayın veya 'cd <yol>' yazın)`;
  }
  void updateDirBadge();

  dirBadge.addEventListener("click", async () => {
    try {
      const chosen = await Bridge.pickDirectory();
      if (chosen) {
        currentDir = chosen;
        await updateDirBadge();
        State.chatHistory.push({
          id: nextId++,
          role: "assistant",
          content: `📁 **Yeni çalışma dizini seçildi:** \`${chosen}\`\n\nYapay zeka artık tüm sorgularda bu dizindeki dosyaları ve kodu baz alacak.`,
        });
        State.notify();
        onHeightChange();
        Sound.play("blip");
      }
    } catch (err) {
      console.error(err);
    }
  });

  // ── New Chat & Sessions controls ──────────────────────────────────────────
  // ── New Chat & In-Place Sessions controls ─────────────────────────────────
  const newChatBtn = h(
    "button",
    {
      class: "new-chat-btn",
      title: "Yeni Sohbet (Ctrl+N)",
      "aria-label": "Yeni Sohbet",
      onclick: () => {
        closeSessionsPanel();
        renderedCount = -1;
        lastRenderedSessionId = null;
        State.newChatSession();
        input.value = "";
        input.disabled = false;
        Sound.play("blip");
        input.focus();
        onHeightChange();
      },
    },
    svg(ICONS.plus, 11),
  );

  const sessionsBtn = h(
    "button",
    {
      class: "sessions-btn",
      title: "Kayıtlı Sohbetler",
      "aria-label": "Kayıtlı Sohbetler",
      onclick: () => {
        toggleSessionsPanel();
      },
    },
    svg(ICONS.bubble, 12),
  );

  const sessionsPanel = h("div", { class: "sessions-panel" });
  let isSessionsOpen = false;

  function updateSessionsBtnState() {
    const count = State.chatSessions.length;
    sessionsBtn.title = isSessionsOpen ? "Sohbete Dön" : (count > 0 ? `Sohbet Geçmişi (${count}/${MAX_CHAT_SESSIONS})` : "Sohbet Geçmişi");
    sessionsBtn.classList.toggle("open", isSessionsOpen);
  }

  function renderSessionsPanel() {
    clear(sessionsPanel);
    const sessions = State.chatSessions;
    updateSessionsBtnState();

    const list = h("div", { class: "sessions-panel-list" });
    if (sessions.length === 0) {
      list.append(
        h(
          "div",
          {
            style: "padding:36px 16px;text-align:center;font-size:12px;color:var(--dim-3);",
          },
          h("div", { text: "Henüz kayıtlı bir sohbetiniz yok." }),
        ),
      );
    } else {
      for (const s of sessions) {
        const isCurrent = s.id === State.activeSessionId;
        const msgCount = s.messages.length;
        const card = h(
          "div",
          {
            class: `session-card${isCurrent ? " active" : ""}`,
            onclick: () => {
              if (s.id !== State.activeSessionId) {
                renderedCount = -1;
                lastRenderedSessionId = null;
                State.switchChatSession(s.id);
                Sound.play("blip");
              }
              closeSessionsPanel();
              input.disabled = isCurrentBusy();
              if (!isCurrentBusy()) input.focus();
              onHeightChange();
            },
          },
          h(
            "div",
            { class: "session-card-left" },
            h("span", {
              style: `display:inline-block;width:6px;height:6px;border-radius:50%;background:${isCurrent ? "#38bdf8" : "rgba(255,255,255,0.2)"};box-shadow:${isCurrent ? "0 0 6px rgba(56,189,248,0.6)" : "none"};flex-shrink:0;`,
            }),
            h(
              "div",
              { style: "overflow:hidden;flex:1;min-width:0;" },
              h("div", { class: "session-card-title", text: s.title || "Sohbet" }),
              h("div", {
                class: "session-card-meta",
                text: `${isCurrent ? "Aktif oturum • " : ""}${msgCount} mesaj`,
              }),
            ),
          ),
          h(
            "button",
            {
              class: "session-card-del",
              title: "Bu sohbeti sil",
              onpointerdown: (e: Event) => e.stopPropagation(),
              onmousedown: (e: Event) => e.stopPropagation(),
              onclick: (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                State.deleteChatSession(s.id);
                renderSessionsPanel();
                Sound.play("blip");
                onHeightChange();
              },
            },
            svg(ICONS.xmark, 10),
          ),
        );
        list.append(card);
      }
    }
    sessionsPanel.append(list);
  }

  function toggleSessionsPanel() {
    if (isSessionsOpen) {
      closeSessionsPanel();
    } else {
      if (picker.isOpen) picker.close();
      isSessionsOpen = true;
      body.classList.add("showing-sessions");
      renderSessionsPanel();
      updateSessionsBtnState();
      onHeightChange();
    }
  }

  function closeSessionsPanel() {
    isSessionsOpen = false;
    body.classList.remove("showing-sessions");
    updateSessionsBtnState();
    onHeightChange();
  }

  updateSessionsBtnState();

  const topActions = h(
    "div",
    { style: "display:flex;align-items:center;gap:6px;margin-left:auto;flex-shrink:0;" },
    sessionsBtn,
    newChatBtn,
  );
  const topRow = h(
    "div",
    { class: "chat-top-row" },
    chipRow,
    topActions,
  );

  const modelRow = h(
    "div",
    { class: "model-row", style: "display:flex;align-items:center;gap:6px;" },
    dirBadge,
    h("div", { style: "margin-left:auto;display:flex;align-items:center;gap:6px;" }, accountBadge, modelBtn),
  );
  const body = h("div", { class: "chat-body" });
  const picker = buildPicker(() => {
    State.pickerOpen = picker.isOpen;
    body.classList.toggle("picking", picker.isOpen);
    drawModelButton();
    onHeightChange();
  });
  body.append(topRow, log, sessionsPanel, picker.el, modelRow, suggestBox, bar);

  void Bridge.antigravityAccounts().then(async (accs) => {
    if (accs.some((a) => a.active)) {
      const p = providerDef(State.settings.chatProvider);
      if (p.key && !(await Bridge.secretPresent(p.key))) {
        State.settings = { ...State.settings, chatProvider: "google-antigravity" };
        saveSettings();
        drawModelButton();
      }
    }
  });
  const el = h("div", { class: "view" }, h("div", { class: "card wash chat-card" }, body));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");
  let renderedCount = -1;
  let cachedAccountBadgeText = "";
  let lastAccountCheck = 0;

  function drawModelButton() {
    const p = providerDef(State.settings.chatProvider);
    modelDot.style.background = p.accent;
    modelName.textContent = activeModel(State.settings) || t(STRINGS.noModel);
    modelBtn.classList.toggle("open", picker.isOpen);
    modelBtn.disabled = isCurrentBusy();
    if (State.settings.chatProvider === "google-antigravity") {
      accountBadge.style.display = "inline-flex";
      if (cachedAccountBadgeText) {
        accountBadge.textContent = cachedAccountBadgeText;
      } else if (!accountBadge.textContent) {
        accountBadge.textContent = "Google Hesabı";
      }

      const now = performance.now();
      if (now - lastAccountCheck > 3000 || !cachedAccountBadgeText) {
        lastAccountCheck = now;
        void Bridge.antigravityAccounts().then((accs) => {
          const active = accs.find((a) => a.active);
          const nextText = active ? `${active.email.split("@")[0]} (Google)` : "+ Google Giriş Yap";
          if (nextText !== cachedAccountBadgeText) {
            cachedAccountBadgeText = nextText;
            accountBadge.textContent = nextText;
          }
        });
      }
    } else {
      accountBadge.style.display = "none";
    }
  }

  modelBtn.addEventListener("click", () => {
    if (isCurrentBusy()) return;
    if (picker.isOpen) picker.close();
    else picker.open();
  });

  let liveRafId: number | null = null;
  let latestDeltaText = "";

  void onEvent<any>("chat-delta", (payload) => {
    let deltaText = "";
    let deltaSessionId: string | null = null;
    if (typeof payload === "string") {
      deltaText = payload;
    } else if (payload && typeof payload === "object") {
      deltaText = payload.text || "";
      deltaSessionId = payload.sessionId || null;
    }
    const targetId = deltaSessionId || State.activeSessionId;
    if (!targetId || !deltaText) return;

    liveTextBySession.set(targetId, deltaText);

    if (targetId === State.activeSessionId) {
      latestDeltaText = deltaText;
      if (liveRafId == null) {
        liveRafId = requestAnimationFrame(() => {
          liveRafId = null;
          let liveEl = log.querySelector(".live-reply") as HTMLElement | null;
          if (!liveEl) {
            log.querySelector(".typing")?.closest(".chat-row")?.remove();
            liveEl = h("div", { class: "reply live-reply" });
            log.append(h("div", { class: "chat-row" }, liveEl));
          }
          renderMarkdown(liveEl, latestDeltaText);
          log.scrollTop = log.scrollHeight;
        });
      }
    }
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || isCurrentBusy()) return;
    if (picker.isOpen) picker.close();

    const trimmed = query.trim();
    if (trimmed.toLowerCase().startsWith("cd ") || trimmed.toLowerCase() === "cd") {
      input.value = "";
      const dest = trimmed.length > 2 ? trimmed.slice(2).trim() : "";
      State.chatHistory.push({ id: nextId++, role: "user", content: query });
      try {
        const newDir = await Bridge.setCurrentDir(dest || ".");
        currentDir = newDir;
        await updateDirBadge();
        State.chatHistory.push({
          id: nextId++,
          role: "assistant",
          content: `📁 **Dizin değiştirildi:** \`${newDir}\`\n\nYapay zeka tüm sorgularda bu dizini baz alacaktır.`,
        });
        Sound.play("blip");
      } catch (err) {
        State.chatHistory.push({
          id: nextId++,
          role: "assistant",
          content: `❌ **Dizin değiştirilemedi:** ${String(err).replace(/^Error:\s*/, "")}`,
        });
        Sound.play("error");
      }
      State.notify();
      onHeightChange();
      input.focus();
      return;
    }

    // Direct Skill Slash Commands (/computer, /cu, /playwright, /pw, ```skill:...)
    const isDirectSkill =
      trimmed.startsWith("/discord") ||
      trimmed.startsWith("/dc ") ||
      trimmed === "/dc" ||
      trimmed.startsWith("/autoclicker") ||
      trimmed.startsWith("/clicker") ||
      trimmed.startsWith("/cu ") ||
      trimmed.startsWith("/playwright") ||
      trimmed.startsWith("/pw ") ||
      trimmed.startsWith("/browser-use") ||
      trimmed.startsWith("/bu ") ||
      trimmed.startsWith("/browser ") ||
      trimmed === "/skills" ||
      trimmed.startsWith("/skills ") ||
      trimmed.startsWith("/gemini") ||
      trimmed.startsWith("/karpathy") ||
      trimmed.startsWith("/metaskill") ||
      trimmed.startsWith("/replica") ||
      trimmed.startsWith("/ponytail") ||
      trimmed.startsWith("/i-have-adhd") ||
      trimmed.startsWith("/adhd") ||
      trimmed.startsWith("/composio") ||
      trimmed.startsWith("/awesome") ||
      trimmed.startsWith("/mcp") ||
      trimmed.startsWith("/artifact") ||
      trimmed.startsWith("/changelog") ||
      trimmed.startsWith("/organize") ||
      trimmed.startsWith("/doc") ||
      trimmed.startsWith("/webapp-test") ||
      trimmed.startsWith("/omp") ||
      trimmed.startsWith("/harness") ||
      trimmed.startsWith("/review") ||
      trimmed.startsWith("/commit") ||
      trimmed.startsWith("/security") ||
      trimmed.startsWith("```skill:");
    if (isDirectSkill) {
      input.value = "";
      State.chatHistory.push({ id: nextId++, role: "user", content: query });
      const curId = State.activeSessionId || ("chat_" + Date.now());
      busySessions.add(curId);
      const abortCtrl = new AbortController();
      abortControllers.set(curId, abortCtrl);
      updateSendButton();
      input.disabled = true;
      drawModelButton();
      State.stateOverride = "thinking";
      State.notify();
      onHeightChange();

      try {
        const skillRes = await executeSkillFromQuery(trimmed);
        if (skillRes) {
          const content = formatSkillResultMarkdown(skillRes);
          State.chatHistory.push({ id: nextId++, role: "assistant", content });
          Sound.play(skillRes.success ? "finish" : "error");
        }
      } catch (err) {
        State.chatHistory.push({ id: nextId++, role: "assistant", content: `❌ Hata: ${String(err)}` });
        Sound.play("error");
      } finally {
        busySessions.delete(curId);
        abortControllers.delete(curId);
        updateSendButton();
        input.disabled = isCurrentBusy();
        State.stateOverride = null;
        State.saveCurrentSession();
        updateSessionsBtnState();
        drawModelButton();
        State.notify();
        onHeightChange();
        scrollToBottom();
        input.focus();
      }
      return;
    }
    // 0. Discord Natural Language Fast-Path (Zero-Code Instant Messaging)
    const isDiscordRequest =
      ((/(?:^|\s)(?:discord|dc)(?:'dan|'den|dan|den|'da|'de|da|de)?\b/i.test(trimmed) &&
        /(?:mesaj\s+(?:at|yaz|gönder)|yaz|at|gönder)\b/i.test(trimmed)) ||
        /(?:grubuna|kanalına|odasına)\s+.+\s*(?:mesaj\s+(?:at|yaz|gönder)|yaz|at|gönder)$/i.test(trimmed));
    if (isDiscordRequest) {
      const cleaned = trimmed.replace(/^(?:discord|dc)(?:'dan|'den|dan|den|'da|'de|da|de)?\s+/i, "").trim();
      let target: string | null = null;
      let message = "";
      let isGroup = false;

      // Group/channel matching (e.g. "not defteri grubuna selam yaz", "genel kanalına selam yaz")
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

      if (message) {
        input.value = "";
        State.chatHistory.push({ id: nextId++, role: "user", content: query });
        try {
          await Bridge.discordSendMessage(message, target, isGroup);
          const targetStr = target
            ? (isGroup ? `\`${target}\` grubuna/kanalına` : `\`${target}\` adlı kullanıcıya`)
            : "aktif Discord sohbetine";
          State.chatHistory.push({
            id: nextId++,
            role: "assistant",
            content: `💬 **Discord Mesajı İletildi:**\n\n> "${message}"\n\n🎯 Hedef: ${targetStr}`,
          });
          Sound.play("finish");
        } catch (err) {
          State.chatHistory.push({ id: nextId++, role: "assistant", content: `❌ Discord mesajı gönderilemedi: ${String(err)}` });
          Sound.play("error");
        }
        State.notify();
        onHeightChange?.();
        window.setTimeout(() => {
          actions?.collapse();
        }, 400);
        return;
      }
    }

    // 1. Natural Language Autoclicker Request Handler
    const isAutoclickerNL =
      /(?:bana\s+)?(?:bir\s+)?autoclicker\s+(?:lazım|aç|çalıştır|istiyorum|gerek(?:li)?)|otomatik\s+tıklay?ıcı\s+(?:lazım|aç|çalıştır|istiyorum|yap)/i.test(
        trimmed,
      );
    if (isAutoclickerNL) {
      input.value = "";
      State.chatHistory.push({ id: nextId++, role: "user", content: query });
      try {
        const res = await Bridge.autoclickerLaunchOrCreate();
        const content =
          res?.mode === "existing"
            ? `⚡ **Sistemde Yüklü Autoclicker Açıldı:** \`${res.appName || "Autoclicker"}\`\n\n${res.message}\n\n*${res.stopHint}*`
            : `⚡ **Omi Yerleşik Autoclicker Başlatıldı:**\n\n${res?.message || "Omi yerleşik otomatik tıklayıcısı başlatıldı."}\n\n🛑 **${res?.stopHint || "Durdurmak için F8 veya ESC tuşuna basın."}**`;
        State.chatHistory.push({ id: nextId++, role: "assistant", content });
        Sound.play("finish");
      } catch (err) {
        State.chatHistory.push({ id: nextId++, role: "assistant", content: `❌ Autoclicker başlatılamadı: ${String(err)}` });
        Sound.play("error");
      }
      State.notify();
      onHeightChange?.();
      window.setTimeout(() => {
        actions?.collapse();
      }, 400);
      return;
    }

    // 2. Direct Message Protocol on Tagged Site/Window (Zero Trial-and-Error)
    const isDirectMsg =
      /^(?:(?:şuna|buna|siteye|sekmesine|sekmede|pencereye)\s+)?(?:mesaj\s+yaz|mesaj\s+gönder|mesaj\s+at|yazmaya\s+devam\s+et|şunu\s+yaz)\s*(?::|\s)\s*(.+)$/i.exec(
        trimmed,
      );
    if (isDirectMsg && State.activeTabContext) {
      const msgText = (isDirectMsg[1] || "").trim();
      if (msgText) {
        input.value = "";
        State.chatHistory.push({ id: nextId++, role: "user", content: query });
        try {
          await Bridge.executeComputerAction({ action: "type", text: msgText });
          await Bridge.executeComputerAction({ action: "key", key: "Enter" });
          State.chatHistory.push({
            id: nextId++,
            role: "assistant",
            content: `✍️ **Mesaj "${State.activeTabContext}" Sekmesine Doğrudan Yazıldı ve Gönderildi:**\n\n> "${msgText}"\n\n*Kanıtlanmış doğrudan yazma yöntemi kullanıldı (sıfır deneme-yanılma).*`,
          });
          Sound.play("finish");
        } catch (err) {
          State.chatHistory.push({ id: nextId++, role: "assistant", content: `❌ Mesaj gönderilemedi: ${String(err)}` });
          Sound.play("error");
        }
        State.notify();
        onHeightChange?.();
        return;
      }
    }

    // Check if query is about local files, folders, or local computer actions
    const isLocalRequest = /\b(dosya|dosyayı|dosyasını|klasör|klasörü|klasörünü|dizin|bilgisayar|bilgisayarda|src|src-tauri|proje|projeyi|file|folder|kod|kodu)\b/i.test(trimmed);

    // 3. Web Search & Smart Auto-Tagging (Airbnb, Sahibinden, Google, etc.)
    const hasWebPlatform = /^(google|sahibinden|airbnb|hepsiemlak|youtube)(?:'da|'de|da|de|'dan|'den|dan|den)?\s+/i.test(trimmed);
    const hasExplicitWebSearch = /(?:diye\s+arat|web(?:'de|de)?\s+ara|internette\s+ara|google(?:'da|da)?\s+ara)/i.test(trimmed);

    if (!isLocalRequest && (hasWebPlatform || hasExplicitWebSearch)) {
      const searchMatch = trimmed.match(
        /^(?:(?:(google|sahibinden|airbnb|hepsiemlak|youtube)(?:'da|'de|da|de|'dan|'den|dan|den)?\s+)?(.+?)\s+(?:diye\s+)?(?:arat|ara|bul|listele|göster)|(?:ara|arat|bul|listele)\s+(.+))$/i,
      );
      if (searchMatch) {
        const platform = (searchMatch[1] || "").toLowerCase();
        const term = (searchMatch[2] || searchMatch[3] || "").trim();
        if (term) {
          input.value = "";
          State.chatHistory.push({ id: nextId++, role: "user", content: query });

          let effectivePlatform = platform;
          if (!effectivePlatform && State.activeTabContext) {
            const tabLower = State.activeTabContext.toLowerCase();
            if (tabLower.includes("sahibinden")) effectivePlatform = "sahibinden";
            else if (tabLower.includes("airbnb")) effectivePlatform = "airbnb";
            else if (tabLower.includes("hepsiemlak")) effectivePlatform = "hepsiemlak";
            else if (tabLower.includes("youtube")) effectivePlatform = "youtube";
          }

          let searchUrl = `https://www.google.com/search?q=${encodeURIComponent(term)}`;
          let tagTitle = "";
          let displayTitle = term;

          if (effectivePlatform === "airbnb") {
            // Smart Airbnb parsing (location, bedrooms, clean fillers)
            const bedroomMatch = term.match(/(\d+)\s*\+\s*(\d+)|\b(\d+)\s*(?:oda|yatak|bedroom)/i);
            const minBedrooms = bedroomMatch ? bedroomMatch[1] || bedroomMatch[3] : null;

            const FILLER_WORDS: Record<string, true> = {
              bana: true, şu: true, bu: true, o: true, tüm: true, lütfen: true,
              evleri: true, evler: true, ev: true, daireleri: true, daireler: true,
              daire: true, villaları: true, villalar: true, villa: true,
              listele: true, göster: true, bul: true, ara: true, arat: true,
              ilanları: true, ilanlar: true, satılık: true, kiralık: true, fiyatları: true,
            };

            const cleanTokens = term
              .split(/\s+/)
              .filter((token) => {
                const lower = token.toLowerCase();
                if (FILLER_WORDS[lower]) return false;
                if (/^(\d+)\s*\+\s*(\d+)$/.test(lower)) return false;
                if (/^(\d+)(?:oda|yatak)?$/.test(lower)) return false;
                return true;
              })
              .map((token) => {
                // Strip Turkish locative/relative suffixes: "kıbrıstaki" / "kıbrıs'taki" -> "kıbrıs"
                return token.replace(/(?:'ta|'te|'daki|'deki|taki|teki|daki|deki)$/i, "");
              })
              .filter(Boolean);

            let cleanLocation = cleanTokens.join(" ").trim();
            cleanLocation = cleanLocation
              .split(" ")
              .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
              .join(" ")
              .trim();

            if (!cleanLocation) cleanLocation = "Kıbrıs";
            if (minBedrooms) {
              searchUrl = `https://www.airbnb.com.tr/s/${encodeURIComponent(cleanLocation)}/homes?min_bedrooms=${minBedrooms}`;
              tagTitle = `Airbnb: ${cleanLocation} (${minBedrooms}+1 Evler)`;
              displayTitle = `${cleanLocation} ${minBedrooms}+1 Evleri`;
            } else {
              searchUrl = `https://www.airbnb.com.tr/s/${encodeURIComponent(cleanLocation)}/homes`;
              tagTitle = `Airbnb: ${cleanLocation} Evleri`;
              displayTitle = `${cleanLocation} Evleri`;
            }
          } else if (effectivePlatform === "sahibinden") {
            searchUrl = `https://www.sahibinden.com/arama?query_text=${encodeURIComponent(term)}`;
            tagTitle = `Sahibinden: ${term}`;
          } else if (effectivePlatform === "youtube") {
            searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(term)}`;
            tagTitle = `YouTube: ${term}`;
          } else if (effectivePlatform === "hepsiemlak") {
            searchUrl = `https://www.hepsiemlak.com/arama?q=${encodeURIComponent(term)}`;
            tagTitle = `Hepsiemlak: ${term}`;
          } else {
            tagTitle = `Google: ${term}`;
          }

          // AUTO-TAG THE ACTIVE CONTEXT
          State.activeTabContext = tagTitle;

          void Bridge.openUrl(searchUrl);
          State.chatHistory.push({
            id: nextId++,
            role: "assistant",
            content: `🌐 **${effectivePlatform === "airbnb" ? "Airbnb" : effectivePlatform.toUpperCase()} Sekmesi Otomatik Etiketlendi ve Açıldı:** [${displayTitle}](${searchUrl})\n\nSekme \`${tagTitle}\` olarak etiketlendi ve tarayıcınızda açıldı. Sayfayı rahatça görebilmeniz için ada küçültüldü.`,
          });
          Sound.play("finish");
          State.notify();
          onHeightChange?.();

          // Collapse the island so the user can comfortably see the site!
          window.setTimeout(() => {
            actions?.collapse();
          }, 350);
          return;
        }
      }
    }
    input.value = "";
    const originSessionId = State.activeSessionId || ("chat_" + Date.now());
    busySessions.add(originSessionId);
    const abortCtrl = new AbortController();
    abortControllers.set(originSessionId, abortCtrl);
    updateSendButton();
    let originSession = State.chatSessions.find((s) => s.id === originSessionId);
    if (!originSession) {
      originSession = {
        id: originSessionId,
        title: query.slice(0, 24).trim().replace(/\s+/g, " ") || "Sohbet",
        messages: [],
        updatedAt: Date.now(),
      };
      State.chatSessions.unshift(originSession);
    } else if (originSession.messages.length === 0 || originSession.title === "Sohbet") {
      originSession.title = query.slice(0, 24).trim().replace(/\s+/g, " ") || "Sohbet";
    }

    const isViewingOrigin = () => State.activeSessionId === originSessionId;

    if (isViewingOrigin()) {
      input.disabled = true;
      drawModelButton();
      Sound.play("send");
    }

    const userMsg: ChatMessage = { id: nextId++, role: "user", content: query };
    State.appendMessageToSession(originSessionId, userMsg);

    let activeDots: HTMLElement | null = null;
    if (isViewingOrigin()) {
      State.chatHistory = [...originSession.messages];
      log.append(bubble(userMsg));
      activeDots = typingDots();
      log.append(activeDots);
      scrollToBottom();
      updateSessionsBtnState();
      State.stateOverride = "thinking";
      State.notify();
      onHeightChange();
    }
    const file = State.droppedFile;
    const context: ChatContext | null =
      file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      let replyText = "";
      if (IS_TAURI && State.settings.autonomousVisualLoop) {
        const loopMsg: ChatMessage = {
          id: nextId++,
          role: "assistant",
          content: `🎯 **Otonom Görsel Doğrulama Modu Başlatıldı**\n\nMasaüstü taranıyor ve işlemin yapılıp yapılmadığı ekran görüntüleriyle doğrulanıyor...`,
        };
        originSession.messages.push(loopMsg);
        if (isViewingOrigin()) {
          State.chatHistory = [...originSession.messages];
          State.notify();
          onHeightChange();
        }

        const loopResult = await runAutonomousVisualLoop(query, {
          onStepStart: (step, maxSteps) => {
            loopMsg.content = `🎯 **Otonom Doğrulama [Adım ${step}/${maxSteps}]**\n\n📸 Masaüstü ekran görüntüsü alınıyor ve kontrol ediliyor...`;
            State.notify();
            onHeightChange();
          },
          onStepUpdate: (res) => {
            if (res.status === "in_progress") {
              loopMsg.content = `🔄 **Adım ${res.step}/${res.maxSteps} İncelendi:**\n` +
                `- 🔍 **Gözlem:** ${res.observation}\n` +
                (res.actionPlanned ? `- ⚡ **Planlanan Adım:** ${res.actionPlanned}\n` : "") +
                `- ⏳ Hedefe tam ulaşıldığı henüz doğrulanamadı. Bir sonraki ekran görüntüsüyle doğrulanıyor...`;
              State.notify();
              onHeightChange();
            }
          },
        });

        if (loopResult.status === "done") {
          loopMsg.content = `✅ **Görsel Olarak Doğrulandı ve Tamamlandı!** (Adım ${loopResult.step}/${loopResult.maxSteps})\n\n` +
            `🔍 **Ekranda Doğrulanan Durum:** ${loopResult.observation}\n\n` +
            `💡 **Sonuç:** ${loopResult.explanation}`;
        } else if (loopResult.status === "max_reached") {
          loopMsg.content = `🏁 **Maksimum Doğrulama Adımına (${loopResult.maxSteps}) Ulaşıldı:**\n\n` +
            `- 🔍 **Son Ekran Gözlemi:** ${loopResult.observation}\n` +
            `- ℹ️ ${loopResult.explanation}\n\n` +
            `*Masaüstünüzü kontrol ederek işlemin istediğiniz şekilde tamamlandığını teyit edebilirsiniz.*`;
        } else {
          loopMsg.content = `⚠️ **Görsel Doğrulama:** ${loopResult.explanation}`;
        }
        replyText = loopMsg.content;
      } else if (IS_TAURI) {
        let fullQuery = query;
        const currentLang = language();
        if (currentLang === "tr" || (!State.settings.language && /tr/i.test(navigator.language))) {
          fullQuery = `[KULLANICI DİLİ: TÜRKÇE - Lütfen cevabını kesinlikle Türkçe olarak ver]\n\n${fullQuery}`;
        }
        if (State.activeTabContext) {
          fullQuery = `[Aktif Sekme/Pencere: "${State.activeTabContext}"]\n\n${fullQuery}`;
        }
        if (file) {
          fullQuery = `[Ekran Görüntüsü / Dosya: "${file.name}"]\n\n${fullQuery}`;
        }
        const reply = await Bridge.chatSend(fullQuery, context, originSessionId);
        if (abortCtrl.signal.aborted) return;
        replyText = reply.text;
        const asstMsg: ChatMessage = { id: nextId++, role: "assistant", content: replyText };
        State.appendMessageToSession(originSessionId, asstMsg);
        try {
          let currentSkill = await executeSkillFromQuery(replyText);
          let loopSteps = 0;
          const MAX_SKILL_STEPS = 8;
          while (currentSkill && loopSteps < MAX_SKILL_STEPS) {
            if (abortCtrl.signal.aborted) break;
            loopSteps++;
            const skillResultMarkdown = formatSkillResultMarkdown(currentSkill);
            const skillMsg: ChatMessage = { id: nextId++, role: "assistant", content: skillResultMarkdown };
            State.appendMessageToSession(originSessionId, skillMsg);
            if (isViewingOrigin()) {
              Sound.play(currentSkill.success ? "blip" : "error");
            }

            if (!currentSkill.success) {
              break;
            }

            // Small delay for UI and OS to settle after action
            const { promise: delayPromise, resolve: delayResolve } = Promise.withResolvers<void>();
            setTimeout(delayResolve, 700);
            await delayPromise;
            // Automatically capture fresh screenshot for vision context so AI can see the result
            let nextContext: ChatContext | null = null;
            let shotPath = "";
            let shotName = "";

            if (currentSkill.action === "screenshot" && currentSkill.output && typeof currentSkill.output === "object") {
              const outObj = currentSkill.output as Record<string, unknown>;
              shotPath = (outObj.path as string) || "";
              shotName = (outObj.name as string) || "screenshot.png";
            } else {
              try {
                const freshShot = await Bridge.takeScreenshot("fullscreen");
                shotPath = freshShot.path;
                shotName = freshShot.name;
              } catch (e) {
                console.warn("Auto screenshot capture after skill failed:", e);
              }
            }

            if (shotPath) {
              nextContext = { kind: "file", name: shotName || "screenshot.png", path: shotPath };
            }

            const feedbackPrompt = `[BİLGİSAYAR KONTROLÜ (COMPUTER USE) - ADIM ${loopSteps} GERÇEKLEŞTİRİLDİ]
Kullanıcının Orijinal İsteği: "${query}"
Son Gerçekleştirilen Eylem: "${currentSkill.action}" (${currentSkill.message})

📸 Ekteki güncel ekran görüntüsünü incele.
Bu ekran görüntüsündeki arayüz öğelerine (pencereler, butonlar, arama çubuğu, metin alanları vb.) göre sıradaki eylemi belirle.
- Metin yazmak için: {"action":"type","text":"..."}
- Tuş basmak için (Enter, Esc, Tab): {"action":"key","key":"enter"}
- Uygulama açmak için: {"action":"hotkey","keys":["win","r"]} sonra type sonra enter
- Koordinata tıklamak için: {"action":"click","x":...,"y":...}

Eğer kullanıcının istediği işlem tamamen bittiyse "GÖREV_TAMAMLANDI" ifadesini kullanarak sonucu özetle.
Henüz bitmediyse sıradaki eylemi JSON bloğu olarak üret:
\`\`\`skill:computer_use
{"action":"...", ...}
\`\`\``;

            // Send feedback to AI to get the next step in the loop
            const nextTurn = await Bridge.chatSend(feedbackPrompt, nextContext, originSessionId);
            const nextReply = nextTurn.text;

            if (/GÖREV_TAMAMLANDI|TAMAMLANDI|TASK_COMPLETED/i.test(nextReply) && !nextReply.includes("```skill:")) {
              const finalMsg: ChatMessage = { id: nextId++, role: "assistant", content: nextReply };
              State.appendMessageToSession(originSessionId, finalMsg);
              if (isViewingOrigin()) {
                Sound.play("finish");
              }
              break;
            }

            const nextMsg: ChatMessage = { id: nextId++, role: "assistant", content: nextReply };
            State.appendMessageToSession(originSessionId, nextMsg);
            if (isViewingOrigin()) {
              State.chatHistory = [...originSession.messages];
              State.notify();
              onHeightChange();
            }
            currentSkill = await executeSkillFromQuery(nextReply);
          }
        } catch (err) {
          console.error("Skill agent loop error:", err);
        }
      } else {
        replyText = "Hello there!";
        State.appendMessageToSession(originSessionId, { id: nextId++, role: "assistant", content: replyText });
      }

      if (isViewingOrigin()) {
        State.stateOverride = null;
        State.droppedFile = null;
        State.promptContext = null;
        Sound.play("finish");
      }
    } catch (err) {
      if (isViewingOrigin()) {
        State.stateOverride = null;
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        State.view = "note";
        Sound.play("error");
      }
      State.appendMessageToSession(originSessionId, { id: nextId++, role: "assistant", content: `❌ Hata: ${String(err)}` });
    } finally {
      busySessions.delete(originSessionId);
      liveTextBySession.delete(originSessionId);
      abortControllers.delete(originSessionId);
      updateSendButton();
      if (isViewingOrigin()) {
        activeDots?.remove();
        log.querySelector(".typing")?.parentElement?.remove();
        log.querySelector(".live-reply")?.parentElement?.remove();
        State.stateOverride = null;
        drawModelButton();
        input.disabled = isCurrentBusy();
        State.notify();
        onHeightChange();
        scrollToBottom();
        if (!isCurrentBusy()) input.focus();
      }
    }
  }

  send.addEventListener("click", () => {
    if (isCurrentBusy()) {
      stopPrompt(State.activeSessionId || undefined);
    } else {
      void submit();
    }
  });
  input.addEventListener("input", () => {
    const val = input.value;
    if (val.startsWith("/") && !val.includes(" ")) {
      renderSuggest(val);
    } else {
      closeSuggest();
    }
  });

  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (suggestBox.style.display !== "none" && activeMatches.length > 0) {
      if (key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        pickAndExecute(activeMatches[selectedSuggestIdx]);
        return;
      }
      if (key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        selectedSuggestIdx = (selectedSuggestIdx + 1) % activeMatches.length;
        renderSuggest(input.value);
        return;
      }
      if (key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        selectedSuggestIdx = (selectedSuggestIdx - 1 + activeMatches.length) % activeMatches.length;
        renderSuggest(input.value);
        return;
      }
      if (key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSuggest();
        return;
      }
      if (key === "Enter" && !input.value.includes(" ")) {
        const exact = activeMatches.find((m) => m.cmd === input.value.trim());
        if (!exact) {
          e.preventDefault();
          e.stopPropagation();
          pickAndExecute(activeMatches[selectedSuggestIdx]);
          return;
        }
      }
    }

    if (key === "Enter") {
      if (isCurrentBusy()) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      closeSuggest();
      void submit();
    } else if (key === "Escape" && isCurrentBusy()) {
      e.preventDefault();
      stopPrompt(State.activeSessionId || undefined);
    } else if (key === "Escape" && isSessionsOpen) {
      e.preventDefault();
      closeSessionsPanel();
    } else if (key === "Escape" && picker.isOpen) {
      e.preventDefault();
      picker.close();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  let lastRenderedSessionId: string | null = null;
  return {
    el,
    sync() {
      const file = State.droppedFile;
      const fileChip = file?.name ?? "";
      const tabChip = State.activeTabContext ?? "";
      const isTestMode = State.settings.autonomousVisualLoop === true;
      const chipKey = `${fileChip}|${tabChip}|${isTestMode}`;

      if (chipRow.dataset.key !== chipKey) {
        chipRow.dataset.key = chipKey;
        clear(chipRow);
        if (isTestMode) {
          const testChipEl = h(
            "div",
            {
              class: "chip test-mode-chip",
              style: "display:inline-flex;align-items:center;gap:6px;background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.3);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;margin-right:6px;",
              title: "Otonom Test Modu Aktif: Omi işlemlerin yapıldığını ekran görüntüleriyle doğrular.",
            },
            h("span", { text: "🎯 Test Modu (Görsel Doğrulama)" }),
            h(
              "button",
              {
                class: "link-btn",
                title: "Test Modunu Kapat",
                style: "border:none;background:none;color:#22c55e;cursor:pointer;padding:0 2px;font-size:11px;font-weight:700;line-height:1;",
                onclick: (e: Event) => {
                  e.stopPropagation();
                  State.settings.autonomousVisualLoop = false;
                  void Bridge.saveSettings(State.settings);
                  Sound.play("blip");
                  State.notify();
                  onHeightChange();
                },
              },
              "✕",
            ),
          );
          chipRow.append(testChipEl);
        }
        if (fileChip) {
          chipRow.append(
            contextChip(
              fileChip,
              () => {
                State.droppedFile = null;
                State.promptContext = null;
                if (State.stateOverride === "thinking") {
                  State.stateOverride = null;
                }
                Sound.play("blip");
                State.notify();
                onHeightChange();
              },
              () => {
                actions?.setView?.("snip");
              },
            ),
          );
        }
        if (tabChip) {
          const tabChipEl = h(
            "div",
            {
              class: "chip tab-context-chip",
              style: "display:inline-flex;align-items:center;gap:6px;background:rgba(56,189,248,0.14);color:#38bdf8;border:1px solid rgba(56,189,248,0.3);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:6px;",
            },
            h("span", { text: "🌐 Sekme:" }),
            h("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#FFFFFF;", text: tabChip }),
            h(
              "button",
              {
                class: "link-btn",
                title: "Bağlamı Kaldır",
                style: "border:none;background:none;color:#38bdf8;cursor:pointer;padding:0 2px;font-size:11px;font-weight:700;line-height:1;",
                onclick: (e: Event) => {
                  e.stopPropagation();
                  State.activeTabContext = null;
                  if (State.stateOverride === "thinking") {
                    State.stateOverride = null;
                  }
                  Sound.play("blip");
                  State.notify();
                  onHeightChange();
                },
              },
              "✕",
            ),
          );
          chipRow.append(tabChipEl);
        }
      }

      if (State.activeTabContext) {
        input.placeholder = `"${State.activeTabContext}" hakkında sor veya yaptır...`;
      } else if (!input.placeholder || input.placeholder.includes("hakkında")) {
        input.placeholder = t(STRINGS.placeholderFirst);
      }
      const thinking = isCurrentBusy();
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      const sessionChanged = State.activeSessionId !== lastRenderedSessionId;
      if (sessionChanged) {
        lastRenderedSessionId = State.activeSessionId;
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) {
          log.append(bubble(m));
        }
        const activeLiveText = State.activeSessionId ? liveTextBySession.get(State.activeSessionId) : null;
        if (activeLiveText) {
          const liveEl = h("div", { class: "reply live-reply" });
          renderMarkdown(liveEl, activeLiveText);
          log.append(h("div", { class: "chat-row" }, liveEl));
        } else if (thinking) {
          log.append(typingDots());
        }
        scrollToBottom();
      } else if (count !== renderedCount) {
        renderedCount = count;
        log.querySelector(".live-reply")?.closest(".chat-row")?.remove();
        log.querySelector(".typing")?.closest(".chat-row")?.remove();

        const renderedIds = new Set<number>();
        log.querySelectorAll(".chat-row[data-msg-id]").forEach((r) => {
          const id = Number(r.getAttribute("data-msg-id"));
          if (!isNaN(id)) renderedIds.add(id);
        });

        let appended = false;
        for (const m of State.chatHistory) {
          if (!renderedIds.has(m.id)) {
            log.append(bubble(m));
            appended = true;
          }
        }

        const activeLiveText = State.activeSessionId ? liveTextBySession.get(State.activeSessionId) : null;
        if (activeLiveText) {
          const liveEl = h("div", { class: "reply live-reply" });
          renderMarkdown(liveEl, activeLiveText);
          log.append(h("div", { class: "chat-row" }, liveEl));
          appended = true;
        } else if (thinking) {
          log.append(typingDots());
          appended = true;
        }

        if (appended) {
          scrollToBottom();
        }
      }

      updateSessionsBtnState();
      // Leaving the chat folds the picker and sessions panel away.
      if (State.view !== "prompt") {
        if (picker.isOpen) {
          picker.close();
          State.pickerOpen = false;
        }
        if (isSessionsOpen) {
          closeSessionsPanel();
        }
      }
      drawModelButton();
      updateSendButton();
      input.placeholder = t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
