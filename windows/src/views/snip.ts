// Omi Snipping & Screen Markup Tool View
// Works directly with Windows Snipping Tool (ms-screenclip:) and clipboard.
// Directly displays the screenshot preview in the card — no placeholder buttons.
// Freehand pen, arrow, rectangle, highlighter, colors, undo stack.
// "Chat'e Aktar" tags the annotated/cropped image directly into Omi Chat.

import { h, clear, svg } from "./dom";
import { Bridge, type ScreenshotResult } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";

export function buildSnip(actions: ViewActions): ViewHost {
  type ToolMode = "pen" | "arrow" | "rect" | "highlighter" | "crop";

  let activeShot: ScreenshotResult | null = null;
  let toolMode: ToolMode = "pen";
  let currentColor = "#ef4444";
  let currentWidth = 3;
  let isCapturing = false;
  let isPaletteExpanded = false;

  // Canvas drawing state
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let isDrawing = false;
  let startX = 0;
  let startY = 0;
  let snapshotBeforeDrag: ImageData | null = null;
  const undoStack: ImageData[] = [];
  let baseImg: HTMLImageElement | null = null;

  // DOM Elements
  const toolsBar = h("div", { class: "snip-toolbar", style: "display:flex;align-items:center;gap:2px;" });
  const actionsBar = h("div", { style: "display:flex;align-items:center;gap:4px;margin-left:auto;flex-shrink:0;" });
  const head = h(
    "div",
    { style: "display:flex;align-items:center;justify-content:space-between;gap:4px;min-height:26px;margin-bottom:6px;padding-right:0;" },
    toolsBar,
    actionsBar,
  );

  const container = h("div", {
    class: "snip-container",
    style: "flex:1 1 auto;min-height:0;position:relative;border-radius:12px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.08);overflow:hidden;display:flex;align-items:center;justify-content:center;",
  });
  const emptyPlaceholder = h("div", {
    class: "snip-empty-placeholder",
    style: "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;position:absolute;inset:0;color:var(--dim-2);user-select:none;text-align:center;",
  },
    svg(ICONS.camera, 24, { stroke: 1.6 }),
    h("span", { style: "font-size:12.5px;font-weight:600;color:var(--ink);", text: "Henüz ekran görüntüsü alınmadı" }),
    h("span", { style: "font-size:11px;color:var(--dim-3);max-width:280px;", text: "Yukarıdaki 'Alan Seç' veya 'Tam Ekran' butonlarına basarak masaüstünden görüntü alabilirsiniz." }),
  );

  const loadingNoticeSpan = h("span", { text: "Ekran görüntüsü alınıyor..." });
  const loadingNotice = h("div", {
    style: "display:none;position:absolute;inset:0;background:rgba(18,20,26,0.85);backdrop-filter:blur(8px);flex-direction:column;align-items:center;justify-content:center;gap:8px;z-index:20;font-size:12px;color:var(--ink);",
  },
    svg(ICONS.camera, 20),
    loadingNoticeSpan,
  );

  // Canvas styles
  canvas.style.display = "none";
  canvas.style.maxWidth = "100%";
  canvas.style.maxHeight = "100%";
  canvas.style.objectFit = "contain";
  canvas.style.borderRadius = "8px";
  canvas.style.cursor = "crosshair";
  canvas.style.boxShadow = "0 8px 24px rgba(0,0,0,0.5)";

  function getCanvasCoords(e: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function pushUndo() {
    if (!ctx) return;
    if (undoStack.length >= 20) undoStack.shift();
    undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }

  function drawArrow(x0: number, y0: number, x1: number, y1: number, color: string, width: number) {
    if (!ctx) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";

    const headLength = Math.max(12, width * 4);
    const angle = Math.atan2(y1 - y0, x1 - x0);

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(
      x1 - headLength * Math.cos(angle - Math.PI / 6),
      y1 - headLength * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      x1 - headLength * Math.cos(angle + Math.PI / 6),
      y1 - headLength * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  }

  canvas.addEventListener("mousedown", (e) => {
    if (!ctx || !activeShot) return;
    isDrawing = true;
    const pt = getCanvasCoords(e);
    startX = pt.x;
    startY = pt.y;
    snapshotBeforeDrag = ctx.getImageData(0, 0, canvas.width, canvas.height);

    if (toolMode === "pen" || toolMode === "highlighter") {
      pushUndo();
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.strokeStyle = currentColor;
      ctx.lineWidth = toolMode === "highlighter" ? 18 : currentWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = toolMode === "highlighter" ? 0.35 : 1.0;
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!ctx || !isDrawing) return;
    const pt = getCanvasCoords(e);

    if (toolMode === "pen" || toolMode === "highlighter") {
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
    } else if (snapshotBeforeDrag) {
      ctx.putImageData(snapshotBeforeDrag, 0, 0);
      ctx.globalAlpha = 1.0;

      if (toolMode === "rect") {
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = currentWidth;
        const w = pt.x - startX;
        const h = pt.y - startY;
        ctx.strokeRect(startX, startY, w, h);
      } else if (toolMode === "arrow") {
        drawArrow(startX, startY, pt.x, pt.y, currentColor, currentWidth);
      } else if (toolMode === "crop") {
        ctx.save();
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        const w = pt.x - startX;
        const h = pt.y - startY;
        ctx.strokeRect(startX, startY, w, h);
        ctx.restore();
      }
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (!ctx || !isDrawing) return;
    isDrawing = false;
    ctx.globalAlpha = 1.0;

    if (toolMode === "crop" && snapshotBeforeDrag) {
      const pt = getCanvasCoords(e);
      const minX = Math.min(startX, pt.x);
      const minY = Math.min(startY, pt.y);
      const w = Math.abs(pt.x - startX);
      const h = Math.abs(pt.y - startY);

      if (w > 20 && h > 20) {
        ctx.putImageData(snapshotBeforeDrag, 0, 0);
        const cropped = ctx.getImageData(minX, minY, w, h);
        pushUndo();
        canvas.width = w;
        canvas.height = h;
        ctx.putImageData(cropped, 0, 0);
        Sound.play("blip");
        setTool("pen");
      } else {
        ctx.putImageData(snapshotBeforeDrag, 0, 0);
      }
    } else if (toolMode === "rect" || toolMode === "arrow") {
      pushUndo();
    }
    snapshotBeforeDrag = null;
  });

  function loadImageToCanvas(dataUrl: string) {
    const img = new Image();
    img.onload = () => {
      baseImg = img;
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        undoStack.length = 0;
        pushUndo();
      }
      emptyPlaceholder.style.display = "none";
      canvas.style.display = "block";
      loadingNotice.style.display = "none";
      renderToolbar();
      renderActionsBar();
    };
    img.src = dataUrl;
  }

  async function triggerSnip(mode: "snip" | "fullscreen" | "clipboard" = "snip") {
    if (isCapturing) return;
    isCapturing = true;
    loadingNoticeSpan.textContent = mode === "snip"
      ? "Masaüstünde alan seçimi bekleniyor (İptal: Esc / Sağ Tık)..."
      : "Ekran görüntüsü yakalanıyor...";
    loadingNotice.style.display = "flex";
    renderActionsBar();
    try {
      const shot = await Bridge.takeScreenshot(mode);
      activeShot = shot;
      Sound.play("approve");
      if (shot.dataUrl) {
        loadImageToCanvas(shot.dataUrl);
      }
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes("iptal") || msg.includes("cancel")) {
        // User cancelled area selection with Esc or right-click: no error sound, preserve canvas
      } else {
        console.error("Snip capture error:", err);
        Sound.play("error");
      }
    } finally {
      loadingNotice.style.display = "none";
      isCapturing = false;
      renderActionsBar();
    }
  }

  async function exportToChat() {
    if (!ctx) return;
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const saved = await Bridge.saveTempImage(dataUrl);
      State.droppedFile = { name: saved.name, path: saved.path };
      State.promptContext = { kind: "file", name: saved.name, path: saved.path };

      // Ensure the currently active chat session is preserved or loaded
      if (!State.activeSessionId) {
        State.loadChatSessions();
      }
      if (!State.activeSessionId) {
        State.activeSessionId = "chat_" + Date.now();
      }

      Sound.play("finish");
      State.notify();
      actions.setView("prompt");
    } catch (err) {
      console.error("Export to chat error:", err);
      Sound.play("error");
    }
  }

  async function copyImage() {
    try {
      canvas.toBlob((blob) => {
        if (!blob) return;
        const item = new ClipboardItem({ "image/png": blob });
        navigator.clipboard.write([item]).then(() => {
          Sound.play("blip");
        }).catch(() => {});
      }, "image/png");
    } catch (err) {
      console.error("Copy error:", err);
    }
  }

  function setTool(mode: ToolMode) {
    toolMode = mode;
    renderToolbar();
  }

  function setColor(col: string) {
    currentColor = col;
    renderToolbar();
  }

  function undo() {
    if (!ctx || undoStack.length <= 1) return;
    undoStack.pop();
    const prev = undoStack[undoStack.length - 1];
    if (prev) {
      canvas.width = prev.width;
      canvas.height = prev.height;
      ctx.putImageData(prev, 0, 0);
      Sound.play("blip");
    }
  }

  function clearCanvas() {
    if (!ctx || !baseImg) return;
    pushUndo();
    canvas.width = baseImg.naturalWidth || baseImg.width;
    canvas.height = baseImg.naturalHeight || baseImg.height;
    ctx.drawImage(baseImg, 0, 0);
    Sound.play("blip");
  }

  function renderToolbar() {
    clear(toolsBar);

    const tools: Array<{ id: ToolMode; label: string; iconSvg: SVGSVGElement }> = [
      { id: "pen", label: "Kalem", iconSvg: svg(ICONS.pencil, 12) },
      { id: "arrow", label: "Ok Çiz", iconSvg: svg(ICONS.arrowUpRight, 12) },
      { id: "rect", label: "Kutu Çerçeve", iconSvg: svg(ICONS.rectTool, 12) },
      { id: "highlighter", label: "Vurgulayıcı", iconSvg: svg(ICONS.highlighter, 12) },
      { id: "crop", label: "Görüntüyü Kırp", iconSvg: svg(ICONS.crop, 12) },
    ];

    for (const t of tools) {
      const b = h(
        "button",
        {
          class: `tool-btn${toolMode === t.id ? " active" : ""}`,
          style: "width:22px;height:22px;border-radius:5px;border:none;background:transparent;cursor:pointer;color:var(--dim-2);display:inline-grid;place-items:center;padding:0;transition:all 0.12s ease;",
          title: t.label,
          onclick: () => setTool(t.id),
        },
        t.iconSvg,
      );
      if (toolMode === t.id) {
        b.style.background = "rgba(56,189,248,0.18)";
        b.style.color = "#38bdf8";
      }
      toolsBar.append(b);
    }

    const divider = h("div", { style: "width:1px;height:12px;background:rgba(255,255,255,0.12);margin:0 2px;" });
    toolsBar.append(divider);

    const colors = ["#ef4444", "#f59e0b", "#38bdf8", "#22c55e", "#ffffff"];
    if (!isPaletteExpanded) {
      const colorTrigger = h(
        "div",
        {
          style: "display:inline-flex;align-items:center;gap:3px;padding:2px 4px;border-radius:5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);cursor:pointer;",
          title: "Renkleri göster / gizle",
          onclick: () => {
            isPaletteExpanded = !isPaletteExpanded;
            renderToolbar();
          },
        },
        h("div", {
          style: `width:12px;height:12px;border-radius:50%;background:${currentColor};box-shadow:0 0 4px rgba(0,0,0,0.4);`,
        }),
        h("span", { style: "font-size:7px;opacity:0.6;color:#fff;line-height:1;", text: "▾" }),
      );
      toolsBar.append(colorTrigger);
    } else {
      const paletteBox = h(
        "div",
        {
          style: "display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border-radius:6px;background:rgba(22,25,34,0.95);border:1px solid rgba(255,255,255,0.15);",
        },
      );
      for (const c of colors) {
        const dot = h("div", {
          style: `width:12px;height:12px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${currentColor === c ? "#FFFFFF" : "transparent"};transition:transform 0.12s ease;`,
          title: c,
          onclick: () => {
            setColor(c);
            isPaletteExpanded = false;
            renderToolbar();
          },
        });
        paletteBox.append(dot);
      }
      toolsBar.append(paletteBox);
    }
    const divider2 = h("div", { style: "width:1px;height:12px;background:rgba(255,255,255,0.12);margin:0 2px;" });
    const undoBtn = h(
      "button",
      {
        class: "tool-btn",
        style: "width:22px;height:22px;border-radius:5px;border:none;background:transparent;cursor:pointer;color:var(--dim-2);display:inline-grid;place-items:center;padding:0;transition:all 0.12s ease;",
        title: "Geri Al (Undo)",
        onclick: () => undo(),
      },
      svg(ICONS.undo, 12),
    );
    const clearBtn = h(
      "button",
      {
        class: "tool-btn",
        style: "width:22px;height:22px;border-radius:5px;border:none;background:transparent;cursor:pointer;color:var(--dim-2);display:inline-grid;place-items:center;padding:0;transition:all 0.12s ease;",
        title: "Tüm Çizimleri Sıfırla",
        onclick: () => clearCanvas(),
      },
      svg(ICONS.arrowClockwise, 11, { stroke: 2 }),
    );

    toolsBar.append(divider2, undoBtn, clearBtn);
  }

  function renderActionsBar() {
    clear(actionsBar);

    const btnSnip = h(
      "button",
      {
        class: "snip-action-btn",
        title: "Masaüstünde istediğiniz alanı seçip sadece o bölgenin ekran görüntüsünü alın",
        onclick: () => void triggerSnip("snip"),
      },
      svg(ICONS.crop, 11),
      h("span", { text: "Alan Seç" }),
    );

    const btnFull = h(
      "button",
      {
        class: "snip-action-btn",
        title: "Tüm ekranın görüntüsünü yakalayın",
        onclick: () => void triggerSnip("fullscreen"),
      },
      svg(ICONS.camera, 11),
      h("span", { text: "Tam Ekran" }),
    );

    const copyBtn = h(
      "button",
      {
        class: "snip-action-btn",
        style: "width:22px;height:22px;padding:0;display:inline-grid;place-items:center;",
        title: "Panoya Kopyala",
        onclick: () => void copyImage(),
      },
      svg(ICONS.copy, 11),
    );

    const chatBtn = h(
      "button",
      {
        class: "snip-action-btn",
        title: "Ekran görüntüsünü mevcut açık olan sohbete aktar",
        onclick: () => void exportToChat(),
      },
      svg(ICONS.bubble, 11),
      h("span", { text: "Chat'e Aktar" }),
    );

    actionsBar.append(btnSnip, btnFull, copyBtn, chatBtn);
  }
  container.append(emptyPlaceholder, canvas, loadingNotice);
  const body = h(
    "div",
    {
      class: "snip-body",
      style: "display:flex;flex-direction:column;height:100%;padding:6px 14px 10px 80px;box-sizing:border-box;position:relative;gap:6px;",
    },
    head,
    container,
  );

  const cardEl = h("div", { class: "card wash", style: "height:100%;" }, body);
  cardEl.style.setProperty("--wash", "rgba(56,189,248,0.12)");
  const el = h("div", { class: "view snip-view" }, cardEl);

  renderToolbar();
  renderActionsBar();


  return {
    el,
    sync() {},
  };
}
