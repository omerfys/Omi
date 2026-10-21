// Overview task ticker — port of TickerView (V2) from IslandViewContent.swift.
//
// Three rows: completed (A), current → completed (B), incoming (C). Every row
// position is recomputed from a single clock in `tick()`, driven by the island's
// frame loop — no CSS transitions and no timers. Chaining CSS transitions with a
// reset timer let two rows land on the same line when steps arrived in bursts,
// and any step that arrived mid-animation was dropped outright. Steps are now
// queued instead, so a burst scrolls past rather than vanishing.

//
// Diff steps (see core/diff.ts) render as the file name followed by +N −M, and
// a click on one opens its diff. After Stop the card holds Claude's final
// message: no shimmer, no chevron, the ✓ on every row (TickerRowView isActive
// = false on macOS).

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { cubicBezier, clamp, lerp } from "../core/anim";
import { parseDiffStep, type DiffStep } from "../core/diff";
import type { AgentTask } from "../core/state";

const ROW_H = 22;
/** One step transition, milliseconds. */
const DURATION = 380;
/** Beyond this many queued steps we stop trying to show them all. */
const MAX_QUEUE = 4;
const COMPLETED_SCALE = 11.5 / 13; // 0.885 — the completed font size
const EASE = cubicBezier(0.4, 0, 0.2, 1);

/** The current row's text once the turn is over (TickerRowView staticColor). */
const STILL_CURRENT = "#c9cdd4";
const DIM = "#6b7079";

interface Row {
  el: HTMLElement;
  iconWrap: HTMLElement;
  body: HTMLElement;
  shimmer: HTMLElement;
  dim: HTMLElement;
  /** +N −M, attached to the row only while it shows a diff. */
  counts: HTMLElement;
  plus: HTMLElement;
  minus: HTMLElement;
  text: string;
  /** Set when the row shows a file diff. */
  diff: DiffStep | null;
}

function getStepIcon(text: string): SVGElement {
  const lower = text.toLowerCase();
  if (lower.includes("prep") || lower.includes("bash") || lower.includes("shell") || lower.includes("terminal") || lower.includes("run") || lower.includes("komut")) {
    return svg(ICONS.terminal, 12, { stroke: 2 });
  }
  if (lower.includes("copy") || lower.includes("output") || lower.includes("kopyala")) {
    return svg(ICONS.copy, 12);
  }
  if (lower.includes("read") || lower.includes("view") || lower.includes("oku") || lower.includes("doc")) {
    return svg(ICONS.doc, 12);
  }
  if (lower.includes("edit") || lower.includes("patch") || lower.includes("write") || lower.includes("yaz") || lower.includes("düzenle") || lower.includes("eklendi") || lower.includes("silindi")) {
    return svg(ICONS.pencil, 12);
  }
  if (lower.includes("done") || lower.includes("finish") || lower.includes("tamam")) {
    return svg(ICONS.check, 11, { stroke: 2.2 });
  }
  return svg(ICONS.laptop, 12);
}

function makeRow(): Row {
  const iconWrap = h("span", { class: "tick-icon", style: "position:relative;width:14px;height:14px;display:grid;place-items:center;flex:0 0 14px;" });
  const shimmer = h("span", { class: "tick-text shimmer" });
  const dim = h("span", {
    class: "tick-text",
    style: `position:absolute;top:0;left:0;right:0;color:${DIM}`,
  });
  const body = h("span", { style: "position:relative;flex:1 1 auto;min-width:0" }, shimmer, dim);
  const plus = h("span", { class: "plus" });
  const minus = h("span", { class: "minus" });
  const counts = h("span", { class: "tick-count" }, plus, minus);
  const el = h(
    "div",
    { class: "ticker-row" },
    iconWrap,
    body,
  );
  return { el, iconWrap, body, shimmer, dim, counts, plus, minus, text: "", diff: null };
}

function setText(row: Row, text: string) {
  if (row.text === text) return;
  row.text = text;
  const diff = parseDiffStep(text);
  row.diff = diff;
  const shown = diff
    ? diff.added > 0 && diff.removed > 0
      ? `+${diff.added} eklendi, −${diff.removed} silindi (${diff.filename})`
      : diff.added > 0
        ? `+${diff.added} eklendi (${diff.filename})`
        : diff.removed > 0
          ? `−${diff.removed} silindi (${diff.filename})`
          : diff.filename
    : text;
  row.shimmer.textContent = shown;
  row.dim.textContent = shown;
  clear(row.iconWrap);
  row.iconWrap.append(getStepIcon(diff ? "eklendi" : text));
  row.body.style.flex = "1 1 auto";
  if (row.counts.parentNode === row.el) {
    row.counts.remove();
  }
  row.el.classList.remove("diff");
}

/**
 * Places a row. `phase` 0 = current (shimmering, full size), 1 = completed
 * (dim, shifted up-left and scaled down) — same crossfades as the Swift view.
 * `still` is the finished look: static text, ✓ only, nothing animating.
 */
function place(row: Row, y: number, phase: number, opacity: number, still: boolean) {
  const scale = 1 - phase * (1 - COMPLETED_SCALE);
  row.el.style.transform = `translate(${-phase * 10}px, ${y}px) scale(${scale})`;
  row.el.style.opacity = String(opacity);
  if (still) {
    row.iconWrap.style.color = "#4ade80";
    row.shimmer.style.opacity = "0";
    row.dim.style.opacity = "1";
    row.dim.style.color = phase < 0.5 ? STILL_CURRENT : DIM;
  } else {
    const isCurrent = phase < 0.3;
    row.iconWrap.style.color = isCurrent ? "#ffffff" : DIM;
    row.shimmer.style.opacity = String(clamp(1 - phase * 1.6, 0, 1));
    row.dim.style.opacity = String(clamp(phase * 2 - 0.4, 0, 1));
    row.dim.style.color = isCurrent ? "#ffffff" : DIM;
    row.dim.style.fontWeight = isCurrent ? "600" : "500";
    row.shimmer.style.fontWeight = isCurrent ? "600" : "500";
  }
  row.shimmer.style.animationPlayState = still ? "paused" : "";
}

export class Ticker {
  readonly el: HTMLElement;
  private a = makeRow(); // completed
  private b = makeRow(); // current
  private c = makeRow(); // incoming
  private queue: string[] = [];
  private startMs: number | null = null;
  private displayIndex = -1;
  /** True once Claude has finished: the final message holds still. */
  private still = false;

  /** `onDiffTap` receives the diff id of a clicked diff row. */
  constructor(onDiffTap?: (diffId: number) => void) {
    this.el = h("div", { class: "ticker" }, this.a.el, this.b.el, this.c.el);
    // The completed and the current row answer a click, as on macOS; the
    // incoming row is only ever seen mid-slide.
    for (const row of [this.a, this.b]) {
      row.el.addEventListener("click", () => {
        if (row.diff && onDiffTap) onDiffTap(row.diff.diffId);
      });
    }
    this.rest();
  }

  /** The state between transitions: completed on top, current below. */
  private rest() {
    place(this.a, 0, 1, 1, this.still);
    place(this.b, ROW_H, 0, 1, this.still);
    place(this.c, ROW_H * 2, 0, 0, this.still);
  }

  get animating(): boolean {
    return this.startMs != null || this.queue.length > 0;
  }

  sync(task: AgentTask | null) {
    const steps = task?.steps ?? [];
    // Where the newest step sits in the whole session, not in `steps`: that
    // list is capped at 20, and counting inside it made the ticker stop for
    // good at the twentieth step of a session.
    const newest = steps.length === 0 ? -1 : (task?.stepSeq ?? steps.length - 1);

    const still = !!task?.finalLine;
    if (still !== this.still) {
      this.still = still;
      // Mid-slide, the next frame places every row with the new look anyway.
      if (this.startMs == null) this.rest();
    }

    // First render, or the session restarted (steps were cleared): drop
    // straight into place rather than scroll.
    if (this.displayIndex < 0 || newest < this.displayIndex) {
      this.queue = [];
      this.startMs = null;
      this.displayIndex = newest;
      setText(this.a, steps.at(-2) ?? "…");
      setText(this.b, steps.at(-1) ?? "…");
      this.rest();
      return;
    }

    const fresh = Math.min(newest - this.displayIndex, steps.length);
    if (fresh > 0) this.queue.push(...steps.slice(-fresh));
    this.displayIndex = newest;
    if (this.queue.length > MAX_QUEUE) {
      this.queue = this.queue.slice(-MAX_QUEUE);
    }
  }

  /** Called every frame by the island while the overview is on screen. */
  tick(nowMs: number) {
    if (this.startMs == null) {
      if (this.queue.length === 0) return;
      setText(this.c, this.queue[0]);
      place(this.c, ROW_H * 2, 0, 0, this.still);
      this.startMs = nowMs;
    }

    const p = clamp((nowMs - this.startMs) / DURATION, 0, 1);
    const e = EASE(p);

    // A leaves upwards and fades a little faster than it moves, as on macOS.
    place(this.a, lerp(0, -ROW_H, e), 1, clamp(1 - p * 1.35, 0, 1), this.still);
    place(this.b, lerp(ROW_H, 0, e), e, 1, this.still);
    place(this.c, lerp(ROW_H * 2, ROW_H, e), 0, e, this.still);

    if (p < 1) return;

    // Commit: the current row becomes the completed one, the incoming row the
    // current one. Texts move, elements stay put — no reordering, no overlap.
    setText(this.a, this.b.text);
    setText(this.b, this.c.text);
    this.queue.shift();
    this.startMs = null;
    this.rest();
  }
}
