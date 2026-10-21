// Omi Calendar & Daily Companion Planner View
// Lets the user organize daily schedule, tasks, reminders and notes right from the island.
// Fully persistent via %APPDATA%\Coucou\calendar.json.

import { h, clear, svg } from "./dom";
import { Bridge, type CalendarItem } from "../core/bridge";
import { Sound } from "../core/sound";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";

const DAYS_TR = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
const MONTHS_TR = [
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"
];

function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatLongDate(dateStr: string): string {
  const d = parseDate(dateStr);
  const dayName = DAYS_TR[d.getDay()];
  const monthName = MONTHS_TR[d.getMonth()];
  return `${d.getDate()} ${monthName}, ${dayName}`;
}

export function buildCalendar(actions: ViewActions): ViewHost {
  let items: CalendarItem[] = [];
  let selectedDate = toDateString(new Date());
  let loaded = false;

  const leftPane = h("div", {
    style: "flex:0 0 170px;display:flex;flex-direction:column;justify-content:flex-start;gap:8px;border-right:1px solid rgba(255,255,255,0.08);padding-right:12px;margin-right:12px;height:100%;box-sizing:border-box;",
  });

  const rightPane = h("div", {
    style: "flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between;height:100%;box-sizing:border-box;",
  });
  const rightDayTitle = h("div", {
    style: "flex:1;text-align:center;font-size:12px;font-weight:700;color:var(--ink);letter-spacing:0.3px;",
    text: "",
  });

  const content = h(
    "div",
    {
      style: "display:flex;width:100%;flex:1;min-height:0;box-sizing:border-box;",
    },
    leftPane,
    rightPane,
  );

  async function loadData() {
    try {
      items = await Bridge.calendarList();
      loaded = true;
      render();
    } catch {}
  }

  function changeDay(deltaDays: number) {
    const cur = parseDate(selectedDate);
    cur.setDate(cur.getDate() + deltaDays);
    selectedDate = toDateString(cur);
    actions.blip();
    void Sound.play("blip");
    render();
  }

  async function handleToggle(id: string) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const willBeDone = !item.done;
    item.done = willBeDone;
    void Sound.play(willBeDone ? "finish" : "blip");
    render();
    try {
      await Bridge.calendarToggle(id);
    } catch {
      item.done = !willBeDone;
      render();
    }
  }

  async function handleDelete(id: string) {
    items = items.filter((i) => i.id !== id);
    void Sound.play("pop");
    render();
    try {
      await Bridge.calendarDelete(id);
    } catch {}
  }

  async function handleAdd(rawText: string) {
    const text = rawText.trim();
    if (!text) return;

    // Check if starts with a time pattern like "14:30 Toplantı" or "09.00 Görüşme"
    let time: string | null = null;
    let title = text;

    const timeMatch = text.match(/^(\d{1,2}[:.]\d{2})\s+(.+)$/);
    if (timeMatch) {
      time = timeMatch[1].replace(".", ":");
      if (time.length === 4) time = "0" + time;
      title = timeMatch[2].trim();
    }

    const newItem: CalendarItem = {
      id: "cal_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      date: selectedDate,
      time,
      title,
      done: false,
      priority: "medium",
      note: null,
      createdAt: Date.now(),
    };

    items.push(newItem);
    void Sound.play("pop");
    render();

    try {
      await Bridge.calendarSave(newItem);
    } catch {}
  }

  function render() {
    clear(leftPane);
    clear(rightPane);
    rightDayTitle.textContent = formatLongDate(selectedDate);

    const todayStr = toDateString(new Date());
    const isToday = selectedDate === todayStr;
    // ── Left Pane: Date Navigation & Day Strip & Status ─────────────────────
    const navRow = h(
      "div",
      { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;" },
      h(
        "button",
        {
          class: "link-btn",
          style: "width:18px;height:18px;display:grid;place-items:center;border-radius:4px;color:var(--dim-2);cursor:pointer;padding:0;",
          onclick: () => changeDay(-1),
        },
        svg(ICONS.chevronLeft, 11),
      ),
      h("div", {
        style: "font-size:11px;font-weight:700;color:var(--ink);text-align:center;",
        text: formatLongDate(selectedDate),
      }),
      h(
        "button",
        {
          class: "link-btn",
          style: "width:18px;height:18px;display:grid;place-items:center;border-radius:4px;color:var(--dim-2);cursor:pointer;padding:0;",
          onclick: () => changeDay(1),
        },
        svg(ICONS.chevronRight, 11),
      ),
    );

    // Mini 5-day strip around selected day
    const weekStrip = h("div", {
      style: "display:flex;justify-content:space-between;gap:3px;margin-bottom:8px;",
    });

    const baseDate = parseDate(selectedDate);
    for (let offset = -2; offset <= 2; offset++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + offset);
      const ds = toDateString(d);
      const isCur = ds === selectedDate;
      const isT = ds === todayStr;
      const hasTasks = items.some((i) => i.date === ds);

      const dayBtn = h(
        "button",
        {
          class: "link-btn",
          style: `flex:1;display:flex;flex-direction:column;align-items:center;padding:3px 0;border-radius:6px;cursor:pointer;border:1px solid ${
            isCur ? "#38bdf8" : isT ? "rgba(255,255,255,0.18)" : "transparent"
          };background:${isCur ? "rgba(56,189,248,0.18)" : "rgba(255,255,255,0.03)"};`,
          onclick: () => {
            selectedDate = ds;
            void Sound.play("blip");
            render();
          },
        },
        h("span", {
          style: `font-size:8.5px;font-weight:600;color:${isCur ? "#38bdf8" : "var(--dim-3)"};`,
          text: DAYS_TR[d.getDay()],
        }),
        h("span", {
          style: `font-size:10.5px;font-weight:700;color:${isCur ? "#FFFFFF" : isT ? "#38bdf8" : "var(--dim-2)"};`,
          text: String(d.getDate()),
        }),
        h("div", {
          style: `width:3px;height:3px;border-radius:50%;margin-top:2px;background:${
            hasTasks ? "#38bdf8" : "transparent"
          };`,
        }),
      );
      weekStrip.append(dayBtn);
    }

    // Daily progress stats
    const dayTasks = items.filter((i) => i.date === selectedDate);
    const completedTasks = dayTasks.filter((i) => i.done).length;
    const totalTasks = dayTasks.length;
    const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const statsBox = h(
      "div",
      {
        style: "display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);",
      },
      h("div", {
        style: "display:flex;justify-content:space-between;font-size:10px;font-weight:600;color:var(--dim-2);",
      },
      h("span", { text: isToday ? "Bugünün İlerlemesi" : "Günün Durumu" }),
      h("span", { text: `${completedTasks}/${totalTasks}` })),
      h(
        "div",
        {
          style: "width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.08);overflow:hidden;",
        },
        h("div", {
          style: `width:${pct}%;height:100%;background:#22c55e;border-radius:2px;transition:width 0.2s ease;`,
        }),
      ),
    );

    const todayQuickBtn = h(
      "button",
      {
        class: "link-btn",
        style: `width:100%;font-size:10px;font-weight:500;color:${isToday ? "var(--dim-4)" : "var(--dim-2)"};padding:4px 0;border-radius:5px;text-align:center;cursor:${
          isToday ? "default" : "pointer"
        };background:${isToday ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)"};border:1px solid rgba(255,255,255,0.07);transition:all 0.15s ease;`,
        text: isToday ? "Bugün" : "Bugüne Dön",
        onclick: () => {
          if (!isToday) {
            selectedDate = todayStr;
            void Sound.play("blip");
            render();
          }
        },
      },
    );

    leftPane.append(navRow, weekStrip, statsBox, todayQuickBtn);

    // ── Right Pane: Task List & Quick Add Input ──────────────────────────────
    const listContainer = h("div", {
      style: "flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:4px;padding-right:2px;",
    });

    if (dayTasks.length === 0) {
      const emptyState = h(
        "div",
        {
          style: "flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:var(--dim-3);font-size:10.5px;",
        },
        h("div", { text: "Bu gün için planlanmış görev yok." }),
        h("div", { style: "font-size:9.5px;color:var(--dim-4);", text: "Aşağıdan hızlıca yeni görev ekleyin." }),
      );
      listContainer.append(emptyState);
    } else {
      // Sort: undone first, then by time
      const sorted = [...dayTasks].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        if (a.time && b.time) return a.time.localeCompare(b.time);
        if (a.time) return -1;
        if (b.time) return 1;
        return a.createdAt - b.createdAt;
      });

      for (const item of sorted) {
        const checkbox = h("button", {
          class: "link-btn",
          style: `width:14px;height:14px;border-radius:4px;border:1.5px solid ${
            item.done ? "#22c55e" : "rgba(255,255,255,0.25)"
          };background:${item.done ? "#22c55e" : "transparent"};display:grid;place-items:center;cursor:pointer;flex-shrink:0;padding:0;transition:all 0.15s ease;`,
          onclick: () => void handleToggle(item.id),
        },
        item.done ? svg(ICONS.check, 8, { stroke: 2.4 }) : null);

        const timeTag = item.time
          ? h("span", {
              style: "font-size:9.5px;font-weight:700;color:#38bdf8;background:rgba(56,189,248,0.12);padding:1px 4px;border-radius:4px;flex-shrink:0;",
              text: item.time,
            })
          : null;

        const titleText = h("span", {
          style: `flex:1;min-width:0;font-size:11.5px;color:${
            item.done ? "var(--dim-3)" : "var(--ink)"
          };text-decoration:${item.done ? "line-through" : "none"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;`,
          text: item.title,
        });

        const delBtn = h(
          "button",
          {
            class: "link-btn",
            style: "width:16px;height:16px;display:grid;place-items:center;color:var(--dim-4);cursor:pointer;padding:0;border:none;background:none;opacity:0.6;",
            title: "Görevi Sil",
            onclick: () => void handleDelete(item.id),
          },
          svg(ICONS.xmark, 8),
        );

        const row = h(
          "div",
          {
            style: "display:flex;align-items:center;gap:7px;padding:3px 6px;border-radius:6px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);transition:all 0.1s ease;",
          },
          checkbox,
          timeTag,
          titleText,
          delBtn,
        );
        listContainer.append(row);
      }
    }

    // Quick add input row
    const addInput = h("input", {
      type: "text",
      placeholder: "+ Görev ekle (örn: 14:00 Toplantı)...",
      style: "width:100%;height:24px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:var(--ink);padding:0 10px;font:500 10.5px var(--font);outline:none;box-sizing:border-box;",
      onkeydown: (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key === "Enter") {
          const val = (addInput as HTMLInputElement).value;
          (addInput as HTMLInputElement).value = "";
          void handleAdd(val);
        }
      },
    }) as HTMLInputElement;

    const inputRow = h(
      "div",
      { style: "margin-top:6px;width:100%;" },
      addInput,
    );

    rightPane.append(listContainer, inputRow);
  }

  const head = h(
    "div",
    { style: "display:flex;align-items:center;margin-bottom:10px;padding-right:2px;" },
    h("b", { style: "flex:0 0 170px;margin-right:12px;font:600 12.5px var(--font);color:var(--ink);white-space:nowrap;", text: "Ajanda & Planlayıcı" }),
    rightDayTitle,
  );

  const body = h(
    "div",
    {
      style: "position:relative;z-index:1;height:100%;display:flex;flex-direction:column;justify-content:flex-start;padding:12px 16px 12px 115px;box-sizing:border-box;overflow:hidden;",
    },
    head,
    content,
  );

  const cardEl = h("div", { class: "card wash", style: "height:100%;" }, body);
  cardEl.style.setProperty("--wash", "rgba(56,189,248,0.12)");
  const el = h("div", { class: "view calendar-view" }, cardEl);

  void loadData();

  return {
    el,
    sync() {
      if (!loaded) void loadData();
    },
  };
}
