// The coloured band on top of each page of the Coucou window: a deep black
// with the page's colour breathing in a corner, particles that drift all the
// time and move away from the pointer, and the page's little Mochis walking on
// its floor — they hop, look around, wave, and react when poked. Also the
// glowing cards and the Mochis of empty pages. Port of FlowHubMochis.swift.
//
// One animation loop draws every live canvas; it stops when none is on screen
// or the window is hidden, so a hidden window costs nothing.

import { BotEngine, hexToRGB } from "../mochi/engine";
import type { BotEmoteName, BotStateName } from "../core/layout";
import type { Outfit } from "../mochi/wardrobe";

interface Animated {
  el: HTMLCanvasElement;
  draw(dt: number, t: number): void;
  /** Pages are built before they are put in the window: dropped only once gone. */
  shown?: boolean;
  born?: number;
}

const live = new Set<Animated>();
let frame: number | null = null;
let last = performance.now();
const start = performance.now();

function loop(now: number) {
  frame = null;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = (now - start) / 1000;
  for (const a of live) {
    if (!a.el.isConnected) {
      // Built but not shown yet: wait for it (a few seconds at most).
      if (a.shown || now - (a.born ??= now) > 5000) live.delete(a);
      continue;
    }
    a.shown = true;
    a.draw(dt, t);
  }
  if (live.size > 0 && document.visibilityState === "visible") frame = requestAnimationFrame(loop);
}

function wake() {
  if (frame === null && live.size > 0 && document.visibilityState === "visible") {
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }
}

document.addEventListener("visibilitychange", wake);

function add(a: Animated) {
  live.add(a);
  wake();
}

function fit(canvas: HTMLCanvasElement): { w: number; h: number; ctx: CanvasRenderingContext2D | null } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, ctx };
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRGB(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${Math.max(0, Math.min(1, alpha))})`;
}

// ── The backdrop ──────────────────────────────────────────────────────────────

/** Flowing ambient aurora wave animation on `canvas`; `pointerFrom` provides interactive spotlight. */
export function backdrop(canvas: HTMLCanvasElement, color: string, pointerFrom: HTMLElement, radius = 18) {
  let pointer: { x: number; y: number } | null = null;
  let strength = 0;
  pointerFrom.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  pointerFrom.addEventListener("pointerleave", () => (pointer = null));

  add({
    el: canvas,
    draw(dt, t) {
      const { w, h, ctx } = fit(canvas);
      if (!ctx || w === 0) return;
      strength += ((pointer ? 1 : 0) - strength) * Math.min(1, dt * 4);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, radius);
      ctx.clip();

      // Deep dark sleek glass backdrop
      ctx.fillStyle = "#07080a";
      ctx.fillRect(0, 0, w, h);

      // 1. Right corner ambient breathing glow
      const breath = 0.88 + 0.12 * Math.sin(t * 0.8);
      const rad = ctx.createRadialGradient(w * 0.88, h * 0.45, 0, w * 0.88, h * 0.45, Math.max(w, h) * 0.52 * breath);
      rad.addColorStop(0, rgba(color, 0.22 * breath));
      rad.addColorStop(0.5, rgba(color, 0.06));
      rad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = rad;
      ctx.fillRect(0, 0, w, h);

      // 2. Creative flowing ambient aurora wave ribbons
      for (let layer = 0; layer < 3; layer++) {
        ctx.beginPath();
        ctx.moveTo(0, h);
        const freq1 = 0.0035 + layer * 0.0012;
        const freq2 = 0.007 + layer * 0.002;
        const speed = (0.45 + layer * 0.25) * (layer % 2 === 0 ? 1 : -0.8);
        const amp = 14 + layer * 9;
        const baseH = h * (0.72 - layer * 0.14);

        for (let x = 0; x <= w; x += 12) {
          const y = baseH +
            Math.sin(x * freq1 + t * speed) * amp +
            Math.cos(x * freq2 - t * 0.35) * (amp * 0.4);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, rgba(color, 0.02 + layer * 0.02));
        grad.addColorStop(0.5, rgba(color, 0.06 + layer * 0.03));
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // 3. Subtle interactive spotlight following pointer
      if (pointer && strength > 0.01) {
        const spot = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 160);
        spot.addColorStop(0, rgba(color, 0.1 * strength));
        spot.addColorStop(0.6, rgba(color, 0.02 * strength));
        spot.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = spot;
        ctx.fillRect(0, 0, w, h);
      }

      ctx.restore();
    },
  });
}

// ── The Mochis ────────────────────────────────────────────────────────────────

export interface MochiSpec {
  color: string;
  /** Body width in CSS pixels. */
  size: number;
  /** Where he starts along the floor, 0…1. */
  start: number;
  outfit?: Outfit;
  state?: BotStateName;
  /** False: he stays where he is (working, thinking, asleep). */
  roams?: boolean;
}

const EMOTES: BotEmoteName[] = ["love", "happy", "wink", "proud", "surprised"];

class Walker {
  engine = new BotEngine();
  x = 0;
  target = 0;
  dir = 1;
  hop = 0;
  hopV = 0;
  pause = 1 + Math.random() * 2;
  nextEvent = 2 + Math.random() * 4;
  waving = 0;

  constructor(public spec: MochiSpec) {
    this.engine.bodyColor = hexToRGB(spec.color);
    this.engine.setState(spec.state ?? "idle", true);
    if (spec.outfit && spec.outfit !== "none") this.engine.setOutfit(spec.outfit, false);
  }
}

/** The page's Mochis on the band's floor, in the right part of `canvas`. */
export function troupe(canvas: HTMLCanvasElement, cast: MochiSpec[], _width?: number) {
  const spec = cast[0] ?? { color: "#F8FAFC", size: 78, start: 0.9 };
  const walker = new Walker(spec);
  let pointer: { x: number; y: number } | null = null;
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  canvas.addEventListener("pointerleave", () => (pointer = null));
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (Math.abs(px - walker.x) < walker.spec.size * 0.6) {
      walker.engine.slap();
      walker.hopV = 240;
      walker.engine.triggerEmote(EMOTES[Math.floor(Math.random() * EMOTES.length)]);
    }
  });

  add({
    el: canvas,
    draw(dt, t) {
      const { w: cw, h: ch, ctx } = fit(canvas);
      if (!ctx || cw === 0) return;
      const s = Math.max(72, Math.min(84, walker.spec.size));
      // Positioned stably on the right side of the banner (as circled in red)
      walker.x = cw - s / 2 - 24;
      const floor = ch - 12;

      // Breathing and floating micro-motion
      const breath = Math.sin(t * 2.5) * 3;

      // Idle emotes
      walker.nextEvent -= dt;
      if (walker.nextEvent <= 0) {
        walker.nextEvent = 4 + Math.random() * 6;
        const roll = Math.random();
        if (roll < 0.3) walker.hopV = 160;
        else if (roll < 0.65) walker.engine.triggerEmote(EMOTES[Math.floor(Math.random() * EMOTES.length)]);
        else if (roll < 0.85) walker.engine.greet();
      }

      // Ballistic hop on poke or idle jump
      if (walker.hopV !== 0 || walker.hop > 0) {
        walker.hopV -= 850 * dt;
        walker.hop = Math.max(0, walker.hop + walker.hopV * dt);
        if (walker.hop === 0 && walker.hopV < 0) {
          walker.hopV = 0;
          walker.engine.squash();
        }
      }

      // Eyes smoothly track cursor over the banner
      if (pointer) {
        walker.engine.lookX = Math.max(-1, Math.min(1, (pointer.x - walker.x) / 140));
        walker.engine.lookY = Math.max(-1, Math.min(1, (pointer.y - (floor - s * 0.6)) / 100));
      } else {
        walker.engine.lookX = Math.sin(t * 0.7) * 0.25;
        walker.engine.lookY = 0.05 + 0.08 * Math.sin(t * 1.5);
      }
      walker.engine.update(dt);

      const box = s;
      ctx.clearRect(0, 0, cw, ch);
      ctx.save();
      ctx.translate(walker.x - box / 2, floor - box * 0.78 - walker.hop + breath);

      // Floor shadow beneath Omi that scales when hopping
      ctx.fillStyle = `rgba(0,0,0,${0.35 * (1 - Math.min(1, walker.hop / 50))})`;
      ctx.beginPath();
      ctx.ellipse(box / 2, box * 0.78 + walker.hop - breath - 1, s * 0.32, s * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();

      walker.engine.draw(ctx, box, box);
      ctx.restore();
    },
  });
}

/** One Mochi alone (the sidebar's logo, an empty page). */
export function liveMochi(canvas: HTMLCanvasElement, color = "#F5F6F8", state: BotStateName = "idle") {
  const engine = new BotEngine();
  engine.bodyColor = hexToRGB(color);
  engine.setState(state, true);
  canvas.addEventListener("click", () => engine.slap());
  let mouse: { x: number; y: number } | null = null;
  window.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    mouse = { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
  });
  add({
    el: canvas,
    draw(dt) {
      const { w, h, ctx } = fit(canvas);
      if (!ctx || w === 0) return;
      if (mouse) {
        engine.lookX = Math.max(-1, Math.min(1, mouse.x / 300));
        engine.lookY = Math.max(-1, Math.min(1, mouse.y / 300));
      }
      engine.update(dt);
      ctx.clearRect(0, 0, w, h);
      engine.draw(ctx, w, h);
    },
  });
  return engine;
}

// ── Page themes ───────────────────────────────────────────────────────────────

export interface Theme {
  color: string;
  cast: MochiSpec[];
}

const m = (color: string, size: number, start: number, extra: Partial<MochiSpec> = {}): MochiSpec => ({
  color, size, start, ...extra,
});

export const THEMES: Record<string, Theme> = {
  general: {
    color: "#60A5FA",
    cast: [m("#F8FAFC", 78, 0.9, { outfit: "scarf", state: "idle" })],
  },
  agents: {
    color: "#38BDF8",
    cast: [m("#F8FAFC", 78, 0.9, { outfit: "sunglasses", state: "working" })],
  },
  chat: {
    color: "#818CF8",
    cast: [m("#F8FAFC", 78, 0.9, { outfit: "roundGlasses", state: "thinking" })],
  },
  voice: {
    color: "#F97316",
    cast: [m("#F8FAFC", 78, 0.9, { outfit: "beanie", state: "idle" })],
  },
  integrations: {
    color: "#A78BFA",
    cast: [m("#F8FAFC", 78, 0.9, { outfit: "bow", state: "idle" })],
  },
  shortcuts: {
    color: "#38BDF8",
    cast: [m("#F8FAFC", 78, 0.9, { outfit: "sunglasses", state: "idle" })],
  },
  gamemode: {
    color: "#10B981",
    cast: [m("#F8FAFC", 78, 0.9, { outfit: "crown", state: "idle" })],
  },
};

/** The band itself: title, line, actions, and the Mochis. */
export function hero(page: string, title: string, subtitle: string | null, actions: HTMLElement[] = [], compact = false): HTMLElement {
  const theme = THEMES[page] ?? THEMES.general;
  const el = document.createElement("div");
  el.className = compact ? "hub-hero compact" : "hub-hero";
  el.style.setProperty("--hero-line", rgba(theme.color, 0.16));
  const back = document.createElement("canvas");
  back.className = "backdrop";
  const mochis = document.createElement("canvas");
  mochis.className = "troupe";
  const copy = document.createElement("div");
  copy.className = "copy";
  const h1 = document.createElement("h1");
  h1.textContent = title;
  copy.append(h1);
  if (subtitle) {
    const p = document.createElement("p");
    p.textContent = subtitle;
    copy.append(p);
  }
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "actions";
    row.append(...actions);
    copy.append(row);
  }
  el.append(back, mochis, copy);
  backdrop(back, theme.color, el);
  troupe(mochis, theme.cast, compact ? 280 : 340);
  return el;
}

/** A card in a colour: the band's black and particles behind `content`. */
export function glowCard(color: string, ...content: (HTMLElement | string)[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "hub-glow";
  el.style.setProperty("--glow-line", rgba(color, 0.18));
  const canvas = document.createElement("canvas");
  const inner = document.createElement("div");
  inner.className = "inner";
  inner.append(...content);
  el.append(canvas, inner);
  backdrop(canvas, color, el, 14);
  return el;
}

/** An empty page: a Mochi asleep, and a line. */
export function emptyState(text: string, state: BotStateName = "sleeping", color = "#F5F6F8"): HTMLElement {
  const el = document.createElement("div");
  el.className = "hub-empty";
  const canvas = document.createElement("canvas");
  const p = document.createElement("div");
  p.textContent = text;
  el.append(canvas, p);
  liveMochi(canvas, color, state);
  return el;
}
