// Omi Music Detection / Shazam View
// Clean, simple native design that fits the island menu perfectly.
// Does NOT listen automatically: starts only when the user clicks the button.
// Shows "Şarkı tahmin ediliyor..." with three bouncing dots, then reveals the detected track.

import { h, clear, svg } from "./dom";
import { Bridge, type MediaTrackInfo } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";
const artCache = new Map<string, string>();

function isSameTrack(a: MediaTrackInfo | null, b: MediaTrackInfo | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.title === b.title && a.artist === b.artist && a.playing === b.playing;
}

export function buildMusic(actions: ViewActions): ViewHost {
  let activeTrack: MediaTrackInfo | null = null;
  let isListening = false;
  let hasSearched = false;
  let searchStatus = "Şarkı tahmin ediliyor...";
  let lastPollTime = 0;
  // ── Header ──────────────────────────────────────────────────────────────
  const resetBtn = h(
    "button",
    {
      class: "link-btn",
      title: "Sıfırla",
      "aria-label": "Sıfırla",
      style: "display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);color:var(--dim-2);cursor:pointer;padding:0;transition:all 0.15s ease;transform:translateY(2px);",
      onclick: () => {
        activeTrack = null;
        isListening = false;
        hasSearched = false;
        searchStatus = "Şarkı tahmin ediliyor...";
        State.musicPlaying = false;
        State.notify();
        render();
      },
    },
    svg(ICONS.arrowClockwise, 12, { stroke: 2.2 }),
  );
  const head = h(
    "div",
    { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-right:2px;" },
    h("b", { style: "font:600 12.5px var(--font);color:var(--ink);", text: "Müzik Dedektifi" }),
    resetBtn,
  );

  const content = h("div", {
    style: "display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:76px;width:100%;",
  });

  async function manualSearch(term: string) {
    if (!term.trim()) return;
    isListening = true;
    hasSearched = true;
    searchStatus = `"${term}" aranıyor...`;
    render();

    try {
      const resp = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`);
      const data = await resp.json();
      if (data?.results?.[0]) {
        const item = data.results[0];
        activeTrack = {
          title: item.trackName || term,
          artist: item.artistName || "Sanatçı",
          album: item.collectionName || "Single",
          playing: true,
          source: "Arama Sonucu",
        };
        if (item.artworkUrl100) {
          const highRes = item.artworkUrl100.replace("100x100bb", "200x200bb");
          artCache.set(`${activeTrack.artist} ${activeTrack.title}`.trim(), highRes);
        }
        State.musicPlaying = true;
        void Sound.play("finish");
      } else {
        activeTrack = null;
      }
    } catch {
      activeTrack = null;
    }
    isListening = false;
    State.notify();
    render();
  }

  async function startListening() {
    if (isListening) return;
    isListening = true;
    hasSearched = true;
    actions.blip();
    void Sound.play("blip");
    searchStatus = "Sistem ve arka plan dinleniyor...";
    render();

    let foundTrack: MediaTrackInfo | null = null;

    // Immediate check: if music is already active, detect instantly without delay
    try {
      const immediate = await Bridge.detectNowPlaying();
      if (
        immediate &&
        immediate.title &&
        immediate.title !== "Bilinmeyen" &&
        immediate.title !== "null" &&
        immediate.title.toLowerCase() !== "instagram" &&
        immediate.title.toLowerCase() !== "tiktok"
      ) {
        foundTrack = immediate;
        const qTerm = `${immediate.artist || ""} ${immediate.title}`.trim();
        if (immediate.coverUrl) {
          artCache.set(qTerm, immediate.coverUrl);
        }
      }
    } catch {}

    if (!foundTrack) {
      const stages = [
        { delay: 400, text: "Sistem sesleri ve sekmeler dinleniyor..." },
        { delay: 800, text: "YouTube Music ve harici oynatıcılar taranıyor..." },
        { delay: 1000, text: "Yapay Zeka ile derin müzik analizi yapılıyor..." },
      ];

      for (let i = 0; i < stages.length; i++) {
        if (!isListening) break;
        searchStatus = stages[i].text;
        render();

        const { promise, resolve } = Promise.withResolvers<void>();
        window.setTimeout(resolve, stages[i].delay);
        await promise;

        if (!isListening) break;

        try {
          const track = await Bridge.detectNowPlaying();
          if (
            track &&
            track.title &&
            track.title !== "Bilinmeyen" &&
            track.title !== "null" &&
            track.title.toLowerCase() !== "instagram" &&
            track.title.toLowerCase() !== "tiktok"
          ) {
            foundTrack = track;
            const qTerm = `${track.artist || ""} ${track.title}`.trim();
            if (track.coverUrl) {
              artCache.set(qTerm, track.coverUrl);
              const preImg = new Image();
              preImg.src = track.coverUrl;
            } else {
              fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(qTerm)}&entity=song&limit=1`)
                .then((r) => r.json())
                .then((data) => {
                  const highRes = data?.results?.[0]?.artworkUrl100?.replace("100x100bb", "600x600bb");
                  if (highRes) {
                    artCache.set(qTerm, highRes);
                    render();
                  } else {
                    fetch(`https://api.deezer.com/search?q=${encodeURIComponent(qTerm)}&limit=1`)
                      .then((dzRes) => dzRes.json())
                      .then((dz) => {
                        const dzArt = dz?.data?.[0]?.album?.cover_xl || dz?.data?.[0]?.album?.cover_medium;
                        if (dzArt) {
                          artCache.set(qTerm, dzArt);
                          render();
                        }
                      })
                      .catch(() => {});
                  }
                })
                .catch(() => {});
            }
            break;
          }
        } catch {}
      }
    }

    isListening = false;
    activeTrack = foundTrack;
    if (foundTrack && foundTrack.title) {
      State.musicPlaying = foundTrack.playing;
      void Sound.play("finish");
    } else {
      State.musicPlaying = false;
    }
    State.notify();
    render();
  }

  function render() {
    clear(content);

    if (isListening) {
      // ── Listening State: Üstte sadece 3 gri-beyaz nokta, altta "Şarkı tahmin ediliyor..." ────
      const box = h(
        "div",
        {
          style: "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:8px 0;",
        },
        h(
          "div",
          { class: "bouncing-dots", style: "gap:5px;" },
          h("span", { class: "b-dot d1" }),
          h("span", { class: "b-dot d2" }),
          h("span", { class: "b-dot d3" }),
        ),
        h("div", {
          style: "font-size:11px;font-weight:500;color:var(--dim-2);text-align:center;max-width:260px;line-height:1.3;",
          text: searchStatus,
        }),
      );
      content.append(box);
    } else if (activeTrack && activeTrack.title) {
      // ── Song Found State (Sade, temiz ve albüm kapaklı tasarım) ────────
      const isSpotify = activeTrack.source?.toLowerCase().includes("spotify") || activeTrack.album?.toLowerCase().includes("spotify");

      const leftCol = h(
        "div",
        { style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;" },
        h("div", { style: "font-size:10px;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:0.6px;", text: "Şarkı bulundu!" }),
        h("div", {
          class: "track-title",
          style: "font-size:12.5px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.25;",
          text: activeTrack.title,
        }),
        h("div", {
          class: "track-artist",
          style: "font-size:10.5px;color:var(--dim-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;",
          text: activeTrack.artist,
        }),
      );

      const titleText = activeTrack.title;
      const queryTerm = `${activeTrack.artist || ""} ${titleText}`.trim();
      const directArt = activeTrack.coverUrl || artCache.get(queryTerm);

      const coverImg = h("div", {
        style: "width:46px;height:46px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);overflow:hidden;display:grid;place-items:center;flex-shrink:0;user-select:none;pointer-events:none;",
      });

      if (directArt) {
        artCache.set(queryTerm, directArt);
        coverImg.append(h("img", {
          src: directArt,
          alt: titleText,
          style: "width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;",
        }));
      } else {
        coverImg.append(svg(ICONS.musicNote, 16));
        if (titleText) {
          fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(queryTerm)}&entity=song&limit=1`)
            .then((r) => r.json())
            .then((data) => {
              if (data?.results?.[0]?.artworkUrl100) {
                const highRes = data.results[0].artworkUrl100.replace("100x100bb", "200x200bb");
                artCache.set(queryTerm, highRes);
                if (coverImg.isConnected) {
                  clear(coverImg);
                  coverImg.append(h("img", {
                    src: highRes,
                    alt: titleText,
                    style: "width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;",
                  }));
                }
              }
            })
            .catch(() => {});
        }
      }

      const ns = "http://www.w3.org/2000/svg";
      const sIcon = document.createElementNS(ns, "svg");
      sIcon.setAttribute("viewBox", "0 0 24 24");
      sIcon.setAttribute("width", "10");
      sIcon.setAttribute("height", "10");
      sIcon.setAttribute("fill", "#000000");
      const sPath = document.createElementNS(ns, "path");
      sPath.setAttribute("d", "M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z");
      sIcon.append(sPath);

      const spotifyBadge = h("div", {
        style: "position:absolute;right:-3px;bottom:-3px;width:16px;height:16px;border-radius:50%;background:#1DB954;display:grid;place-items:center;box-shadow:0 1px 4px rgba(0,0,0,0.5);border:1.5px solid #0b0c0e;",
      }, sIcon);
      const coverWrapper = h("div", {
        style: "position:relative;width:46px;height:46px;flex-shrink:0;",
      }, coverImg, isSpotify ? spotifyBadge : null);

      const card = h(
        "div",
        {
          style: "width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;",
        },
        leftCol,
        coverWrapper,
      );
      content.append(card);
    } else if (hasSearched) {
      // ── Not Found State ─────────────────────────────────────────────────
      const retryBtn = h(
        "button",
        {
          class: "link-btn",
          style: "font-size:10.5px;color:#38bdf8;padding:2px 10px;border-radius:4px;border:1px solid rgba(56,189,248,0.3);background:rgba(56,189,248,0.05);cursor:pointer;flex-shrink:0;",
          text: "Tekrar Dinle",
          onclick: () => void startListening(),
        },
      );

      const searchInput = h("input", {
        type: "text",
        placeholder: "veya şarkı / söz yazın...",
        style: "width:150px;height:24px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:var(--ink);padding:0 8px;font:500 10.5px var(--font);outline:none;box-sizing:border-box;",
        onkeydown: (e: Event) => {
          const ke = e as KeyboardEvent;
          if (ke.key === "Enter") {
            const val = (searchInput as HTMLInputElement).value.trim();
            if (val) void manualSearch(val);
          }
        },
      });

      const actionRow = h(
        "div",
        { style: "display:flex;align-items:center;gap:6px;margin-top:2px;" },
        retryBtn,
        searchInput,
      );

      const tip = h("div", {
        style: "font-size:9.5px;color:var(--dim-3);text-align:center;max-width:270px;line-height:1.25;margin-top:2px;",
        text: "💡 Instagram'da videoya tıklayıp sesinin açık (unmute) olduğundan emin olun.",
      });

      const box = h(
        "div",
        { style: "display:flex;flex-direction:column;align-items:center;gap:4px;padding:2px 0;" },
        h("div", { style: "font-size:11px;font-weight:500;color:var(--dim-2);", text: "Şarkı bulunamadı veya ses duyulamadı." }),
        actionRow,
        tip,
      );
      content.append(box);
    } else {
      // ── Idle State (Button to start listening, NO auto-start!) ──────────
      const listenBtn = h(
        "button",
        {
          class: "glass-btn",
          style: "display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,0.08);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:#FFFFFF;border:1px solid rgba(255,255,255,0.18);border-radius:20px;padding:6px 16px;font:600 11.5px var(--font);cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.2);transition:all 0.15s ease;",
          onclick: () => void startListening(),
        },
        svg(ICONS.musicNote, 13),
        h("span", { text: "Şarkıyı Dinle" }),
      );

      const hint = h("div", {
        style: "font-size:10px;color:var(--dim-3);margin-top:6px;text-align:center;",
        text: "Arka planda çalan şarkıyı tespit etmek için tıklayın.",
      });

      content.append(listenBtn, hint);
    }
  }

  const body = h(
    "div",
    {
      style: "position:relative;z-index:1;height:100%;display:flex;flex-direction:column;justify-content:center;padding:8px 14px 8px 115px;box-sizing:border-box;overflow:hidden;",
    },
    head,
    content,
  );

  const cardEl = h("div", { class: "card wash", style: "height:100%;" }, body);
  cardEl.style.setProperty("--wash", "rgba(56,189,248,0.15)");
  const el = h("div", { class: "view music-view" }, cardEl);

  render();

  return {
    el,
    sync() {
      // Throttle background sync to at most once every 3.5 seconds
      // Completely prevents re-entrant hover loops and image flickering!
      const nowMs = performance.now();
      if (hasSearched && !isListening && activeTrack && nowMs - lastPollTime > 1500) {
        lastPollTime = nowMs;
        Bridge.detectNowPlaying().then((track) => {
          if (track && !isSameTrack(activeTrack, track)) {
            activeTrack = track;
            State.musicPlaying = track.playing;
            render();
          }
        }).catch(() => {});
      }
    },
  };
}
