# Omi — Guide for AI Coding Agents

Omi is a modern, privacy-first AI desktop companion, coding island, and conversational voice assistant for Windows and Linux. The core desktop app lives in `windows/` (built with Tauri 2, Rust, and TypeScript/Vite).

## Where Things Are
- `windows/` — the Tauri app for Windows and Linux:
  - `windows/src-tauri/` — Rust core backend: window management, WinRT media transport, audio pipeline, Google Antigravity bridge, game mode auto-hide, autonomous computer-use executor.
  - `windows/src/` — TypeScript & Vite frontend: dynamic floating island, modern glassmorphism settings and control hub, multi-session chat views, and slash command dispatcher.
  - `windows/hook/` — lightweight interception hook (`omi-hook`).
  - `windows/tests/` — automated unit and integration test suite (`npm test`).
- `skills/` — universal agent skills and guidelines (Karpathy principles, Metaskill subagent architect, Composio tools).
- `docs/` — documentation, architectural specifications, and project web assets.

## Build & Run
Windows and Linux:
```cmd
cd windows
npm install
npm run tauri dev
```
Production build:
```cmd
cd windows
npm run build
```

## Architectural Guidelines & Principles
- **Performance First:** 0% CPU overhead when the island is hidden or in idle game mode.
- **Privacy & Security:** Secrets reside exclusively in the OS Credential Manager (never plain text or in git). Zero telemetry.
- **Zero Distraction:** Automatic game mode minimizing and process detection (Valorant/Vanguard, CS2, Steam).
- **Responsive Voice Assistant:** Local-first wake word spotting and speech recognition combined with Google Antigravity & Gemini models.
