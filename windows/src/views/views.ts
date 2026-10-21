// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { highlightRow, listRows, openRow } from "./github";
import { pillDefinition, sessionSubtitle } from "../core/pills";
import {
  PlanCard, buildPlanPill, claudePillVisible, codexPillVisible, planCardOpen, refreshCodexPlanUsage,
} from "./usage";
import { lastTextStep } from "../core/diff";
import { Bridge } from "../core/bridge";
import { buildRecap } from "./recap";
import { buildWardrobe } from "./wardrobe";
import { buildMusic } from "./music";
import { buildCalendar } from "./calendar";
import { buildSnip } from "./snip";
import type { Outfit, OutfitSelection } from "../mochi/wardrobe";
import { language, t, tl, type Msg } from "../i18n/i18n";
import type { ViewCommand } from "../island/shortcuts";

export interface ViewActions {
  setView(v: IslandViewName): void;
  /** "Cancel" on a dropped file: forgets it and goes back home. */
  cancelDrop(): void;
  collapse(): void;
  /** Folds a waiting card to the compact island without answering it. */
  foldApproval(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  /** Answers the question Claude Code asked: question text → chosen label. */
  answer(answers: Record<string, string | string[]>): void;
  /** Hands the pending request back to the terminal. */
  answerInTerminal(): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
  /** Wardrobe click: keeps the outfit ("auto" and "none" included). */
  chooseOutfit(selection: OutfitSelection): void;
  /** Wardrobe hover: shows an outfit on Mochi without keeping it; null ends it. */
  previewOutfit(outfit: Outfit | null): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. True = needs another frame. */
  tick?(nowMs: number): boolean | void;
  /** Ctrl+O / Ctrl+E while the view is on screen (island/shortcuts.ts). */
  command?(command: ViewCommand): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string | Msg,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: tl("Overview"), onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: tl("Ask"), onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabCalendar = h("button", { class: "tab", title: "Ajanda / Takvim", onclick: () => go("calendar") }, svg(ICONS.calendar, 13));
  const tabMusic = h("button", { class: "tab", title: "Müzik / Shazam", onclick: () => go("music") }, svg(ICONS.musicNote, 13));
  const tabSnip = h("button", { class: "tab", title: "Ekran Alıntısı & Çizim", onclick: () => go("snip") }, svg(ICONS.camera, 13));
  const tabDrop = h("button", { class: "tab", title: tl("Drop"), onclick: () => go("upload") }, svg(ICONS.plus, 13));
  const gearBtn = h("button", { title: tl("Settings"), onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: tl("Mute"), onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));
  // Plan usage pills (off by default): before the gear, Claude first, as on the Mac.
  const claudePill = buildPlanPill(false);
  const codexPill = buildPlanPill(true);
  const planPills = h("div", { class: "plan-pills" }, claudePill.el, codexPill.el);
  let codexShown = false;

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const batteryWidget = h("div", {
    class: "battery-indicator",
    style: "display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:#FFFFFF;padding:2px 4px;border-radius:6px;cursor:default;user-select:none;",
  });

  interface BatteryManager {
    level: number;
    charging: boolean;
  }
  interface BatteryNavigator {
    getBattery?: () => Promise<BatteryManager>;
  }

  async function updateBattery() {
    if (State.mode !== "expanded" || (typeof document !== "undefined" && document.hidden)) {
      return;
    }
    let info = await Bridge.batteryStatus();
    if (!info && typeof navigator !== "undefined") {
      const nav = navigator as unknown as BatteryNavigator;
      if (typeof nav.getBattery === "function") {
        try {
          const b = await nav.getBattery();
          info = {
            percent: Math.round(b.level * 100),
            charging: b.charging,
            hasBattery: true,
          };
        } catch {}
      }
    }
    if (!info || (!info.hasBattery && !info.charging)) {
      batteryWidget.style.display = "none";
      return;
    }
    batteryWidget.style.display = "inline-flex";
    const p = info.percent;
    const fillWidth = Math.max(1.5, Math.min(17.2, (p / 100) * 17.2));
    const color = p <= 15 ? "#EF4444" : "#FFFFFF";
    batteryWidget.title = `${p}% · ${info.charging ? "Şarj ediliyor" : "Pil"}`;
    clear(batteryWidget);
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 12");
    s.setAttribute("width", "22");
    s.setAttribute("height", "11");
    s.setAttribute("fill", "none");
    s.setAttribute("style", "flex-shrink:0;");

    const outline = document.createElementNS(ns, "rect");
    outline.setAttribute("x", "0.6");
    outline.setAttribute("y", "0.6");
    outline.setAttribute("width", "20");
    outline.setAttribute("height", "10.8");
    outline.setAttribute("rx", "3.5");
    outline.setAttribute("stroke", "rgba(255, 255, 255, 0.45)");
    outline.setAttribute("stroke-width", "1.2");
    s.append(outline);

    const tip = document.createElementNS(ns, "rect");
    tip.setAttribute("x", "21.4");
    tip.setAttribute("y", "3.6");
    tip.setAttribute("width", "1.6");
    tip.setAttribute("height", "4.8");
    tip.setAttribute("rx", "0.8");
    tip.setAttribute("fill", "rgba(255, 255, 255, 0.45)");
    s.append(tip);

    const fill = document.createElementNS(ns, "rect");
    fill.setAttribute("x", "2");
    fill.setAttribute("y", "2");
    fill.setAttribute("width", String(fillWidth));
    fill.setAttribute("height", "8");
    fill.setAttribute("rx", "2.4");
    fill.setAttribute("fill", color);
    s.append(fill);

    if (info.charging) {
      const bolt = document.createElementNS(ns, "path");
      bolt.setAttribute("d", "M10.5 1.5L7.5 6.5H10L9.2 10.5L13.2 5.5H10.5L11 1.5Z");
      bolt.setAttribute("fill", p >= 60 ? "#09090B" : "#FACC15");
      s.append(bolt);
    }

    const pct = h("span", { style: "color:#FFFFFF;font-weight:600;", text: `${p}%` });
    batteryWidget.append(pct, s);
  }
  void updateBattery();
  const batteryTimer = setInterval(() => void updateBattery(), 60000);
  if (typeof window !== "undefined") window.addEventListener("beforeunload", () => clearInterval(batteryTimer));

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabCalendar, tabMusic, tabSnip, tabDrop),
    h("div", { class: "header-brand", text: "omi" }),
    h("div", { class: "header-actions" }, planPills, gearBtn, soundBtn, batteryWidget),
  );
  const headerActions = el.lastElementChild as HTMLElement;
  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabMusic.classList.toggle("on", v === "music");
      tabCalendar.classList.toggle("on", v === "calendar");
      tabSnip.classList.toggle("on", v === "snip");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      syncPlanPills();
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };

  function syncPlanPills() {
    const claudeOn = claudePillVisible();
    const codexOn = codexPillVisible();
    claudePill.el.style.display = claudeOn ? "" : "none";
    codexPill.el.style.display = codexOn ? "" : "none";
    planPills.classList.toggle("on", claudeOn || codexOn);
    // Both pills: the right side tightens so it still clears the screen edge.
    headerActions.classList.toggle("both-plans", claudeOn && codexOn);
    if (claudeOn) claudePill.sync();
    if (codexOn) codexPill.sync();
    // Codex is asked when its pill comes into view (stale answers only).
    const shown = codexOn && State.mode === "expanded";
    if (shown && !codexShown) refreshCodexPlanUsage();
    codexShown = shown;
  }
}

// ── Overview ──────────────────────────────────────────────────────────────────
const artCache = new Map<string, string>();

class NowPlayingBar {
  readonly el: HTMLElement;
  private fill: HTMLElement;
  private knob: HTMLElement;
  private hovering = false;
  private dragging = false;
  private fraction = 0;
  enabled = true;
  private onChange: (f: number) => void;
  private onCommit: (f: number) => void;

  constructor(onChange: (f: number) => void, onCommit: (f: number) => void) {
    this.onChange = onChange;
    this.onCommit = onCommit;
    this.fill = h("i", { class: "np-fill" });
    this.knob = h("i", { class: "np-knob" });
    this.fill.style.background = "#C5C8CD";
    this.el = h("div", { class: "np-bar" }, h("i", { class: "np-track" }), this.fill, this.knob);
    this.el.addEventListener("mouseenter", () => {
      this.hovering = true;
      this.paint();
    });
    this.el.addEventListener("mouseleave", () => {
      this.hovering = false;
      this.paint();
    });
    this.el.addEventListener("pointerdown", (e) => {
      if (!this.enabled || e.button !== 0) return;
      e.stopPropagation();
      this.dragging = true;
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {}
      this.onChange(this.at(e.clientX));
      this.paint();
    });
    this.el.addEventListener("pointermove", (e) => {
      if (this.dragging) this.onChange(this.at(e.clientX));
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.onCommit(this.at(e.clientX));
      this.paint();
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
  }

  get active(): boolean {
    return this.enabled && (this.hovering || this.dragging);
  }

  private at(clientX: number): number {
    const r = this.el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
  }

  set(fraction: number) {
    this.fraction = Math.min(1, Math.max(0, fraction));
    this.paint();
  }

  private paint() {
    const active = this.active;
    this.el.classList.toggle("active", active);
    const pct = `${this.fraction * 100}%`;
    this.fill.style.width = pct;
    this.fill.style.background = active ? "#1db954" : "#C5C8CD";
    this.knob.style.left = `clamp(0px, calc(${pct} - 4.5px), calc(100% - 9px))`;
  }
}

function formatTime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? "0" : ""}${rem}`;
}

function buildOverviewDashboard(actions: ViewActions) {
  // ── Music section (Rich Overview Music Card with progress bar & full controls) ──
  const titleSpan = h("span", {
    style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 11px var(--font);color:var(--ink);",
    text: "Müzik aranıyor...",
  });

  const artistText = h("div", {
    class: "ov-artist-text",
    style: "font:400 9.5px var(--font);color:var(--dim-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
    text: "Oynatıcı Bekleniyor",
  });

  const coverImg = h("img", {
    style: "width:100%;height:100%;object-fit:cover;border-radius:6px;display:none;pointer-events:none;",
  }) as HTMLImageElement;

  const coverFallback = h("div", {
    style: "width:100%;height:100%;border-radius:6px;background:rgba(255,255,255,0.06);display:grid;place-items:center;color:var(--dim-3);",
  }, svg(ICONS.musicNote, 16));

  const platformBadge = h("div", {
    class: "ov-platform-badge",
    style: "position:absolute;bottom:-2px;right:-2px;width:14px;height:14px;border-radius:50%;background:#1db954;border:1.5px solid #18181b;display:grid;place-items:center;box-shadow:0 2px 4px rgba(0,0,0,0.4);",
  });

  const coverWrap = h("div", {
    class: "ov-cover-wrap",
    style: "position:relative;width:38px;height:38px;border-radius:6px;box-shadow:0 3px 8px rgba(0,0,0,0.4);flex-shrink:0;",
  }, coverImg, coverFallback, platformBadge);

  let isPlaying = false;
  let trackDuration = 0;
  let trackPosition = 0;
  let dragFraction: number | null = null;

  const elapsedText = h("span", { class: "np-time elapsed", style: "font-size:9px;min-width:24px;text-align:right;", text: "0:00" });
  const remainingText = h("span", { class: "np-time remaining", style: "font-size:9px;min-width:26px;text-align:left;", text: "-0:00" });

  const progress = new NowPlayingBar(
    (f) => {
      dragFraction = f;
      if (trackDuration > 0) {
        const cur = f * trackDuration;
        elapsedText.textContent = formatTime(cur);
        remainingText.textContent = `-${formatTime(trackDuration - cur)}`;
      }
    },
    (f) => {
      dragFraction = null;
      if (trackDuration > 0) {
        const target = f * trackDuration;
        void Bridge.mediaControl("seek", target);
        triggerQuickPolls();
      }
    },
  );
  progress.el.style.height = "8px";

  const progressRow = h("div", {
    class: "np-progress",
    style: "display:none;align-items:center;gap:4px;width:100%;padding:1px 0;",
  }, elapsedText, progress.el, remainingText);

  const playIcon = svg(ICONS.play, 9);
  const pauseIcon = svg(ICONS.pause, 9);

  function triggerQuickPolls() {
    void pollMusic();
    setTimeout(() => void pollMusic(), 120);
    setTimeout(() => void pollMusic(), 300);
    setTimeout(() => void pollMusic(), 600);
    setTimeout(() => void pollMusic(), 1000);
  }

  let shuffleOn = false;
  let repeatOn = false;

  const shuffleBtn = h("button", {
    class: "np-icon",
    style: "width:16px;height:18px;display:grid;place-items:center;cursor:pointer;border:0;background:transparent;color:var(--dim-3);padding:0;",
    title: "Karışık Çal",
    onclick: (e: Event) => {
      e.stopPropagation();
      shuffleOn = !shuffleOn;
      shuffleBtn.style.color = shuffleOn ? "#22c55e" : "var(--dim-3)";
      void Bridge.mediaControl("shuffle", shuffleOn ? 1 : 0);
    },
  }, svg(ICONS.shuffle, 10, { stroke: 2.2 }));

  const prevBtn = h("button", {
    class: "np-icon",
    style: "width:16px;height:18px;display:grid;place-items:center;cursor:pointer;border:0;background:transparent;color:var(--dim-2);padding:0;",
    title: "Önceki Parça",
    onclick: (e: Event) => {
      e.stopPropagation();
      void Bridge.mediaControl("previous");
      triggerQuickPolls();
    },
  }, svg(ICONS.backward, 11));

  const playBtn = h("button", {
    class: "np-play",
    style: "width:20px;height:20px;border-radius:50%;background:#ffffff;color:#000000;border:0;display:grid;place-items:center;cursor:pointer;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,0.3);transition:transform 0.12s ease;",
    title: "Oynat / Duraklat",
    onclick: (e: Event) => {
      e.stopPropagation();
      void Bridge.mediaControl("playPause");
      isPlaying = !isPlaying;
      updatePlayIcon();
      triggerQuickPolls();
    },
  }, playIcon);

  function updatePlayIcon() {
    clear(playBtn);
    playBtn.append(isPlaying ? pauseIcon : playIcon);
  }

  const nextBtn = h("button", {
    class: "np-icon",
    style: "width:16px;height:18px;display:grid;place-items:center;cursor:pointer;border:0;background:transparent;color:var(--dim-2);padding:0;",
    title: "Sonraki Parça",
    onclick: (e: Event) => {
      e.stopPropagation();
      void Bridge.mediaControl("next");
      triggerQuickPolls();
    },
  }, svg(ICONS.forward, 11));

  const repeatBtn = h("button", {
    class: "np-icon",
    style: "width:16px;height:18px;display:grid;place-items:center;cursor:pointer;border:0;background:transparent;color:var(--dim-3);padding:0;",
    title: "Tekrar Çal",
    onclick: (e: Event) => {
      e.stopPropagation();
      repeatOn = !repeatOn;
      repeatBtn.style.color = repeatOn ? "#22c55e" : "var(--dim-3)";
      void Bridge.mediaControl("repeat", repeatOn ? 1 : 0);
    },
  }, svg(ICONS.repeat, 10, { stroke: 2.2 }));

  const volDownBtn = h("button", {
    class: "np-icon",
    style: "width:16px;height:18px;display:grid;place-items:center;cursor:pointer;border:0;background:transparent;color:var(--dim-2);padding:0;",
    title: "Sesi Kıs",
    onclick: (e: Event) => {
      e.stopPropagation();
      void Bridge.mediaControl("volumeDown");
    },
  }, svg(ICONS.volume1, 12, { stroke: 1.8 }));

  const volUpBtn = h("button", {
    class: "np-icon",
    style: "width:16px;height:18px;display:grid;place-items:center;cursor:pointer;border:0;background:transparent;color:var(--dim-2);padding:0;",
    title: "Sesi Aç",
    onclick: (e: Event) => {
      e.stopPropagation();
      void Bridge.mediaControl("volumeUp");
    },
  }, svg(ICONS.volume3, 12, { stroke: 1.8 }));

  const controlsRow = h("div", {
    style: "display:flex;align-items:center;justify-content:center;gap:6px;width:100%;min-height:22px;margin-top:2px;",
  },
    repeatBtn,
    shuffleBtn,
    prevBtn,
    playBtn,
    nextBtn,
    volDownBtn,
    volUpBtn,
  );
  const topRow = h("div", {
    style: "display:flex;align-items:center;gap:8px;width:100%;min-width:0;",
  },
    coverWrap,
    h("div", { style: "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;justify-content:center;" },
      h("div", { style: "display:flex;align-items:center;gap:4px;min-width:0;" },
        svg(ICONS.musicNote, 9),
        titleSpan,
      ),
      artistText,
    ),
  );

  const musicCard = h("div", {
    class: "ov-music-card",
    style: "display:flex;flex-direction:column;justify-content:center;width:100%;height:100%;gap:1px;",
  },
    topRow,
    progressRow,
    controlsRow,
  );
  // ── Active Integration Pills Grid (Hızlı Erişim — 2x2 original Coucou pills) ──
  const pills = h("div", { class: "pills" });
  const middleEl = pills;
  let pillIds = "";
  const rightEl = h("div", {
    class: "ov-right-card",
    style: "display:flex;align-items:center;height:100%;padding:6px 10px;box-sizing:border-box;",
  }, musicCard);
  let lastPoll = 0;

  function fetchCover(artist: string, title: string) {
    const key = `${artist} ${title}`.trim();
    if (artCache.has(key)) {
      const cached = artCache.get(key)!;
      coverImg.src = cached;
      coverImg.style.display = "block";
      coverFallback.style.display = "none";
      return;
    }
    fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(key)}&entity=song&limit=1`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.results?.[0]?.artworkUrl100) {
          const highRes = data.results[0].artworkUrl100.replace("100x100bb", "600x600bb");
          artCache.set(key, highRes);
          coverImg.src = highRes;
          coverImg.style.display = "block";
          coverFallback.style.display = "none";
        } else {
          fetch(`https://api.deezer.com/search?q=${encodeURIComponent(key)}&limit=1`)
            .then((r) => r.json())
            .then((dz) => {
              const dzArt = dz?.data?.[0]?.album?.cover_xl || dz?.data?.[0]?.album?.cover_medium;
              if (dzArt) {
                artCache.set(key, dzArt);
                coverImg.src = dzArt;
                coverImg.style.display = "block";
                coverFallback.style.display = "none";
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }

  let pollInterval: number | null = null;
  let emptyPollCount = 0;
  let lastPositionUpdate = performance.now();
  const MAX_EMPTY_POLLS = 45;

  function pollMusic() {
    return Bridge.detectNowPlaying().then((track) => {
      if (track && track.title) {
        emptyPollCount = 0;
        isPlaying = track.playing;
        updatePlayIcon();
        if (State.musicPlaying !== track.playing) {
          State.musicPlaying = track.playing;
          State.notify();
        }
        titleSpan.textContent = track.title;
        artistText.textContent = track.artist || "Bilinmeyen Sanatçı";
        const srcLower = (track.source || "").toLowerCase();
        const albLower = (track.album || "").toLowerCase();
        const titLower = (track.title || "").toLowerCase();

        const isSpotify = srcLower.includes("spotify") || albLower.includes("spotify");
        const isSoundfy = srcLower.includes("soundfy") || albLower.includes("soundfy") || titLower.includes("soundfy");
        const isYT = (srcLower.includes("youtube") || albLower.includes("youtube") || titLower.includes("youtube")) && !isSoundfy;
        const isApple = srcLower.includes("apple") || srcLower.includes("itunes") || albLower.includes("apple");
        const isSoundCloud = srcLower.includes("soundcloud") || titLower.includes("soundcloud");

        clear(platformBadge);
        if (isSpotify) {
          platformBadge.style.background = "transparent";
          platformBadge.style.border = "none";
          platformBadge.title = "Spotify";
          platformBadge.append(svg(ICONS.spotify, 15, { fill: "#1DB954", evenOdd: true }));
        } else if (isSoundfy) {
          platformBadge.style.background = "#6366F1";
          platformBadge.style.border = "1.5px solid #18181b";
          platformBadge.title = "Soundfy";
          platformBadge.append(svg(ICONS.musicNote, 9, { fill: "#FFFFFF" }));
        } else if (isYT) {
          platformBadge.style.background = "#FF0000";
          platformBadge.style.border = "1.5px solid #18181b";
          platformBadge.title = "YouTube Music";
          platformBadge.append(svg(ICONS.youtube, 9, { fill: "#FFFFFF" }));
        } else if (isApple) {
          platformBadge.style.background = "#FA243C";
          platformBadge.title = "Apple Music";
          platformBadge.append(svg(ICONS.apple, 9, { fill: "#FFFFFF" }));
        } else if (isSoundCloud) {
          platformBadge.style.background = "#FF5500";
          platformBadge.title = "SoundCloud";
          platformBadge.append(svg(ICONS.soundcloud, 9, { fill: "#FFFFFF" }));
        } else {
          platformBadge.style.background = "#27272a";
          platformBadge.title = track.source || "Medya Oynatıcı";
          platformBadge.append(svg(ICONS.musicNote, 9, { fill: "#38bdf8" }));
        }

        if (track.duration && track.duration > 0) {
          trackDuration = track.duration;
          trackPosition = track.position ?? 0;
          lastPositionUpdate = performance.now();
          if (dragFraction === null) {
            const frac = trackDuration > 0 ? Math.min(1, Math.max(0, trackPosition / trackDuration)) : 0;
            progress.set(frac);
            elapsedText.textContent = formatTime(trackPosition);
            remainingText.textContent = `-${formatTime(Math.max(0, trackDuration - trackPosition))}`;
          }
          progressRow.style.display = "flex";
        } else if (track.position && track.position > 0) {
          trackPosition = track.position;
          lastPositionUpdate = performance.now();
          if (dragFraction === null) {
            progress.set(0);
            elapsedText.textContent = formatTime(trackPosition);
            remainingText.textContent = "--:--";
          }
          progressRow.style.display = "flex";
        } else if (trackDuration > 0) {
          lastPositionUpdate = performance.now();
          progressRow.style.display = "flex";
        } else {
          progressRow.style.display = "none";
        }

        if (track.coverUrl) {
          coverImg.src = track.coverUrl;
          coverImg.style.display = "block";
          coverFallback.style.display = "none";
        } else {
          fetchCover(track.artist, track.title);
        }
      } else {
        emptyPollCount++;
        if (emptyPollCount >= MAX_EMPTY_POLLS) {
          trackDuration = 0;
          trackPosition = 0;
          progressRow.style.display = "none";
          titleSpan.textContent = "Müzik Çalmıyor";
          artistText.textContent = "Spotify / YouTube Music başlatın";
          coverImg.style.display = "none";
          coverFallback.style.display = "grid";
          clear(platformBadge);
          platformBadge.style.background = "#27272a";
          platformBadge.title = "Medya Bekleniyor";
          platformBadge.append(svg(ICONS.musicNote, 9, { fill: "#71717a" }));
          isPlaying = false;
          updatePlayIcon();
          if (State.musicPlaying) {
            State.musicPlaying = false;
            State.notify();
          }
        }
      }
    }).catch(() => {});
  }

  function startPoll() {
    if (pollInterval != null) return;
    pollInterval = window.setInterval(() => {
      if (State.mode !== "expanded" || State.view !== "overview") {
        stopPoll();
        return;
      }
      if (isPlaying && trackDuration > 0 && dragFraction === null) {
        const now = performance.now();
        const elapsed = (now - lastPositionUpdate) / 1000;
        const currentPos = Math.min(trackDuration, trackPosition + elapsed);
        const frac = trackDuration > 0 ? Math.min(1, Math.max(0, currentPos / trackDuration)) : 0;
        progress.set(frac);
        elapsedText.textContent = formatTime(currentPos);
        remainingText.textContent = `-${formatTime(Math.max(0, trackDuration - currentPos))}`;
      }
      void pollMusic();
    }, 400);
  }

  function stopPoll() {
    if (pollInterval != null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  return {
    middleEl,
    rightEl,
    sync() {
      const others = State.otherTasks.slice(0, 4);
      const pillKey = others.map((t) => `${t.id}:${t.color}:${t.pillBadge ?? ""}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        for (const t of others) {
          pills.append(buildPill(t, actions));
        }
        pruneMiniBots();
      }

      if (State.mode === "expanded" && State.view === "overview") {
        startPoll();
      } else {
        stopPoll();
      }

      const now = performance.now();
      if (now - lastPoll > 400) {
        lastPoll = now;
        void pollMusic();
      }
    },
  };
}

function buildOverview(actions: ViewActions): ViewHost {
  /** The diff open in the left card (a FileDiff id), as activeDiffId on macOS. */
  let activeDiffId: number | null = null;
  const closeDiff = () => {
    activeDiffId = null;
    State.activeDiffId = null;
    State.notify();
  };
  const ticker = new Ticker((diffId) => {
    actions.blip();
    activeDiffId = diffId;
    State.activeDiffId = diffId;
    State.notify();
  });
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: tl("Open"), onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const dashboard = buildOverviewDashboard(actions);
  const middle = card(null, dashboard.middleEl);
  const right = card(null, dashboard.rightEl);
  // Opened from a plan pill in the header: stands in for the left card.
  const plan = new PlanCard();
  let planTimer: number | null = null;

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "middle" }, middle),
    h("div", { class: "right" }, right),
  );

  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | "plan" | "diff" | "spotify" | null = null;
  let cardKey = "";
  /** The list row highlighted at the last sync, to scroll only when it moves. */
  let shownSelection: number | null = null;

  // Leaving the overview or folding the island closes the diff, as on macOS.
  State.subscribe(() => {
    if (activeDiffId != null && (State.view !== "overview" || State.mode !== "expanded")) {
      activeDiffId = null;
    }
  });
  // Escape steps back out of the diff before it closes the island.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || activeDiffId == null || State.view !== "overview") return;
      e.stopImmediatePropagation();
      closeDiff();
    },
    true,
  );

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  /** The countdowns move every 30 s while a card is open, and only then. */
  function syncPlanTimer(open: boolean) {
    const stop = () => {
      if (planTimer != null) window.clearInterval(planTimer);
      planTimer = null;
    };
    if (!open) return stop();
    if (planTimer != null) return;
    planTimer = window.setInterval(() => {
      if (planCardOpen() && State.mode === "expanded") State.notify();
      else stop();
    }, 30_000);
  }

  return {
    el,
    tick(nowMs: number) {
      if (mode !== "ticker") return false;
      ticker.tick(nowMs);
      return ticker.animating;
    },
    command(command) {
      if (command === "openSelection") {
        // Ctrl+O: what a click on the highlighted row does.
        if (mode !== "card" || State.cardSelection == null) return;
        openRow(listRows(leftBody)[State.cardSelection]);
        return;
      }
      // Ctrl+E (⌘E, islandToggleDiff): closes the diff that is open, else
      // opens the focused pill's latest edit.
      if (activeDiffId != null) {
        closeDiff();
        return;
      }
      const task = State.focusTask;
      const diffs = task ? State.sessionDiffs.get(task.id) : undefined;
      const last = diffs?.[diffs.length - 1];
      if (last?.id == null) return;
      activeDiffId = last.id;
      State.notify();
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        activeDiffId = null;
        cardKey = "";
        mode = null;
      }

      // A workspace or agent pill with a live session keeps the ticker; every
      // other pill shows its own card, exactly like IntegrationCardView.
      const sessionActive = task != null && hasSessionTicker(task);

      const planOpen = planCardOpen();
      if (mode === "plan" && !planOpen) {
        mode = null;
        cardKey = "";
      }
      syncPlanTimer(planOpen);

      if (State.activeDiffId != null && activeDiffId !== State.activeDiffId) {
        activeDiffId = State.activeDiffId;
      }
      const diff = task && activeDiffId != null ? State.findDiff(task.id, activeDiffId) : null;
      if (!diff) {
        activeDiffId = null;
        State.activeDiffId = null;
      }
      if (planOpen) {
        if (mode !== "plan") {
          clear(leftBody);
          leftBody.append(plan.el);
          mode = "plan";
        }
        plan.sync();
      } else if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        // The agent's name is already the pill's: the label says what kind of
        // pill it is, as on the Mac (PillDefinition.sessionSubtitle).
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: t(sessionSubtitle(task.id)) }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          language(), task.id, task.color, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen || mode === "plan" || mode === "diff" ? "none" : "";

      // Ctrl+↓ Ctrl+↑ walk the open GitHub list (cardItemCount / cardSelection).
      const rows = mode === "card" ? listRows(leftBody) : [];
      State.cardItemCount = rows.length;
      if (State.cardSelection != null && State.cardSelection >= rows.length) State.cardSelection = null;
      highlightRow(rows, State.cardSelection, State.cardSelection !== shownSelection);
      shownSelection = State.cardSelection;

      dashboard.sync();

      el.classList.toggle("session-active", sessionActive);
      el.classList.toggle("has-diff", mode === "plan");
      if (mode === "plan") {
        if (right.firstElementChild !== plan.el) {
          clear(right);
          right.append(plan.el);
        }
        plan.sync();
      } else {
        if (right.firstElementChild !== dashboard.rightEl) {
          clear(right);
          right.append(dashboard.rightEl);
        }
      }
    },
  };
}

/**
 * IntegrationCardView.agentSessionActive: a workspace tool or an agent — or
 * any other tagged agent — with something going on.
 */
export function hasSessionTicker(task: AgentTask): boolean {
  // A pill made for an agent's session (Gemini CLI, Codex… not declared) only
  // exists while that session does: it keeps the ticker from the first event.
  if (task.source === "agent" && !task.isIntegration) return true;
  const category = pillDefinition(task.id)?.category;
  const isSession = category === "workspace" || category === "agent" ||
    (category == null && task.id.startsWith("agent_"));
  return isSession && (task.state !== "idle" || task.steps.length > 0);
}
export function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 20);
  const pill = h(
    "div",
    { class: "pill", title: label, onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: tl("Nothing running right now.") }),
      h("div", { class: "sub", text: tl("Drop a file or window, or ask me anything.") }),
    ),
    h("div", { class: "grow" }),
    btn(tl("Ask Claude"), "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

/** How long a fresh permission card ignores clicks on its buttons. */
const CLICK_GUARD_MS = 600;

/**
 * The ⌃ in the corner of a waiting card: folds the island to its compact size
 * and leaves the request waiting — nothing is answered (Mac #290). Opening the
 * island again brings the card back.
 */
function foldButton(actions: ViewActions): HTMLElement {
  return h(
    "button",
    { class: "icon-btn fold", title: tl("Later — keep it waiting"), onclick: () => actions.foldApproval() },
    svg(ICONS.chevronUp, 8, { stroke: 2.4 }),
  );
}

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" },
    card("amber", stack(116, 16, who, code, row), foldButton(actions)));
  let rowKey = "";
  // The card pops up under a cursor that was busy with something else: a click
  // meant for the window underneath must not land on Allow. Clicks in the first
  // moments after a new request appears are ignored.
  let shownFor: string | null = null;
  let shownAt = 0;
  const guarded = (d: "allow" | "deny") => () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS) return;
    actions.decide(d);
  };
  return {
    el,
    sync() {
      const req = State.pendingApproval?.requestId ?? null;
      if (req !== shownFor) {
        shownFor = req;
        shownAt = performance.now();
      }
      clear(who);
      who.append(agentWho(State.focusTask, t("needs permission")));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn(tl("Deny"), "secondary", guarded("deny"), "N"),
        btn(tl("Allow"), "primary", guarded("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title question-text" });
  const row = h("div", { class: "actions options" });
  const fold = foldButton(actions);
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row), fold));

  // Where we are in the request on screen: which question, what is answered so
  // far, and what is ticked in a pick-several question.
  let requestId = "";
  let index = 0;
  let answers: Record<string, string | string[]> = {};
  let picked = new Set<string>();
  // The buttons are only rebuilt when what they show changes: rebuilding them
  // between a mouse-down and a mouse-up would swallow the click.
  let rowKey = "";

  const next = (question: string, answer: string | string[], total: number) => {
    answers[question] = answer;
    picked = new Set();
    index += 1;
    if (index >= total) actions.answer(answers);
    else State.notify();
  };

  return {
    el,
    sync() {
      const questions = State.pendingApproval?.questions;
      clear(who);
      // Only a request that is waiting can be folded away and come back.
      fold.style.display = State.pendingApproval ? "" : "none";

      // A question that arrived as a notification has nothing to pick from.
      if (!questions) {
        who.append(agentWho(State.focusTask, t("is asking a question")));
        const task = State.focusTask;
        title.textContent = (task && lastTextStep(task.steps)) ?? t("Claude needs an answer.");
        if (rowKey !== "terminal") {
          rowKey = "terminal";
          clear(row);
          row.append(h("div", { class: "sub", text: tl("Answer it in your terminal.") }));
        }
        return;
      }

      if (State.pendingApproval!.requestId !== requestId) {
        requestId = State.pendingApproval!.requestId;
        index = 0;
        answers = {};
        picked = new Set();
      }
      const q = questions[Math.min(index, questions.length - 1)];
      const asking = questions.length > 1
        ? t("is asking ({index} of {total})", { index: index + 1, total: questions.length })
        : t("is asking");
      who.append(agentWho(State.focusTask, asking));
      title.textContent = q.question;
      title.title = q.question;

      const key = `${requestId}:${index}:${[...picked].join("|")}`;
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      for (const option of q.options) {
        const on = picked.has(option.label);
        const button = btn(option.label, on ? "primary" : "secondary", () => {
          if (!q.multiSelect) {
            next(q.question, option.label, questions.length);
            return;
          }
          if (on) picked.delete(option.label);
          else picked.add(option.label);
          State.notify();
        });
        if (option.description) button.title = option.description;
        row.append(button);
      }
      if (q.multiSelect) {
        const done = btn(tl("Done"), "primary", () => {
          if (picked.size > 0) next(q.question, [...picked], questions.length);
        });
        if (picked.size === 0) done.classList.add("off");
        row.append(done);
      }
      row.append(
        h("button", {
          class: "link-btn",
          style: "color:#8e939c",
          text: tl("Answer in terminal"),
          onclick: () => actions.answerInTerminal(),
        }),
      );
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn(tl("Retry"), "primary", () => actions.setView(State.defaultView())),
    btn(tl("Open in n8n"), "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      const isAntigravity = task?.id === "agent_antigravity"
        || (State.settings.chatProvider === "google-antigravity" && (task?.id === "integration_claude" || task?.source === "claudeCode"));
      const whoLabel = isAntigravity ? "Antigravity" : (task?.source === "n8n" ? "n8n" : task?.source === "agent" ? t("Agent") : "Claude Code");
      const dotColor = isAntigravity ? "#E879F9" : (task?.color ?? "#F5F6F8");
      const name = isAntigravity ? "Antigravity" : (task?.name ?? "VS Code");
      who.append(agentWho(task ? { ...task, name, color: dotColor } : null, whoLabel));
      title.textContent = task?.source === "n8n" ? t("Workflow stopped.") : t("Session stopped on an error.");
      detail.textContent = (task && lastTextStep(task.steps)) ?? t("No detail available.");
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title one-line" });
  const open = btn(tl("Open terminal"), "primary", () => actions.openTerminal());
  const row = h("div", { class: "actions" },
    open,
    btn(tl("OK"), "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const task = State.focusTask;
      const isAntigravity = task?.id === "agent_antigravity"
        || (State.settings.chatProvider === "google-antigravity" && (task?.id === "integration_claude" || task?.source === "claudeCode"));
      const dotColor = isAntigravity ? "#E879F9" : (task?.color ?? "#F5F6F8");
      const name = isAntigravity ? "Antigravity" : (task?.name ?? "VS Code");
      const labelText = isAntigravity ? "Görev tamamlandı" : (task?.source === "agent" ? t("finished") : t("finished"));
      who.append(agentWho(task ? { ...task, name, color: dotColor } : null, labelText));
      title.textContent = task?.finalLine || (task && lastTextStep(task.steps)) || t("Session finished");
      // Sessions from the Claude desktop app live there, not in a terminal.
      const label = task?.id === "agent_claude-desktop" ? t("Open Claude") : t("Open terminal");
      const span = open.firstElementChild as HTMLElement;
      if (span.textContent !== label) span.textContent = label;
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: tl("Too many hits at once.") }),
    h("div", { class: "sub", text: tl("Give me a sec — back to work in three seconds.") }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const autoOptions = [
    { val: 10, label: "10s" },
    { val: 15, label: "15s" },
    { val: 30, label: "30s" },
    { val: 0, label: "Off" },
  ];
  const segButtons = autoOptions.map((opt) =>
    h("button", { onclick: () => actions.setAutoClose(opt.val) }, opt.label),
  );
  const antigravityBadge = h("span", {
    class: "status-badge",
    style: "cursor:pointer;display:inline-flex;align-items:center;gap:6px;",
    onclick: () => actions.openSettingsWindow(),
  });
  const localBadge = h("span", {
    class: "status-badge",
    style: "cursor:pointer;display:inline-flex;align-items:center;gap:6px;",
    onclick: () => actions.openSettingsWindow(),
  });
  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: tl("Sound") }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px;align-items:center;" },
      antigravityBadge,
      localBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: tl("Settings…"),
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      if (s.autoCloseInterval <= 0) {
        autoLabel.textContent = "Auto-close · Off";
      } else {
        autoLabel.textContent = t("Auto-close · {seconds}s", { seconds: Math.round(s.autoCloseInterval) });
      }
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === autoOptions[i].val));
      clear(antigravityBadge);
      void Bridge.antigravityAccounts().then((accs) => {
        const active = accs.find((a) => a.active);
        clear(antigravityBadge);
        if (active) {
          antigravityBadge.append(
            dot("#22C55E", 6),
            h("span", { text: `Antigravity (${active.email.split("@")[0]})` }),
          );
        } else {
          antigravityBadge.append(
            dot("#F59E0B", 6),
            h("span", { text: "Antigravity (Giriş yapın)" }),
          );
        }
      });

      clear(localBadge);
      const isLocalOn = s.ollamaUrl !== "" || s.lmstudioUrl !== "" || s.customUrl !== "";
      localBadge.append(
        dot(isLocalOn ? "#22C55E" : "#71717A", 6),
        h("span", { text: isLocalOn ? "Yerel Model (Bağlı)" : "Yerel Model" }),
      );
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: Msg, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange, actions));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  map.set("recap", buildRecap(actions));
  map.set("wardrobe", buildWardrobe(actions));
  map.set("music", buildMusic(actions));
  map.set("calendar", buildCalendar(actions));
  map.set("snip", buildSnip(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder(tl("Sending by email isn't in this version."), ""));
  map.set("searching", buildPlaceholder(tl("Claude is searching…"), ""));
  map.set("result", buildPlaceholder(tl("Result"), ""));
  return map;
}
