// The Coucou window (settings.html): Flow dictation, the Notetaker and, under
// Notch, every setting of the island — the place where anything that writes to
// disk is confirmed. The window's frame and the Flow pages live in ../hub; the
// island's settings are drawn here, one Notch page at a time.

import "./settings.css";
import { Bridge, onEvent, type AntigravityAccount, type HookPreview, type HookStatus, type ShortcutsReport } from "../core/bridge";
import { CUSTOM_SERVER_KEY, providerDef, urlExposure } from "../core/providers";
import {
  ISLAND_SHORTCUTS, SHORTCUTS, SHORTCUT_TEXT, activeKeys, displayKeys, duplicates, effective,
  recordPress, type Binding,
} from "../core/shortcuts";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { FlowBridge } from "../core/flow";
import { SOUND_NAMES } from "../core/sound";
import {
  MAX_DECLARED, PILL_CATEGORIES, availablePills, chooseMainPill, isComingSoon, mainPillChoices,
  sanitizeDeclared, toggleDeclared, type PillDefinition,
} from "../core/pills";
import { h, clear } from "../views/dom";
import { startHub, type PageId } from "../hub/shell";
import { FLOW_PAGE_RENDERERS } from "../hub/pages";
import { agentsSection } from "./agents";
import { colorDot } from "./colors";
import { renderDiff, statusDot } from "./parts";
import {
  LANGUAGES, N_, isRtl, onLanguageChange, resolveLanguage, setLanguage, systemLanguages, t, tn,
} from "../i18n/i18n";

/** Where secrets.rs keeps the keys on this OS. */
const KEY_STORE = navigator.userAgent.includes("Windows")
  ? "Windows Credential Manager"
  : "Secret Service (GNOME Keyring, KWallet)";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const windowRoot = document.getElementById("hub")!;
/** Where the Notch page being shown draws its sections. */
let root: HTMLElement = windowRoot;
let hub: { navigate(page: PageId): void; redraw(): void; current(): PageId } | null = null;

async function save() {
  await Bridge.saveSettings(settings);
}
export function pickColor(next: Record<string, string>) {
  settings.pillColors = next;
  void save();
}



// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

// ── Changes to Claude Code's settings.json ────────────────────────────────────

/** One kind of change to ~/.claude/settings.json, with the words that go with it. */
interface Change {
  preview: (install: boolean) => Promise<HookPreview | null>;
  apply: (install: boolean, fingerprint: string) => Promise<string | null>;
  installText: string;
  removeText: string;
  installButton: string;
  removeButton: string;
  /** The note once written; `backup` is "" when there was no file to back up. */
  done: (backup: string) => string;
}

const HOOKS_CHANGE: Change = {
  preview: Bridge.hooksPreview,
  apply: Bridge.hooksApply,
  get installText() { return t("This is exactly what will change in your settings.json. Your own hooks are left untouched."); },
  get removeText() { return t("This removes Omi's entries only. Your own hooks are left untouched."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. Open a new Claude Code session to pick the hooks up.", { backup })
    : t("Done. Open a new Claude Code session to pick the hooks up."),
};

const STATUS_LINE_CHANGE: Change = {
  preview: Bridge.statusLinePreview,
  apply: Bridge.statusLineApply,
  get installText() { return t("This is exactly what will change: only the status line. If you already have one it keeps working, Omi's relay runs it for you."); },
  get removeText() { return t("This puts your previous status line back, or removes the entry if there was none."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. The numbers appear after the next reply of a Claude Code session.", { backup })
    : t("Done. The numbers appear after the next reply of a Claude Code session."),
};

/**
 * Shows the diff of a change in `body` and writes it only after an explicit
 * click, and only if settings.json still matches the diff that was shown.
 * `back` redraws the section; `applied` runs a moment after a successful write.
 */
async function reviewChange(
  body: HTMLElement,
  change: Change,
  install: boolean,
  back: () => void,
  applied: () => void,
) {
  let preview;
  try {
    preview = await change.preview(install);
  } catch (err) {
    // An unreadable or invalid settings.json stops here rather than being
    // treated as empty and written over.
    clear(body);
    body.append(
      h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
      h("div", { class: "row" }, h("button", { text: t("Back"), onclick: back })),
    );
    return;
  }
  if (!preview) return;
  clear(body);
  body.append(
    h("div", { class: "hint", text: install ? change.installText : change.removeText }),
    renderDiff(preview.diff),
    h("div", { class: "row" },
      h("span", {
        class: "path",
        text: preview.backup
          ? t("Backup → {path}", { path: preview.backup })
          : t("No settings.json yet — nothing to back up."),
      }),
    ),
  );
  const confirm = h("button", {
    class: install ? "primary" : "danger",
    text: install ? change.installButton : change.removeButton,
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      const backup = await change.apply(install, preview.fingerprint);
      clear(body);
      body.append(h("div", { class: "notice ok", text: change.done(backup ?? "") }));
      window.setTimeout(applied, 2600);
    } catch (err) {
      confirm.disabled = false;
      body.append(h("div", { class: "notice err", text: t("Could not write: {error}", { error: String(err) }) }));
    }
  });
  body.append(h("div", { class: "row" }, confirm, h("button", { text: t("Cancel"), onclick: back })));
}

// ── Claude Code section ───────────────────────────────────────────────────────

export function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    redraw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? t("Omi is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.")
          : t("Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing."),
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: t("coucou-hook.exe is not in place yet. Restart Omi; if it still fails, build it with `cargo build -p coucou-hook`."),
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? t("Reinstall hooks…") : t("Install hooks…"),
      onclick: () => void reviewChange(body, HOOKS_CHANGE, true, redraw, () => void rebuild()),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = t("The relay isn't installed yet.");
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: t("Uninstall hooks…"),
        onclick: () => void reviewChange(body, HOOKS_CHANGE, false, redraw, () => void rebuild()),
      }));
    }
    body.append(actions);
  }

  draw();
  return section;
}

// ── Plan usage section ────────────────────────────────────────────────────────

/**
 * The 5-hour and weekly limits in the island's header. They come from Claude
 * Code's status line, so the relay has to be the status line first: turning the
 * switch on without it starts the install, and the switch only stays on once
 * that has been confirmed. A status line the user had keeps working.
 */
const PLAN_SETTINGS_TEXT = {
  get claude() { return t("Shows your Claude plan usage (5-hour and weekly limits) in the island's header. Omi adds a status line relay in ~/.claude/settings.json. If you already have a status line, it keeps working as before. Pro and Max plans only."); },
  get claudeCli() { return t("The numbers come from the Claude Code command-line tool. The Claude desktop app does not report them, so the gauge stays empty if you only use the desktop app."); },
  get showClaude() { return t("Show in notch"); },
  get codex() { return t("Shows your Codex plan usage (weekly limit and free resets left) in the island's header. Omi asks the Codex CLI (codex app-server) when the pill shows; nothing is installed. Codex must be signed in with ChatGPT."); },
  get showCodex() { return t("Show Codex plan in the notch"); },
};

export function planSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h("section", {}, h("h2", {}, h("span", { text: t("Plan usage") })), body);

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    settings.planRelayInstalled = status.planRelayInstalled;
    // Cancelled or failed: a switch that was waiting for the install falls back.
    if (!status.planRelayInstalled) settings.showPlanInNotch = false;
    redraw();
  };

  function draw() {
    // The switch shows "on" while the install it asked for is being reviewed.
    const sw = toggle(settings.showPlanInNotch, (on) => {
      if (!on) {
        settings.showPlanInNotch = false;
        void save();
      } else if (status.planRelayInstalled) {
        settings.showPlanInNotch = true;
        void save();
      } else {
        // Turned on before the relay is in: install it first; it stays on once confirmed.
        void reviewChange(body, STATUS_LINE_CHANGE, true, () => void rebuild(), () => {
          settings.planRelayInstalled = true;
          settings.showPlanInNotch = true;
          void save().then(rebuild);
        });
      }
    });
    body.append(
      h("div", {
        class: "hint",
        text: PLAN_SETTINGS_TEXT.claude,
      }),
      h("div", { class: "hint", text: PLAN_SETTINGS_TEXT.claudeCli }),
      h("div", { class: "row" }, h("label", { text: PLAN_SETTINGS_TEXT.showClaude }), sw),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        statusDot(status.planRelayInstalled),
        h("span", { class: "hint", text: status.planRelayInstalled ? t("installed") : t("not installed") }),
        status.planRelayInstalled
          ? h("button", {
              class: "danger",
              text: t("Uninstall relay…"),
              onclick: () => void reviewChange(body, STATUS_LINE_CHANGE, false, redraw, () => void rebuild()),
            })
          : h("button", {
              class: "primary",
              text: t("Install relay…"),
              onclick: () => void reviewChange(body, STATUS_LINE_CHANGE, true, redraw, () => void rebuild()),
            }),
      ),
      // Codex: nothing to install, Coucou asks the Codex CLI when the pill shows.
      h("div", { class: "hint", text: PLAN_SETTINGS_TEXT.codex }),
      h("div", { class: "row" },
        h("label", { text: PLAN_SETTINGS_TEXT.showCodex }),
        toggle(settings.showCodexPlanInNotch, (on) => {
          settings.showCodexPlanInNotch = on;
          void save();
        }),
      ),
    );
  }

  draw();
  return section;
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

export function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? t("Key saved in the {store}.", { store: KEY_STORE }) : t("No key yet — the chat needs one.") });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? `••••••••••••  ${t("(stored)")}` : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: t("Save key") });
  const clearBtn = h("button", { class: "danger", text: t("Remove") });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? t("Key saved in the {store}.", { store: KEY_STORE })
      : t("No key yet — the chat needs one.");
    field.placeholder = present ? `••••••••••••  ${t("(stored)")}` : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: t("Saved. It never touches disk.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: t("Could not save: {error}", { error: String(err) }) }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: t("Key removed.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: t("Could not remove: {error}", { error: String(err) }) }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: t("API key") }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: t("Model") }), model),
    feedback,
  );
}

// ── Active pills section ──────────────────────────────────────────────────────

/**
 * The tools you use (Mac 0.1.1–0.1.2): pick the main workspace tool, which is
 * always on and takes no slot, and declare the agents and chat providers you
 * want as pills. Services are declared in Integrations below, next to their keys.
 */
export function activePillsSection(connected: Record<string, boolean>): HTMLElement {
  const slots = h("div", { class: "hint" });
  const main = h("select", {}) as HTMLSelectElement;
  for (const def of mainPillChoices()) main.append(h("option", { value: def.id, text: def.name }));
  main.addEventListener("change", () => {
    const next = chooseMainPill(settings, main.value);
    if (!next) return;
    settings.mainPill = next.mainPill;
    settings.activeIntegrations = next.activeIntegrations;
    declaredChanged();
  });
  const groups = h("div", { style: "display:flex;flex-direction:column;gap:12px" });

  /** Why a pill would show nothing yet, as on the Mac's row. */
  function hint(def: PillDefinition): string | null {
    if (isComingSoon(def.id)) return t("Coming soon");
    if (def.id === "agent_antigravity") return null;
    if (def.connect.kind === "hooks" && !connected[def.id]) return t("Hooks not installed");
    if (def.connect.kind === "key" && !connected[def.id]) return t("Key not configured");
    if (def.connect.kind === "server" && !settings[def.connect.field]) return t("Not connected");
    return null;
  }

  function row(def: PillDefinition): HTMLElement {
    const isMain = def.id === settings.mainPill;
    const on = settings.activeIntegrations.includes(def.id);
    const full = !isMain && !on && settings.activeIntegrations.length >= MAX_ACTIVE;
    const el = h("div", { class: full ? "pill-row full" : "pill-row" },
      colorDot(def, "width:10px;height:10px", () => settings.pillColors, pickColor),
      h("span", { class: "name", text: def.name }),
    );
    if (isMain) {
      el.append(h("span", { class: "state", text: t("Main") }));
      return el;
    }
    const why = hint(def);
    if (def.id === "agent_antigravity") {
      const accBadge = h("span", {
        class: "state",
        style: "color:#22c55e;cursor:pointer;font-size:11px;margin-right:6px;",
        text: "Google Girişi",
        onclick: (e: Event) => {
          e.stopPropagation();
          hub?.navigate("general");
        },
      });
      void Bridge.antigravityAccounts().then((accs) => {
        const active = accs.find((a) => a.active);
        accBadge.textContent = active ? active.email.split("@")[0] : "Google ile Giriş Yap";
        accBadge.style.color = active ? "#22c55e" : "#f59e0b";
      });
      el.append(accBadge);
    } else {
      el.append(h("span", { class: "state", text: why ?? "" }));
    }
    const sw = h("button", { class: on ? "switch on" : "switch" }) as HTMLButtonElement;
    sw.disabled = full;
    sw.addEventListener("click", () => {
      const next = toggleDeclared(settings, def.id);
      if (!next) return;
      settings.activeIntegrations = next;
      declaredChanged();
    });
    el.append(sw);
    return el;
  }

  function draw() {
    const used = settings.activeIntegrations.length;
    slots.textContent = t("{used}/{max} slots in use — the main tool doesn't take one.", { used, max: MAX_ACTIVE });
    slots.classList.toggle("full", used >= MAX_ACTIVE);
    main.value = settings.mainPill;
    clear(groups);
    for (const cat of PILL_CATEGORIES) {
      if (cat.id === "service") continue;
      const pills = availablePills().filter((p) => p.category === cat.id);
      if (pills.length === 0) continue;
      groups.append(h("div", { class: "pill-group" }, h("h3", { text: t(cat.title) }), ...pills.map(row)));
    }
  }
  declaredViews.push(draw);
  draw();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Active pills") })),
    h("div", { class: "hint", text: t("Choose the tools you use. Omi only shows what you declare here.") }),
    slots,
    h("div", { class: "row" }, h("label", { text: t("Main tool") }), main),
    groups,
  );
}

// ── Google Antigravity Section (OMP OAuth) ──────────────────────────────────

function antigravitySection(accounts: AntigravityAccount[]): HTMLElement {
  const section = h("section", {});
  const hasActive = accounts.some((a) => a.active);
  const dot = statusDot(hasActive);

  const isEnabled = settings.chatProvider === "google-antigravity" || settings.activeIntegrations.includes("agent_antigravity");
  const sw = toggle(isEnabled, (v) => {
    if (v) {
      if (!settings.activeIntegrations.includes("agent_antigravity")) {
        settings.activeIntegrations = [...settings.activeIntegrations, "agent_antigravity"];
      }
      settings.chatProvider = "google-antigravity";
      settings.chatModels["google-antigravity"] = "gemini-2.5-flash";
    } else {
      settings.activeIntegrations = settings.activeIntegrations.filter((id) => id !== "agent_antigravity");
      if (settings.chatProvider === "google-antigravity") {
        settings.chatProvider = "anthropic";
      }
    }
    declaredChanged();
    void save();
    void rerender();
  });

  const header = h("h2", {},
    dot,
    h("span", { text: "Google Antigravity" }),
    h("div", { class: "grow" }),
    sw,
  );
  const hint = h("div", {
    class: "hint",
    text: "API Key gerektirmez. Google OAuth ile doğrudan yetkilendirilir ve bağımsız olarak kullanılır.",
  });

  const loginBtn = h("button", {
    class: "primary",
    text: "Google ile Giriş Yap",
    style: "display:inline-flex;align-items:center;gap:6px;",
  }) as HTMLButtonElement;

  const refreshBtn = h("button", {
    text: "Yenile",
    style: "display:inline-flex;align-items:center;gap:6px;",
  });

  const importInput = h("input", {
    type: "file",
    accept: ".json",
    style: "display:none;",
  }) as HTMLInputElement;

  const importBtn = h("button", {
    text: "JSON İçe Aktar",
    style: "display:inline-flex;align-items:center;gap:6px;",
    onclick: () => importInput.click(),
  });

  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    clear(feedback);
    feedback.append(h("div", { class: "notice", text: `${file.name} okunuyor...` }));
    try {
      const text = await file.text();
      const count = await Bridge.antigravityImportJson(text);
      feedback.replaceChildren(h("div", { class: "notice ok", text: `✓ ${count} adet Google Antigravity hesabı başarıyla içe aktarıldı!` }));
      await rerender();
    } catch (err) {
      feedback.replaceChildren(h("div", { class: "notice err", text: `İçe aktarma hatası: ${String(err)}` }));
    } finally {
      importInput.value = "";
    }
  });

  const exportBtn = h("button", {
    text: "JSON Dışa Aktar",
    style: "display:inline-flex;align-items:center;gap:6px;",
  });

  exportBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      const chosenPath = await Bridge.antigravityExportDialog();
      if (chosenPath) {
        feedback.replaceChildren(h("div", { class: "notice ok", text: `✓ Hesaplar başarıyla dışa aktarıldı: ${chosenPath}` }));
      }
    } catch (err) {
      feedback.replaceChildren(h("div", { class: "notice err", text: `Dışa aktarma hatası: ${String(err)}` }));
    }
  });

  const feedback = h("div", { style: "margin-top:8px" });

  loginBtn.addEventListener("click", async () => {
    loginBtn.disabled = true;
    loginBtn.textContent = "Tarayıcıda onay bekleniyor...";
    clear(feedback);
    feedback.append(h("div", { class: "notice", text: "Google yetkilendirme penceresi tarayıcınızda açıldı. Lütfen hesabınızı seçip onaylayın..." }));
    try {
      const email = await Bridge.antigravityLogin();
      settings.chatProvider = "google-antigravity";
      settings.chatModels["google-antigravity"] = "gemini-2.5-flash";
      await save();
      feedback.replaceChildren(h("div", { class: "notice ok", text: `✓ Giriş başarılı: ${email} aktif edildi.` }));
      await rerender();
    } catch (err) {
      feedback.replaceChildren(h("div", { class: "notice err", text: `Giriş başarısız: ${String(err)}` }));
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = "Google ile Giriş Yap";
    }
  });

  refreshBtn.addEventListener("click", () => {
    void rerender();
  });

  const buttonRow = h("div", { class: "row", style: "gap:8px;margin-bottom:12px;flex-wrap:wrap;" },
    loginBtn, refreshBtn, importBtn, exportBtn, importInput
  );

  // Drag-and-drop JSON file support onto section
  section.addEventListener("dragover", (e) => {
    e.preventDefault();
    section.style.outline = "2px dashed #2dd4bf";
    section.style.outlineOffset = "4px";
  });
  section.addEventListener("dragleave", () => {
    section.style.outline = "none";
  });
  section.addEventListener("drop", async (e) => {
    e.preventDefault();
    section.style.outline = "none";
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.name.endsWith(".json")) return;
    clear(feedback);
    feedback.append(h("div", { class: "notice", text: `${file.name} içe aktarılıyor...` }));
    try {
      const text = await file.text();
      const count = await Bridge.antigravityImportJson(text);
      feedback.replaceChildren(h("div", { class: "notice ok", text: `✓ ${count} adet hesap başarıyla içe aktarıldı!` }));
      await rerender();
    } catch (err) {
      feedback.replaceChildren(h("div", { class: "notice err", text: `İçe aktarma hatası: ${String(err)}` }));
    }
  });

  const accountsContainer = h("div", { style: "display:flex;flex-direction:column;gap:6px;margin-top:10px" });
  if (accounts.length === 0) {
    accountsContainer.append(h("div", { class: "hint", text: "Henüz bağlı Google hesabı bulunamadı. 'Google ile Giriş Yap' butonuna tıklayarak hesabınızı ekleyebilirsiniz." }));
  } else {
    const activeAcc = accounts.find((a) => a.active);
    const label = h("div", { style: "font-size:12px;color:var(--text-dim, #888);margin-bottom:4px" },
      h("strong", { text: `Bağlı Google Hesapları (${accounts.length}): ` }),
      activeAcc ? h("span", { text: `Aktif: ${activeAcc.email}` }) : null
    );
    accountsContainer.append(label);

    const select = h("select", { style: "width:100%;max-width:400px;padding:6px 10px;border-radius:6px;background:rgba(255,255,255,0.06);color:inherit;border:1px solid rgba(255,255,255,0.12)" }) as HTMLSelectElement;
    for (const acc of accounts) {
      const opt = h("option", {
        value: String(acc.id),
        text: `${acc.email}${acc.active ? " (✓ Aktif)" : ""}`,
      }) as HTMLOptionElement;
      if (acc.active) opt.selected = true;
      select.append(opt);
    }

    select.addEventListener("change", async () => {
      const targetId = Number(select.value);
      try {
        await Bridge.antigravitySwitch(targetId);
        settings.chatProvider = "google-antigravity";
        settings.chatModels["google-antigravity"] = "gemini-2.5-flash";
        await save();
        feedback.replaceChildren(h("div", { class: "notice ok", text: "Aktif hesap değiştirildi ve Antigravity seçildi." }));
        await rerender();
      } catch (err) {
        feedback.replaceChildren(h("div", { class: "notice err", text: `Hesap değiştirilemedi: ${String(err)}` }));
      }
    });

    accountsContainer.append(h("div", { class: "row" }, h("label", { text: "Aktif Hesap" }), select));

    const autoRotateToggle = toggle(settings.antigravityAutoRotate ?? true, (v) => {
      settings.antigravityAutoRotate = v;
      void save();
    });

    const rotateRow = h("div", { class: "row", style: "margin-top:6px;align-items:center;" },
      h("label", { text: "Otomatik Hesap Rotasyonu" }),
      autoRotateToggle,
      h("span", { class: "hint", text: "Aktif hesabın kotası veya istek limiti (429) dolunca otomatik sıradaki hesaba geçer." }),
    );
    accountsContainer.append(rotateRow);
  }

  section.append(header, hint, buttonRow, accountsContainer, feedback);
  return section;
}

// ── Chat providers section ────────────────────────────────────────────────────

const CHAT_STRINGS = {
  get providersTitle() { return t("Chat providers"); },
  get providersHint() { return t("Chat with Google AI, OpenAI or OpenRouter instead of Claude: add a key here, then click the model name above the chat box to switch provider and model. Keys stay in the system keychain. These providers get no web search and no tools: they can answer, never act on this computer."); },
  get stored() { return `••••••••  ${t("(stored)")}`; },
  get save() { return t("Save"); },
  get remove() { return t("Remove"); },
  get localTitle() { return t("Local models"); },
  get localHint() { return t("Chat with a model you run yourself: Ollama or LM Studio (leave the address empty for the usual one on this computer), or any server that speaks the OpenAI API, such as vLLM or llama.cpp. Once connected, pick it above the chat box."); },
  get connect() { return t("Connect"); },
  get connecting() { return t("Connecting…"); },
  get disconnect() { return t("Disconnect"); },
  get useInChat() { return t("Use in chat"); },
  get inUse() { return t("In use"); },
  get keyOptional() { return t("API key (optional)"); },
  get localOnly() { return t("Nothing leaves your PC: the server runs on this computer."); },
  get remote() { return t("This address is another machine: what you ask is sent to it."); },
  get remoteHttp() { return t("This address is another machine, over plain http: what you ask travels unencrypted."); },
  get keyOverHttp() { return t("Warning: the key would be sent unencrypted (http://) to another machine. Use https://, or a server on this computer."); },
  get invalid() { return t("Not a valid http:// or https:// address."); },
  noModels: (name: string) => t("No models yet. Download one in {name} first.", { name }),
  models: (n: number) => tn("{count} model", "{count} models", n),
};

interface CloudDef {
  id: "google" | "openai" | "openrouter";
  name: string;
  placeholder: string;
  where: string;
}

const CLOUD: CloudDef[] = [
  { id: "google", name: "Google AI", placeholder: "AIza…", where: "aistudio.google.com" },
  { id: "openai", name: "OpenAI", placeholder: "sk-…", where: "platform.openai.com" },
  { id: "openrouter", name: "OpenRouter", placeholder: "sk-or-…", where: "openrouter.ai/keys" },
];

export function chatProvidersSection(
  present: Record<string, boolean>,
  keyChanged: (key: string, on: boolean) => void,
): HTMLElement {
  const list = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
  for (const def of CLOUD) {
    const p = providerDef(def.id);
    const key = p.key!;
    const input = h("input", {
      type: "password",
      placeholder: present[key] ? CHAT_STRINGS.stored : def.placeholder,
      autocomplete: "off",
      spellcheck: "false",
      style: "flex:1 1 auto;min-width:0",
    }) as HTMLInputElement;
    const dotEl = statusDot(present[key] ?? false);
    const saveBtn = h("button", { text: CHAT_STRINGS.save });
    const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
    const refresh = () => {
      input.placeholder = present[key] ? CHAT_STRINGS.stored : def.placeholder;
      dotEl.style.background = present[key] ? "#22c55e" : "#f4505e";
      removeBtn.style.display = present[key] ? "" : "none";
    };
    saveBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) return;
      try {
        await Bridge.secretSet(key, value);
        present[key] = true;
        input.value = "";
        keyChanged(key, true);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    removeBtn.addEventListener("click", async () => {
      try {
        await Bridge.secretClear(key);
        present[key] = false;
        keyChanged(key, false);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    refresh();
    let oauthBtn: HTMLElement | null = null;
    if (def.id === "google") {
      const btn = h("button", {
        class: "secondary",
        style: "font-size:11px;padding:3px 8px;white-space:nowrap;",
        text: "OAuth ile Giriş",
        title: "Google OAuth ile doğrudan bağlan (API Key gerektirmez)",
      });
      btn.addEventListener("click", async () => {
        try {
          btn.textContent = "Giriş yapılıyor...";
          await Bridge.antigravityLogin();
          settings.chatProvider = "google-antigravity";
          settings.chatModels["google-antigravity"] = "gemini-2.5-flash";
          void save();
          await rerender();
        } catch {
          btn.textContent = "OAuth ile Giriş";
        }
      });
      oauthBtn = btn;
    }

    list.append(
      h("div", { class: "row" },
        h("label", {},
          h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }),
          h("span", { text: def.name }),
        ),
        input, saveBtn, ...(oauthBtn ? [oauthBtn] : []), removeBtn, dotEl,
      ),
      h("div", { class: "hint", style: "margin:-4px 0 0 144px", text: def.id === "google" ? t("API Key veya doğrudan Google OAuth ile giriş yapabilirsiniz.") : t("Key from {site}", { site: def.where }) }),
    );
  }
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: CHAT_STRINGS.providersTitle })),
    h("div", { class: "hint", text: CHAT_STRINGS.providersHint }),
    list,
  );
}

// ── Local models section ──────────────────────────────────────────────────────

type LocalId = "ollama" | "lmstudio" | "custom";

/** Redraws the local models section after a change made elsewhere (the island). */
let localRedraw: (() => void) | null = null;

const LOCAL: Record<LocalId, { name: string; usual: string }> = {
  ollama: { name: "Ollama", usual: "http://127.0.0.1:11434" },
  lmstudio: { name: "LM Studio", usual: "http://127.0.0.1:1234" },
  // No usual address: any server that speaks the OpenAI API.
  custom: { name: N_("OpenAI-compatible"), usual: "" },
};

/** What an address means for the user's data, as a hint line. */
function exposureNotice(url: string, withKey: boolean): HTMLElement | null {
  switch (urlExposure(url)) {
    case "local":
      return h("div", { class: "hint", text: CHAT_STRINGS.localOnly });
    case "remote":
      return h("div", { class: "hint", text: CHAT_STRINGS.remote });
    case "remote-http":
      return withKey
        ? h("div", { class: "notice warn", text: CHAT_STRINGS.keyOverHttp })
        : h("div", { class: "hint", text: CHAT_STRINGS.remoteHttp });
    case "invalid":
      return url.trim() ? h("div", { class: "notice err", text: CHAT_STRINGS.invalid }) : null;
  }
}

function localSection(customKey: boolean): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: CHAT_STRINGS.localTitle })),
    h("div", { class: "hint", text: CHAT_STRINGS.localHint }),
    body,
  );
  const redraw = () => {
    clear(body);
    for (const id of Object.keys(LOCAL) as LocalId[]) body.append(serverBlock(id));
  };

  function serverBlock(id: LocalId): HTMLElement {
    const def = LOCAL[id];
    const p = providerDef(id);
    const field = p.urlField!;
    const connected = settings[field] !== "";
    const status = h("div", {});
    const exposure = h("div", {});
    const label = h("label", {},
      h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }),
      h("span", { text: t(def.name) }),
    );
    const block = h("div", { style: "display:flex;flex-direction:column;gap:6px" });

    if (connected) {
      const inUse = settings.chatProvider === id;
      const use = h("button", { class: inUse ? "" : "primary", text: inUse ? CHAT_STRINGS.inUse : CHAT_STRINGS.useInChat });
      use.disabled = inUse;
      use.addEventListener("click", () => {
        settings.chatProvider = id;
        void save().then(redraw);
      });
      const disconnect = h("button", { class: "danger", text: CHAT_STRINGS.disconnect });
      disconnect.addEventListener("click", async () => {
        settings[field] = "";
        if (settings.chatProvider === id) settings.chatProvider = "anthropic";
        if (id === "custom") {
          await Bridge.secretClear(CUSTOM_SERVER_KEY).catch(() => {});
          customKey = false;
        }
        await save();
        redraw();
      });
      block.append(
        h("div", { class: "row" }, label, h("span", { class: "path", text: settings[field] }), statusDot(true), use, disconnect),
        status,
      );
      exposure.append(exposureNotice(settings[field], id === "custom" && customKey) ?? "");
      block.append(exposure);
      return block;
    }

    const input = h("input", {
      type: "text",
      placeholder: def.usual || "https://llm.example.com",
      style: "flex:1 1 auto;min-width:0",
      spellcheck: "false",
      autocomplete: "off",
    }) as HTMLInputElement;
    // A custom server may want a key; it goes to the keychain, never to settings.json.
    const key = h("input", {
      type: "password",
      placeholder: customKey ? CHAT_STRINGS.stored : CHAT_STRINGS.keyOptional,
      style: "flex:1 1 auto;min-width:0",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const connect = h("button", { class: "primary", text: CHAT_STRINGS.connect });

    const showExposure = () => {
      clear(exposure);
      const withKey = id === "custom" && (customKey || key.value.trim() !== "");
      const notice = exposureNotice(input.value || def.usual, withKey);
      if (notice) exposure.append(notice);
    };
    input.addEventListener("input", showExposure);
    key.addEventListener("input", showExposure);

    connect.addEventListener("click", async () => {
      connect.disabled = true;
      clear(status);
      status.append(h("div", { class: "hint", text: CHAT_STRINGS.connecting }));
      try {
        if (id === "custom" && key.value.trim()) {
          // Stored with this address: the key is only ever sent there.
          await Bridge.localSetKey(input.value || def.usual, key.value.trim());
          key.value = "";
          customKey = true;
        }
        const server = await Bridge.localConnect(id, input.value);
        if (!server.models.length) {
          clear(status);
          status.append(h("div", { class: "notice err", text: CHAT_STRINGS.noModels(t(def.name)) }));
        } else {
          settings[field] = server.url;
          if (!server.models.includes(settings.chatModels[id] ?? "")) {
            settings.chatModels = { ...settings.chatModels, [id]: server.models[0] };
          }
          await save();
          redraw();
          return;
        }
      } catch (err) {
        clear(status);
        status.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
      }
      connect.disabled = false;
    });

    block.append(h("div", { class: "row" }, label, input, connect));
    if (id === "custom") block.append(h("div", { class: "row" }, h("label", { text: "" }), key));
    block.append(status, exposure);
    showExposure();
    return block;
  }

  redraw();
  localRedraw = redraw;
  return section;
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
  /** What the key needs, shown under its field. */
  hint?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "agent_antigravity", name: "Antigravity", color: "#E879F9",
    fields: [],
    hint: "Google Antigravity hesabı ile çalışır. Modeller ve hesap yönetimi Chat sekmesindedir." },
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: N_("Secret key"), placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: N_("Token"), placeholder: "ghp_…", secret: true }],
    hint: N_("Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions.") },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: N_("Token"), placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: N_("Instance URL"), placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: N_("API key"), placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: N_("API key"), placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: N_("Integration token"), placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: N_("API key"), placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = MAX_DECLARED;

/** Everything that shows the declared pills, redrawn when any of them changes. */
const declaredViews: (() => void)[] = [];

function declaredChanged() {
  for (const redraw of declaredViews) redraw();
  void save();
}

export function integrationsSection(present: Record<string, boolean>, connected: Record<string, boolean> = {}): HTMLElement {
  declaredViews.length = 0;
  const note = h("div", { class: "hint" });
  const container = h("div", { style: "display:flex;flex-direction:column;gap:18px" });

  const agentSwitches = new Map<string, HTMLButtonElement>();
  const serviceSwitches = new Map<string, HTMLButtonElement>();

  function updateAllSwitches() {
    const used = settings.activeIntegrations.length;
    note.textContent = t("Pick up to {max} pills to show next to Mochi — {used}/{max} in use. Keys are stored in the {store}, never on disk.", { max: MAX_ACTIVE, used, store: KEY_STORE });
    const isFull = used >= MAX_ACTIVE;

    for (const [id, sw] of agentSwitches) {
      const isMain = id === settings.mainPill;
      const active = isMain || settings.activeIntegrations.includes(id);
      sw.className = active ? "switch on" : "switch";
      sw.disabled = isMain || (!active && isFull);
    }

    for (const [id, sw] of serviceSwitches) {
      const active = settings.activeIntegrations.includes(id);
      sw.className = active ? "switch on" : "switch";
      sw.disabled = !active && isFull;
    }
  }
  declaredViews.push(updateAllSwitches);

  // ── 1. Coding Agents (Kodlama Ajanları & Asistanlar) ─────────────────────
  const agentTitle = h("h3", {
    style: "margin:8px 0 2px;font-size:12px;font-weight:700;color:var(--dim-2);text-transform:uppercase;letter-spacing:0.6px;",
    text: t("Coding Agents"),
  });
  const agentList = h("div", { style: "display:flex;flex-direction:column;gap:8px" });

  const agentPills = availablePills().filter(
    (p) => p.category === "agent" || (p.category === "workspace" && p.id !== "agent_antigravity"),
  );

  for (const def of agentPills) {
    const isMain = def.id === settings.mainPill;
    const on = isMain || settings.activeIntegrations.includes(def.id);
    const full = !isMain && !on && settings.activeIntegrations.length >= MAX_ACTIVE;
    const isHookInstalled = Boolean(connected[def.id]);

    const sw = h("button", {
      class: on ? "switch on" : "switch",
      disabled: isMain || (full && !on),
    }) as HTMLButtonElement;
    agentSwitches.set(def.id, sw);

    sw.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      if (isMain) return;
      const active = settings.activeIntegrations.includes(def.id);
      if (active) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      updateAllSwitches();
      declaredChanged();
    });

    const statusBadge = isMain
      ? h("span", {
          style: "font-size:11px;color:var(--dim-2);margin-left:auto;font-weight:500;",
          text: t("Main workspace tool"),
        })
      : isHookInstalled
      ? h("span", {
          style: "font-size:11.5px;color:#22c55e;margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-weight:500;",
        },
          statusDot(true),
          h("span", { text: t("Hooks installed") }),
        )
      : h("div", {
          style: "margin-left:auto;display:inline-flex;align-items:center;gap:6px;",
        },
          statusDot(false),
          h("span", { style: "font-size:11.5px;color:var(--dim-3);", text: t("Hooks not installed") }),
          h("button", {
            class: "secondary",
            style: "font-size:10.5px;padding:2px 8px;cursor:pointer;",
            text: t("Install…"),
            onclick: (e: Event) => {
              e.stopPropagation();
              hub?.navigate("agents");
            },
          }),
        );

    const row = h(
      "div",
      {
        class: full ? "pill-row full" : "pill-row",
        style: "display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(255,255,255,0.025);border-radius:8px;border:1px solid rgba(255,255,255,0.06);",
      },
      sw,
      colorDot(def, "width:10px;height:10px", () => settings.pillColors, pickColor),
      h("span", { style: "font-size:13px;font-weight:600;min-width:115px;", text: def.name }),
      statusBadge,
    );
    agentList.append(row);
  }

  // ── 2. Services & External Integrations ─────────────────────────────────
  const servicesTitle = h("h3", {
    style: "margin:14px 0 2px;font-size:12px;font-weight:700;color:var(--dim-2);text-transform:uppercase;letter-spacing:0.6px;",
    text: t("Services"),
  });
  const servicesList = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  const offered = new Set(availablePills().map((p) => p.id));
  for (const def of INTEGRATIONS.filter((d) => offered.has(d.id))) {
    const active = settings.activeIntegrations.includes(def.id);
    const full = !active && settings.activeIntegrations.length >= MAX_ACTIVE;
    const sw = h("button", { class: active ? "switch on" : "switch", disabled: full }) as HTMLButtonElement;
    serviceSwitches.set(def.id, sw);

    sw.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      const isOn = settings.activeIntegrations.includes(def.id);
      if (isOn) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      updateAllSwitches();
      declaredChanged();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? CHAT_STRINGS.stored : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: t("Save") });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? CHAT_STRINGS.stored : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: t(field.label) }),
          input, saveBtn, dotEl,
        ),
      );
    }

    if (def.id === "agent_antigravity") {
      const accRow = h("div", { class: "row", style: "align-items:center;gap:8px;" });
      const dotEl = statusDot(false);
      const accText = h("span", { style: "font-size:12px;color:var(--dim-2);", text: "Hesap kontrol ediliyor..." });
      const manageBtn = h("button", {
        class: "secondary",
        style: "font-size:11px;padding:3px 10px;margin-left:auto;",
        text: "Hesapları Yönet (Chat)",
        onclick: () => hub?.navigate("chat"),
      });
      void Bridge.antigravityAccounts().then((accs) => {
        const activeAcc = accs.find((a) => a.active);
        dotEl.style.background = activeAcc ? "#22c55e" : "#f59e0b";
        accText.textContent = activeAcc ? `Aktif Hesap: ${activeAcc.email}` : "Hesap bağlı değil";
      });
      accRow.append(dotEl, accText, manageBtn);
      rows.append(accRow);
    }
    if (def.hint) rows.append(h("div", { class: "hint", text: t(def.hint) }));

    servicesList.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          colorDot(def, "", () => settings.pillColors, pickColor),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  container.append(agentTitle, agentList, servicesTitle, servicesList);
  updateAllSwitches();
  return h("section", {}, h("h2", {}, h("span", { text: t("Integrations") })), note, container);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSections(): HTMLElement[] {
  // 1. Display & Behavior
  const autoClose = h("input", {
    type: "number", min: "0", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  const autoHint = h("span", {
    class: "hint",
    text: settings.autoCloseInterval <= 0 ? t("Off (stays open)") : t("seconds after you leave the island (0 = off)"),
  });
  autoClose.addEventListener("change", () => {
    const val = Number(autoClose.value);
    settings.autoCloseInterval = val <= 0 ? 0 : Math.max(5, Math.min(120, val || 15));
    autoClose.value = String(settings.autoCloseInterval);
    autoHint.textContent = settings.autoCloseInterval <= 0 ? t("Off (stays open)") : t("seconds after you leave the island (0 = off)");
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: t("Main display") }),
    h("option", { value: "cursor", text: t("Display under the cursor") }),
  );
  screen.value = settings.screen;
  void Bridge.listMonitors().then((list) => {
    for (const m of list ?? []) screen.append(h("option", { value: m.key, text: m.label }));
    const saved = settings.screen;
    const [place, name] = saved.split("|");
    const keys = (list ?? []).map((m) => m.key);
    screen.value =
      keys.find((k) => k === saved) ??
      (saved.startsWith("at:") ? keys.find((k) => k.split("|")[0] === place) : undefined) ??
      (name ? keys.find((k) => k.split("|")[1] === name) : undefined) ??
      saved;
    if (!screen.value) screen.value = "primary";
  });
  screen.addEventListener("change", () => {
    settings.screen = screen.value;
    void save();
  });

  const displayCard = h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Display & Behavior") })),
    h("div", { class: "row" },
      h("label", { text: t("Launch at startup") }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("Island lives on") }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: t("Open on hover") }),
      toggle(settings.openOnHover, (v) => { settings.openOnHover = v; void save(); }),
    ),
    h("div", { class: "hint", text: t("Hovering the island opens it; it folds again shortly after the pointer leaves. Click inside to keep it open.") }),
    h("div", { class: "row" },
      h("label", { text: t("Auto-close") }),
      autoClose,
      autoHint,
    ),
  );

  // 2. Vision & Screen Analysis
  const visionCard = h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Vision & Screen Analysis") })),
    h("div", { class: "row" },
      h("label", { text: "Görsel girdi işleme (Vision)" }),
      toggle(settings.visionEnabled !== false, (v) => { settings.visionEnabled = v; void save(); }),
    ),
    h("div", { class: "hint", text: "Görseller, fotoğraflar ve ekran çizimleri doğrudan yapay zekaya aktarılır ve tam görsel analiz yapılır." }),
    h("div", { class: "row" },
      h("label", { text: "Ekran paylaşımı & Analizi" }),
      toggle(settings.screenShareEnabled !== false, (v) => { settings.screenShareEnabled = v; void save(); }),
    ),
    h("div", { class: "hint", text: "Sohbette ekranınızla ilgili bir soru sorduğunuzda ('ekranıma bak', 'ekranda ne var' vb.) anlık ekran görüntüsü incelenir." }),
  );

  // 3. Audio & Sound Effects
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const customCount = h("span", { class: "hint" });
  const countCustom = () =>
    void Bridge.customSounds(SOUND_NAMES).then((own) => {
      const n = own?.length ?? 0;
      customCount.textContent = n > 0 ? t("{0} custom", { 0: n }) : "";
    });
  countCustom();
  const soundsFolder = h("button", { text: t("Open sounds folder"), onclick: () => void Bridge.revealSoundsFolder() });
  const reloadSounds = h("button", {
    text: t("Reload sounds"),
    onclick: () => void Bridge.reloadSounds().then(() => window.setTimeout(countCustom, 300)),
  });

  const audioCard = h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Sound & Audio Effects") })),
    h("div", { class: "row" },
      h("label", { text: t("Sound") }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" }, soundsFolder, reloadSounds, customCount),
    h("div", { class: "hint", text: t("Drop a file named like one of Mochi's sounds (finish.wav, approval.mp3, greet.m4a…) in the sounds folder to replace it, then Reload.") }),
  );

  // 4. Localization & Privacy
  const privacyCard = h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Localization & Privacy") })),
    languageRow(),
    ...recapRows(),
  );

  return [displayCard, visionCard, audioCard, privacyCard];
}

/**
 * Settings → General → Language, as on the Mac: "System" follows the
 * system's language when Omi has it (else English), or one of the ten.
 * Both windows and the tray switch in place, without a restart.
 */
function languageRow(): HTMLElement {
  const select = h("select", {}) as HTMLSelectElement;
  select.append(h("option", { value: "", text: t("System") }));
  for (const { code, name } of LANGUAGES) select.append(h("option", { value: code, text: name, lang: code }));
  select.value = LANGUAGES.some((l) => l.code === settings.language) ? settings.language : "";
  select.addEventListener("change", () => {
    settings.language = select.value;
    void save();
    applyLanguage();
  });
  return h("div", { class: "row" }, h("label", { text: t("Language") }), select);
}

// ── Shortcuts section ─────────────────────────────────────────────────────────

const SHORTCUTS_UI = {
  get title() { return t("Shortcuts"); },
  get hint() { return t("Work from any app. Click a shortcut to change it, then press the new keys — Esc cancels, Backspace removes it."); },
  get global() { return t("From anywhere"); },
  get island() { return t("In the open island"); },
  get recording() { return t("Press keys…"); },
  get none() { return t("None"); },
  get reset() { return t("Reset to defaults"); },
  get inUse() { return t("In use by another app"); },
  get duplicate() { return t("Used twice"); },
  get invalid() { return t("Not a valid shortcut"); },
  get unavailable() { return t("Not available"); },
  types: (ch: string) => t("Types “{char}”", { char: ch }),
  typesNote: (keys: string, ch: string) =>
    t("{keys} types “{char}” on your keyboard, so it can't be a shortcut. Pick another key.", { keys, char: ch }),
  get needsModifier() { return t("Hold Ctrl, Alt or the Windows key with it."); },
  get unsupportedKey() { return t("That key can't be used in a shortcut."); },
  get wayland() {
    return t("Your Wayland desktop doesn't let apps listen for keys outside their own windows. Add the shortcuts in your system's keyboard settings instead, with these commands:");
  },
  get noDisplay() { return t("No display server was found, so global shortcuts are off."); },
  get portalPending() {
    return t("Asking your desktop to register the shortcuts. It may show its own window to confirm them.");
  },
  get portalActive() {
    return t("These shortcuts are registered with your desktop. It may ask you to confirm them or to pick other keys; when it says which keys it uses, they show next to each shortcut.");
  },
  get portalFallback() {
    return t("If one doesn't work, you can also add it in your system's keyboard settings with these commands:");
  },
  desktopKeys: (keys: string) => t("Desktop: {keys}", { keys }),
  get refused() { return t("Not set by your desktop"); },
};

function shortcutsSection(initial: ShortcutsReport | null): HTMLElement {
  let report = initial;
  const list = h("div", { class: "shortcut-list" });
  const feedback = h("div", {});
  const blockedNote = h("div", {});

  let stopRecording: (() => void) | null = null;

  function store(id: string, binding: Binding) {
    settings.shortcuts = { ...settings.shortcuts, [id]: binding };
    void save();
  }

  function tagFor(id: string, dups: Set<string>): HTMLElement | null {
    if (dups.has(id)) return h("span", { class: "tag err", text: SHORTCUTS_UI.duplicate });
    const st = report?.actions.find((a) => a.id === id);
    switch (st?.status) {
      case "inUse": return h("span", { class: "tag warn", text: SHORTCUTS_UI.inUse });
      case "duplicate": return h("span", { class: "tag err", text: SHORTCUTS_UI.duplicate });
      case "invalid": return h("span", { class: "tag err", text: SHORTCUTS_UI.invalid });
      case "typesCharacter": return h("span", { class: "tag warn", text: SHORTCUTS_UI.types(st.typed ?? "?") });
      case "unsupported": return h("span", { class: "tag", text: SHORTCUTS_UI.unavailable });
      case "refused": return h("span", { class: "tag warn", text: SHORTCUTS_UI.refused });
      // Wayland: the desktop may run it on other keys than the ones asked for.
      case "active": return st.trigger ? h("span", { class: "tag", text: SHORTCUTS_UI.desktopKeys(st.trigger) }) : null;
      default: return null;
    }
  }

  function record(id: string, binding: Binding, button: HTMLButtonElement) {
    stopRecording?.();
    clear(feedback);
    button.classList.add("recording");
    button.textContent = SHORTCUTS_UI.recording;
    void Bridge.shortcutsSuspend(true);

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const result = recordPress(e);
      switch (result.kind) {
        case "pending":
          return;
        case "keys":
          finish();
          store(id, { keys: result.keys, enabled: true });
          return;
        case "clear":
          finish();
          store(id, { keys: "", enabled: binding.enabled });
          return;
        case "typesCharacter":
          finish();
          feedback.append(h("div", {
            class: "notice warn",
            text: SHORTCUTS_UI.typesNote(displayKeys(result.keys), result.typed),
          }));
          return;
        case "needsModifier":
          feedback.replaceChildren(h("div", { class: "notice warn", text: SHORTCUTS_UI.needsModifier }));
          return;
        case "unsupported":
          feedback.replaceChildren(h("div", { class: "notice warn", text: SHORTCUTS_UI.unsupportedKey }));
          return;
        case "cancel":
          finish();
          return;
      }
    };
    const onBlur = () => finish();

    function finish() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      stopRecording = null;
      // Takes the global shortcuts back, from what is saved by now.
      void Bridge.shortcutsSuspend(false);
      draw();
    }
    stopRecording = finish;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  }

  function draw() {
    clear(list);
    const dups = duplicates(activeKeys(settings.shortcuts));
    for (const d of SHORTCUTS) {
      if (!d.ported) continue;
      const binding = effective(d, settings.shortcuts);
      const keycap = h("button", {
        class: "keycap",
        text: binding.keys ? displayKeys(binding.keys) : SHORTCUTS_UI.none,
      }) as HTMLButtonElement;
      keycap.disabled = !binding.enabled;
      keycap.addEventListener("click", () => record(d.id, binding, keycap));
      const sw = toggle(binding.enabled, (on) => store(d.id, { keys: binding.keys, enabled: on }));
      const tag = binding.enabled ? tagFor(d.id, dups) : null;
      list.append(h("div", { class: binding.enabled ? "row shortcut" : "row shortcut off" },
        sw,
        h("span", { class: "shortcut-name", text: t(SHORTCUT_TEXT[d.id]) }),
        ...(tag ? [tag] : []),
        keycap,
      ));
    }

    clear(blockedNote);
    const commands = (command: string) => {
      const list = h("div", { class: "diff" });
      for (const d of SHORTCUTS) {
        if (d.ported) list.append(h("div", { class: "ctx", text: `${command} ${d.id}` }));
      }
      return list;
    };
    if (report?.portal) {
      // Wayland, through the desktop's GlobalShortcuts portal; the commands
      // stay as a way around a shortcut the desktop didn't take.
      const active = report.portal === "active";
      blockedNote.append(
        h("div", {
          class: active ? "notice ok" : "notice",
          text: active ? SHORTCUTS_UI.portalActive : SHORTCUTS_UI.portalPending,
        }),
        h("div", { class: "hint", text: SHORTCUTS_UI.portalFallback }),
        commands(report.command),
      );
    } else if (report?.blocked === "wayland") {
      blockedNote.append(h("div", { class: "notice warn", text: SHORTCUTS_UI.wayland }), commands(report.command));
    } else if (report?.blocked) {
      blockedNote.append(h("div", { class: "notice warn", text: SHORTCUTS_UI.noDisplay }));
    }
  }

  const islandList = h("div", { class: "shortcut-list" });
  for (const row of ISLAND_SHORTCUTS) {
    islandList.append(h("div", { class: "row shortcut" },
      h("span", { class: "shortcut-name", text: t(row.description) }),
      h("span", { class: "keycap static", text: row.keys }),
    ));
  }

  const reset = h("button", {
    text: SHORTCUTS_UI.reset,
    onclick: () => {
      stopRecording?.();
      settings.shortcuts = {};
      clear(feedback);
      void save();
      draw();
    },
  });

  // The events are listened to once (see main); only the section on screen redraws.
  shortcutsListener = {
    report(fresh) {
      report = fresh;
      if (!stopRecording) draw();
    },
    settingsChanged() {
      if (!stopRecording) draw();
    },
  };

  draw();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: SHORTCUTS_UI.title })),
    h("div", { class: "hint", text: SHORTCUTS_UI.hint }),
    h("div", { class: "subhead", text: SHORTCUTS_UI.global }),
    list,
    blockedNote,
    feedback,
    h("div", { class: "row" }, reset),
    h("div", { class: "subhead", text: SHORTCUTS_UI.island }),
    islandList,
  );
}

// ── Game Mode Section (Auto-Hide for Games & Apps) ───────────────────────────
function gameModeSection(): HTMLElement {
  const section = h("section", {});
  const body = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const isEnabled = settings.gameModeEnabled !== false;
  const dot = statusDot(isEnabled);

  const head = h(
    "h2",
    {},
    dot,
    h("span", { text: t("Games & Apps") }),
  );
  const hint = h("div", {
    class: "hint",
    text: t("Auto-hide Omi when playing games or full-screen apps."),
  });

  const masterToggle = toggle(isEnabled, (on) => {
    settings.gameModeEnabled = on;
    void save();
    draw();
  });

  const masterRow = h(
    "div",
    { class: "row", style: "display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);" },
    h("div", { style: "display:flex;flex-direction:column;gap:2px;" },
      h("span", { style: "font-weight:600;font-size:13px;", text: t("Auto-hide when game or app is active") }),
      h("span", { class: "hint", style: "margin:0;font-size:11.5px;", text: t("When a configured game/app is in the foreground, Omi automatically hides. Exiting returns Omi to the front.") }),
    ),
    masterToggle,
  );

  // Add Custom App / Game
  const inputEl = h("input", {
    type: "text",
    class: "input",
    style: "flex:1;min-width:180px;padding:6px 10px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#f8fafc;font-size:12.5px;",
    placeholder: t("Process or window name (e.g. valorant.exe, cs2.exe, Minecraft...)"),
  }) as HTMLInputElement;

  const addBtn = h("button", {
    class: "primary",
    style: "padding:6px 14px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;",
    text: t("Add"),
    onclick: () => {
      const val = inputEl.value.trim();
      if (!val) return;
      const apps = settings.gameModeApps ?? [];
      const id = val.toLowerCase().endsWith(".exe") ? val.toLowerCase() : val;
      const cleanName = val.replace(/\.exe$/i, "");
      const name = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
      if (!apps.some((a) => a.id.toLowerCase() === id.toLowerCase())) {
        settings.gameModeApps = [...apps, { id, name, enabled: true }];
        inputEl.value = "";
        void save();
        draw();
      }
    },
  });

  const pickOpenBtn = h("button", {
    style: "padding:6px 12px;border-radius:8px;font-size:12px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#cbd5e1;cursor:pointer;",
    text: t("Pick from open apps"),
    onclick: async () => {
      try {
        const running = await FlowBridge.runningApps();
        if (!running || running.length === 0) {
          alert(t("No open application windows found."));
          return;
        }
        clear(openAppsList);
        for (const app of running) {
          const item = h(
            "div",
            {
              class: "row",
              style: "display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);margin-bottom:4px;transition:background 0.12s;",
              onmouseenter: (e: Event) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.08)"; },
              onmouseleave: (e: Event) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.03)"; },
              onclick: () => {
                const apps = settings.gameModeApps ?? [];
                if (!apps.some((a) => a.id.toLowerCase() === app.id.toLowerCase())) {
                  settings.gameModeApps = [...apps, { id: app.id, name: app.name || app.id, enabled: true }];
                  void save();
                  draw();
                }
                openAppsDropdown.style.display = "none";
              },
            },
            h("span", { style: "font-weight:600;font-size:12px;", text: app.name || app.id }),
            h("span", { class: "tag", style: "font-family:monospace;font-size:11px;background:rgba(255,255,255,0.06);color:#94a3b8;border-radius:4px;padding:2px 6px;", text: app.id }),
          );
          openAppsList.append(item);
        }
        openAppsDropdown.style.display = openAppsDropdown.style.display === "none" ? "block" : "none";
      } catch (e) {
        console.error(e);
      }
    },
  });

  const addBar = h(
    "div",
    { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;" },
    inputEl,
    addBtn,
    pickOpenBtn,
  );

  const openAppsList = h("div", { style: "max-height:160px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;" });
  const openAppsDropdown = h(
    "div",
    {
      style: "display:none;background:#131417;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px;margin-top:6px;box-shadow:0 8px 24px rgba(0,0,0,0.6);",
    },
    h("div", { class: "hint", style: "margin-bottom:6px;font-size:11px;", text: t("Click any open app to add to auto-hide list:") }),
    openAppsList,
  );

  // Quick Preset Chips
  const presets = [
    { id: "valorant.exe", name: "Valorant" },
    { id: "cs2.exe", name: "Counter-Strike 2" },
    { id: "javaw.exe", name: "Minecraft" },
    { id: "league of legends.exe", name: "League of Legends" },
    { id: "gta5.exe", name: "GTA V" },
    { id: "steam.exe", name: "Steam" },
    { id: "robloxplayerbeta.exe", name: "Roblox" },
    { id: "fortniteclient-win64-shipping.exe", name: "Fortnite" },
  ];

  const presetChipsRow = h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:2px;" });
  presetChipsRow.append(h("span", { class: "hint", style: "font-size:11px;margin-right:2px;", text: t("Quick presets:") }));

  const appsList = h("div", { class: "game-apps-list", style: "display:flex;flex-direction:column;gap:6px;margin-top:10px;" });

  function draw() {
    clear(appsList);
    clear(presetChipsRow);
    presetChipsRow.append(h("span", { class: "hint", style: "font-size:11px;margin-right:2px;", text: t("Quick presets:") }));

    const apps = settings.gameModeApps ?? [];
    for (const p of presets) {
      const already = apps.some((a) => a.id.toLowerCase() === p.id.toLowerCase());
      if (already) continue;
      const chip = h(
        "button",
        {
          class: "link-btn",
          style: "font-size:11px;padding:2px 8px;border-radius:12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#94a3b8;cursor:pointer;",
          text: `+ ${p.name}`,
          onclick: () => {
            settings.gameModeApps = [...apps, { id: p.id, name: p.name, enabled: true }];
            void save();
            draw();
          },
        },
      );
      presetChipsRow.append(chip);
    }

    if (apps.length === 0) {
      appsList.append(h("div", { class: "hint", style: "text-align:center;padding:16px 0;", text: t("No games or apps added yet. Use the presets above or enter a process name.") }));
    } else {
      for (const item of apps) {
        const sw = toggle(item.enabled, (on) => {
          item.enabled = on;
          void save();
        });
        const delBtn = h(
          "button",
          {
            class: "link-btn",
            style: "border:none;background:none;color:#ef4444;cursor:pointer;padding:4px 8px;font-size:13px;",
            title: t("Remove"),
            onclick: () => {
              settings.gameModeApps = (settings.gameModeApps ?? []).filter((x) => x.id !== item.id);
              void save();
              draw();
            },
          },
          "✕",
        );
        const row = h(
          "div",
          {
            class: item.enabled ? "row shortcut" : "row shortcut off",
            style: "display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);",
          },
          sw,
          h("div", { style: "display:flex;align-items:center;gap:8px;flex:1;margin-left:8px;" },
            h("span", { style: "font-weight:600;font-size:13px;color:#f8fafc;", text: item.name }),
            h("span", { class: "tag", style: "font-family:monospace;font-size:11px;", text: item.id }),
          ),
          delBtn,
        );
        appsList.append(row);
      }
    }
  }

  draw();
  body.append(masterRow, addBar, openAppsDropdown, presetChipsRow, appsList);
  section.append(head, hint, body);
  return section;
}

/** Settings → General → Weekly recap. The prefs live with the history in Rust. */
function recapRows(): HTMLElement[] {
  const T = {
    label: t("Weekly recap"),
    keep: t("Keep a history of my coding sessions"),
    clear: t("Clear history"),
    cleared: t("History cleared."),
    about: t("Counts and project names only — never commands, files or prompts. Kept on this computer for 12 weeks."),
  };
  const feedback = h("span", { class: "hint" });
  const sw = toggle(true, (v) => { void Bridge.recapSetEnabled(v); });
  void Bridge.recapPrefs().then((prefs) => {
    if (prefs) sw.classList.toggle("on", prefs.enabled);
  });
  const clearBtn = h("button", {
    class: "danger",
    text: T.clear,
    onclick: async () => {
      clearBtn.disabled = true;
      await Bridge.recapClear();
      feedback.textContent = T.cleared;
      window.setTimeout(() => {
        clearBtn.disabled = false;
        feedback.textContent = "";
      }, 2400);
    },
  }) as HTMLButtonElement;
  return [
    h("div", { class: "row" },
      h("label", { text: T.label }),
      sw,
      h("span", { class: "hint", text: T.keep }),
    ),
    h("div", { class: "row" },
      h("label", {}),
      clearBtn,
      feedback,
    ),
    h("div", { class: "row" },
      h("label", {}),
      h("span", { class: "hint", style: "flex:1 1 0;min-width:0", text: T.about }),
    ),
  ];
}

// ── Language ──────────────────────────────────────────────────────────────────

/** The shortcuts section on screen, told about the events listened to once in main. */
let shortcutsListener: { report(fresh: ShortcutsReport): void; settingsChanged(): void } | null = null;

/**
 * Shows the language Settings asks for. A change redraws the window in place,
 * where it was scrolled to: nothing reloads, nothing is written.
 */
function applyLanguage() {
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
}

function applyDirection() {
  document.documentElement.dir = isRtl() ? "rtl" : "ltr";
  document.title = "Omi";
}

let rendering: Promise<void> | null = null;
let renderAgain = false;

/** Redraws every section from fresh state, keeping the scroll position. */
async function rerender() {
  if (rendering) {
    renderAgain = true;
    return;
  }
  const scroll = document.scrollingElement?.scrollTop ?? 0;
  rendering = render();
  try {
    await rendering;
  } finally {
    rendering = null;
  }
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
  if (renderAgain) {
    renderAgain = false;
    await rerender();
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
  applyDirection();
  hub = await startHub(windowRoot, {
    version,
    flowPages: FLOW_PAGE_RENDERERS,
    renderNotch: async (page, container) => {
      notchPage = page;
      root = container;
      await render();
    },
  });
  onLanguageChange(() => {
    applyDirection();
    hub?.redraw();
  });

  void onEvent<ShortcutsReport>("shortcuts-status", (fresh) => shortcutsListener?.report(fresh));
  void onEvent<Settings>("settings-changed", (s) => {
    const before = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.customUrl}`;
    settings = { ...settings, ...s };
    shortcutsListener?.settingsChanged();
    for (const redraw of declaredViews) redraw();
    const after = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.customUrl}`;
    if (before !== after) localRedraw?.();
    applyLanguage();
  });
}

/** The Notch page being shown. */
let notchPage: PageId = "general";

/** Reads what the sections of the Notch page show and draws them. */

async function render() {
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, planRelayInstalled: false, settingsPath: "", hookPath: "", hookReady: false,
  };
  const agents = await Bridge.agentHooksList();

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const shortcutReport = await Bridge.shortcutsStatus();
  const customKey = (await Bridge.secretPresent(CUSTOM_SERVER_KEY)) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  settings = { ...settings, ...sanitizeDeclared(settings) };
  const connected: Record<string, boolean> = { ...((await Bridge.agentHooksStatus()) ?? {}) };
  for (const def of availablePills()) {
    if (def.connect.kind === "key") {
      connected[def.id] = present[def.connect.key] ?? (await Bridge.secretPresent(def.connect.key)) ?? false;
    }
  }

  const keyChanged = (key: string, on: boolean) => {
    for (const def of availablePills()) {
      if (def.connect.kind === "key" && def.connect.key === key) connected[def.id] = on;
    }
    for (const redraw of declaredViews) redraw();
  };
  const chatKeys: Record<string, boolean> = {};
  for (const def of CLOUD) {
    const key = providerDef(def.id).key!;
    chatKeys[key] = (await Bridge.secretPresent(key)) ?? false;
  }

  localRedraw = null;
  shortcutsListener = null;
  const antigravityAccounts = await Bridge.antigravityAccounts();
  const hasActiveAntigravity = antigravityAccounts.some((a) => a.active);
  if (hasActiveAntigravity && (settings.chatProvider === "anthropic" || settings.chatProvider === "google")) {
    settings.chatProvider = "google-antigravity";
    settings.chatModels["google-antigravity"] = "gemini-2.5-flash";
    void save();
  }

  clear(root);

  const sections: Partial<Record<PageId, () => HTMLElement[]>> = {
    general: () => generalSections(),
    agents: () => [claudeSection(status), agentsSection(agents), planSection(status)],
    chat: () => [
      antigravitySection(antigravityAccounts),
      apiSection(hasKey),
      chatProvidersSection(chatKeys, keyChanged),
      localSection(customKey),
    ],
    integrations: () => [integrationsSection(present, connected)],
    shortcuts: () => [shortcutsSection(shortcutReport)],
    gamemode: () => [gameModeSection()],
  };
  root.append(...(sections[notchPage]?.() ?? []));
  if (notchPage === "general") {
    root.append(h("div", {
      class: "hint",
      text: t("No telemetry. Network requests only go to the services you configure yourself."),
    }));
  }
}

void main();
