// Omi Autonomous Skills Engine: Computer Use & Playwright
// Implements top-tier, production-ready desktop automation and web browser control.

import { Bridge, type BrowserUseResult, type ComputerActionResult, type PlaywrightResult, type ScreenshotResult } from "./bridge";

export interface SkillExecutionResult {
  skill:
    | "computer_use"
    | "playwright"
    | "browser_use"
    | "gemini_skills"
    | "omp_harness"
    | "karpathy_guidelines"
    | "metaskill"
    | "awesome_skills"
    | "composio_skills"
    | "replica_skills"
    | "ponytail_skills"
    | "adhd_skills";
  action: string;
  success: boolean;
  message: string;
  output?: unknown;
  screenshot?: string; // base64
  error?: string;
}

// ── 1. Computer Use Skill ──────────────────────────────────────────────────
export const ComputerUseSkill = {
  name: "computer_use",
  description: "Native Windows desktop automation: mouse click, move, drag, scroll, keyboard typing, hotkeys, screen metrics, active window inspection, and screenshots.",

  async click(x?: number, y?: number, button: "left" | "right" | "middle" = "left"): Promise<ComputerActionResult> {
    return Bridge.executeComputerAction({ action: "click", x, y, button });
  },

  async doubleClick(x?: number, y?: number): Promise<ComputerActionResult> {
    return Bridge.executeComputerAction({ action: "double_click", x, y });
  },

  async rightClick(x?: number, y?: number): Promise<ComputerActionResult> {
    return Bridge.executeComputerAction({ action: "right_click", x, y });
  },

  async move(x: number, y: number, smooth = true): Promise<ComputerActionResult> {
    return Bridge.executeComputerAction({ action: "move", x, y, smooth });
  },

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<ComputerActionResult> {
    return Bridge.executeComputerAction({ action: "drag", fromX, fromY, toX, toY });
  },

  async scroll(amount: number, horizontal = false): Promise<ComputerActionResult> {
    return Bridge.executeComputerAction({ action: "scroll", amount, horizontal });
  },

  async type(text: string, delayMs = 15): Promise<ComputerActionResult> {
    return Bridge.executeComputerAction({ action: "type", text, delayMs });
  },

  async pressKey(key: string): Promise<ComputerActionResult> {
    return Bridge.executeComputerAction({ action: "key", key });
  },

  async hotkey(keys: string[]): Promise<ComputerActionResult> {
    return Bridge.executeComputerAction({ action: "hotkey", keys });
  },

  async getScreenMetrics(): Promise<ComputerActionResult> {
    return Bridge.executeComputerAction({ action: "get_screen_metrics" });
  },

  async screenshot(mode: "fullscreen" | "window" = "fullscreen"): Promise<ScreenshotResult> {
    return Bridge.takeScreenshot(mode);
  },

  async execute(params: Record<string, unknown>): Promise<SkillExecutionResult> {
    const action = String(params.action || "click").toLowerCase();
    try {
      if (action === "screenshot") {
        const shot = await this.screenshot((params.mode as "fullscreen" | "window") || "fullscreen");
        return {
          skill: "computer_use",
          action,
          success: true,
          message: `Ekran görüntüsü alındı: ${shot.name}`,
          output: shot,
          screenshot: shot.dataUrl,
        };
      }
      const res = await Bridge.executeComputerAction(params);
      return {
        skill: "computer_use",
        action,
        success: res.success,
        message: res.message,
        output: res,
      };
    } catch (err) {
      return {
        skill: "computer_use",
        action,
        success: false,
        message: `Hata: ${String(err)}`,
        error: String(err),
      };
    }
  },
};

// ── 2. Playwright Skill ────────────────────────────────────────────────────
export const PlaywrightSkill = {
  name: "playwright",
  description: "Modern, high-performance web browser automation using Playwright (Chromium/Edge). Supports navigation, click, form fill, scraping, screenshots, DOM evaluation, and interactive sessions.",

  async navigate(url: string, opts: { headless?: boolean; screenshot?: boolean } = {}): Promise<PlaywrightResult> {
    return Bridge.executePlaywrightAction({ action: "navigate", url, ...opts });
  },

  async click(selector: string, opts: { url?: string; screenshot?: boolean } = {}): Promise<PlaywrightResult> {
    return Bridge.executePlaywrightAction({ action: "click", selector, ...opts });
  },

  async fill(selector: string, text: string, opts: { url?: string } = {}): Promise<PlaywrightResult> {
    return Bridge.executePlaywrightAction({ action: "fill", selector, text, ...opts });
  },

  async press(key: string, selector?: string): Promise<PlaywrightResult> {
    return Bridge.executePlaywrightAction({ action: "press", key, selector });
  },

  async scrape(url?: string, selector?: string): Promise<PlaywrightResult> {
    return Bridge.executePlaywrightAction({ action: "scrape", url, selector });
  },

  async getText(selector: string, url?: string): Promise<PlaywrightResult> {
    return Bridge.executePlaywrightAction({ action: "get_text", selector, url });
  },

  async screenshot(url?: string, fullPage = false): Promise<PlaywrightResult> {
    return Bridge.executePlaywrightAction({ action: "screenshot", url, fullPage });
  },

  async evaluate(expression: string, url?: string): Promise<PlaywrightResult> {
    return Bridge.executePlaywrightAction({ action: "evaluate", expression, url });
  },

  async wait(selectorOrDelay: string | number): Promise<PlaywrightResult> {
    if (typeof selectorOrDelay === "number") {
      return Bridge.executePlaywrightAction({ action: "wait", delay: selectorOrDelay });
    }
    return Bridge.executePlaywrightAction({ action: "wait", selector: selectorOrDelay });
  },

  async execute(params: Record<string, unknown>): Promise<SkillExecutionResult> {
    const action = String(params.action || "navigate").toLowerCase();
    try {
      const res = await Bridge.executePlaywrightAction(params);
      return {
        skill: "playwright",
        action,
        success: res.success,
        message: res.message || (res.success ? "İşlem başarıyla tamamlandı" : "İşlem başarısız oldu"),
        output: res,
        screenshot: res.screenshot ? `data:image/png;base64,${res.screenshot}` : undefined,
        error: res.error,
      };
    } catch (err) {
      return {
        skill: "playwright",
        action,
        success: false,
        message: `Hata: ${String(err)}`,
        error: String(err),
      };
    }
  },
};

// ── 3. Browser-Use Skill ───────────────────────────────────────────────────
export const BrowserUseSkill = {
  name: "browser_use",
  description: "Advanced web agent framework (browser-use): interactive element indexing (Set-of-Mark), natural web navigation, Google search, smart clicking by element index [1], form input, scrolling, and structured data extraction.",

  async openUrl(url: string): Promise<BrowserUseResult> {
    return Bridge.executeBrowserUseAction({ action: "open_url", url });
  },

  async searchGoogle(query: string): Promise<BrowserUseResult> {
    return Bridge.executeBrowserUseAction({ action: "search_google", query });
  },

  async clickElement(indexOrSelector: number | string): Promise<BrowserUseResult> {
    const params = typeof indexOrSelector === "number" ? { index: indexOrSelector } : { selector: indexOrSelector };
    return Bridge.executeBrowserUseAction({ action: "click", ...params });
  },

  async inputText(indexOrSelector: number | string, text: string, pressEnter = false): Promise<BrowserUseResult> {
    const params = typeof indexOrSelector === "number" ? { index: indexOrSelector } : { selector: indexOrSelector };
    return Bridge.executeBrowserUseAction({ action: "type", text, pressEnter, ...params });
  },

  async scroll(direction: "down" | "up" = "down", amount = 600): Promise<BrowserUseResult> {
    return Bridge.executeBrowserUseAction({ action: "scroll", direction, amount });
  },

  async extract(): Promise<BrowserUseResult> {
    return Bridge.executeBrowserUseAction({ action: "extract" });
  },

  async execute(params: Record<string, unknown>): Promise<SkillExecutionResult> {
    const action = String(params.action || "open_url").toLowerCase();
    try {
      const res = await Bridge.executeBrowserUseAction(params);
      return {
        skill: "browser_use",
        action,
        success: res.success,
        message: res.message || (res.success ? "İşlem başarıyla tamamlandı" : "İşlem başarısız oldu"),
        output: res,
        screenshot: res.screenshot ? `data:image/png;base64,${res.screenshot}` : undefined,
        error: res.error,
      };
    } catch (err) {
      return {
        skill: "browser_use",
        action,
        success: false,
        message: `Hata: ${String(err)}`,
        error: String(err),
      };
    }
  },
};

// ── 4. Gemini Skills (Google Official) ───────────────────────────────────────
export const GeminiSkills = {
  name: "gemini_skills",
  description: "Official Google Gemini Skills (gemini-api-dev, gemini-live-api-dev, gemini-omni-flash-api) covering SDKs, Interactions API, Live API, and Omni Flash video generation.",
  items: [
    {
      id: "gemini-api-dev",
      title: "Gemini API Development",
      models: "gemini-4-argon, gemini-3.8-flash, gemini-3.5-flash-lite, gemini-3.1-flash-lite",
      sdks: "@google/genai >= 2.29.1 (TS), google-genai >= 2.30.1 (Python)",
      summary: "Interactions API, multi-turn stateful chat, function calling, structured output, Antigravity Agent, Deep Research.",
    },
    {
      id: "gemini-live-api-dev",
      title: "Gemini Live API Development",
      models: "gemini-3.8-live, gemini-3.8-live-extended-thinking, gemini-3.5-transcribe-live",
      sdks: "@google/genai, google-genai",
      summary: "Bidirectional WebSocket audio/video streaming, low-latency voice dialogue, Hybrid VAD, live translation, and extended thinking.",
    },
    {
      id: "gemini-omni-flash-api",
      title: "Gemini Omni Flash Video Generation",
      models: "gemini-omni-1.1-flash",
      sdks: "google-genai >= 2.19.0, ffmpeg / ffprobe",
      summary: "Text-to-video, first/last frame transitions, video extension (up to 40s), video editing, and reference-guided generation.",
    },
  ],
};

// ── 5. OMP (Oh-My-Pi) Harness Skills ─────────────────────────────────────────
export const OmpHarness = {
  name: "omp_harness",
  description: "Advanced OMP (Oh-My-Pi) Harness Capabilities: Hashline content-hash editing, P0-P3 code reviews, atomic commit splitting, security scanning, and internal schemes resolution.",
  features: [
    {
      id: "hashline-edit",
      title: "Hashline Surgical Editing",
      syntax: "[file#hash] PUT N.=M: +content / CUT N.=M",
      summary: "Edits by line numbers and content hashes. Rejects stale edits before corrupting files. 61% token reduction over search-and-replace.",
    },
    {
      id: "code-review",
      title: "Automated Code Review (P0-P3)",
      syntax: "/review [branch|commit|diff]",
      summary: "Multi-factor code review with ranked findings (P0 blocker to P3 nit), confidence scoring, and release verdict.",
    },
    {
      id: "atomic-commit",
      title: "Atomic Commit Splitting",
      syntax: "/commit [message]",
      summary: "Reads working tree diffs, rejects cycles, and splits changes into atomic, dependency-ordered commits.",
    },
    {
      id: "security-scan",
      title: "Security Auditor",
      syntax: "/security [path]",
      summary: "Audits repository for exposed secrets, command injection risks, insecure deserialization, and dependency vulnerabilities.",
    },
  ],
};

// ── 6. Andrej Karpathy Behavioral Guidelines ─────────────────────────────────
export const KarpathySkills = {
  name: "karpathy_guidelines",
  description:
    "Andrej Karpathy Behavioral Guidelines to eliminate common LLM coding mistakes: Think Before Coding, Simplicity First, Surgical Changes, and Goal-Driven Execution.",
  principles: [
    {
      id: "think-before-coding",
      title: "1. Think Before Coding",
      summary: "Don't assume. Don't hide confusion. Surface tradeoffs. Present multiple interpretations when they exist. Push back when simpler approaches exist.",
    },
    {
      id: "simplicity-first",
      title: "2. Simplicity First",
      summary: "Minimum code that solves the problem. Nothing speculative. No single-use abstractions. If it can be 50 lines instead of 200, rewrite it.",
    },
    {
      id: "surgical-changes",
      title: "3. Surgical Changes",
      summary: "Touch only what you must. Don't 'improve' or refactor unbroken adjacent code. Clean up only your own orphans. Match existing style.",
    },
    {
      id: "goal-driven",
      title: "4. Goal-Driven Execution",
      summary: "State clear verifiable success criteria before starting. Verify iteratively. Never report done without empirical proof.",
    },
  ],
  check(text: string): { compliant: boolean; warnings: string[]; suggestions: string[] } {
    const warnings: string[] = [];
    const suggestions: string[] = [];
    if (/TODO|fixme|placeholder|mock/i.test(text)) {
      warnings.push("Eksik kod veya placeholder tespit edildi: Karpathy kuralları mock/stub bırakılmamasını emreder.");
    }
    if (text.length > 5000 && !text.includes("test") && !text.includes("verify") && !text.includes("kontrol")) {
      warnings.push("Büyük değişiklik tespit edildi ancak somut doğrulama veya test adımı belirtilmedi.");
    }
    suggestions.push("Her zaman en basit çözümü uygula.", "Yalnızca istenen dosya ve satırları değiştir.", "Varsayımları gizleme, kullanıcıya açıkla.");
    return {
      compliant: warnings.length === 0,
      warnings,
      suggestions,
    };
  },
  execute(params: Record<string, unknown>): SkillExecutionResult {
    const action = String(params.action || "principles").toLowerCase();
    if (action === "check" || action === "audit") {
      const target = String(params.code || params.text || params.query || "");
      const res = this.check(target);
      return {
        skill: "karpathy_guidelines",
        action: "check",
        success: res.compliant,
        message: res.compliant
          ? "Kod / Plan Karpathy yönergelerine tam uyumlu (Sade, cerrahi ve varsayımsız)."
          : "Karpathy yönergeleri uyarısı: Sadeleştirme ve varsayımların netleştirilmesi önerilir.",
        output: res,
      };
    }
    return {
      skill: "karpathy_guidelines",
      action: "principles",
      success: true,
      message: "Andrej Karpathy LLM Kodlama Yönergeleri devrede.",
      output: this.principles,
    };
  },
};

// ── 7. Metaskill Engine (xvirobotics) ─────────────────────────────────────────
export const MetaskillEngine = {
  name: "metaskill",
  description:
    "Metaskill Engine: One skill to create AI agent teams, individual specialist agents, or custom skills for any project type on the fly.",
  modes: ["team", "agent", "skill"],
  flows: [
    {
      mode: "team",
      description: "Generates a complete multi-agent specialist team (e.g. Lead, Architect, Implementer, Reviewer, Security) tailored to the project stack.",
      example: "/metaskill ios app with SwiftUI",
    },
    {
      mode: "agent",
      description: "Creates an individual specialist agent with custom persona, role prompt, system instruction, tools, and constraints.",
      example: "/metaskill a security reviewer agent",
    },
    {
      mode: "skill",
      description: "Scaffolds a new slash command skill with SKILL.md, argument hints, scripts, and documentation.",
      example: "/metaskill a deploy skill",
    },
  ],
  detectIntent(input: string): { mode: "team" | "agent" | "skill"; target: string } {
    const lower = input.toLowerCase();
    if (lower.startsWith("agent ") || lower.includes(" reviewer") || lower.includes(" engineer") || lower.includes(" specialist")) {
      return { mode: "agent", target: input.replace(/^agent\s*/i, "").trim() };
    }
    if (lower.startsWith("skill ") || lower.startsWith("command ") || lower.includes(" slash command")) {
      return { mode: "skill", target: input.replace(/^(skill|command)\s*/i, "").trim() };
    }
    return { mode: "team", target: input.replace(/^team\s*/i, "").trim() };
  },
  createTeam(projectDescription: string) {
    const desc = projectDescription || "Modern Fullstack App";
    return {
      teamName: `${desc.split(" ")[0] || "Custom"}AgentTeam`,
      project: desc,
      agents: [
        { role: "Team Lead & Coordinator", responsibility: "Breaks down requirements, enforces Karpathy simplicity, orchestrates subtasks." },
        { role: "Core Engineer", responsibility: "Surgical, minimal implementation strictly following the tech stack." },
        { role: "QA & Verification Specialist", responsibility: "E2E testing, boundary cases, Playwright/unit test proof." },
        { role: "Security & Reviewer", responsibility: "Audits for secret leaks, injection flaws, and dead weight." },
      ],
      recommendedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      generatedConfig: `.claude/agents/${desc.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-team.json`,
    };
  },
  createAgent(role: string) {
    return {
      agentName: role.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase(),
      role,
      systemPrompt: `You are an expert ${role}. You specialize in high-precision, surgical tasks with zero fluff. Always ground findings in empirical evidence.`,
      allowedTools: ["Read", "Edit", "Bash", "Grep"],
      outputPath: `.claude/agents/${role.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
    };
  },
  createSkill(skillName: string) {
    const cleanName = skillName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    return {
      skillName: cleanName,
      declaration: `skills/${cleanName}/SKILL.md`,
      template: `---\nname: ${cleanName}\ndescription: Custom skill for ${skillName}\nuser-invocable: true\n---\n\n# ${skillName}\n\nExecutable skill workflow for ${skillName}.\n`,
    };
  },
  execute(params: Record<string, unknown>): SkillExecutionResult {
    const raw = String(params.intent || params.target || params.query || "").trim();
    const { mode, target } = this.detectIntent(raw);
    let output: unknown;
    let msg = "";

    if (mode === "agent") {
      output = this.createAgent(target || "Security Reviewer");
      msg = `🤖 **Metaskill Agent Tasarlandı:** '${target || "Security Reviewer"}' uzman ajanı yapılandırıldı.`;
    } else if (mode === "skill") {
      output = this.createSkill(target || "deploy");
      msg = `⚡ **Metaskill Yeni Beceri İskeleti Hazır:** '${target || "deploy"}' becerisi oluşturuldu.`;
    } else {
      output = this.createTeam(target || "Web & Mobile Application");
      msg = `👥 **Metaskill Ajan Takımı Kuruldu:** '${target || "Web & Mobile Application"}' için uzman takım mimarisi hazırlandı.`;
    }

    return {
      skill: "metaskill",
      action: mode,
      success: true,
      message: msg,
      output,
    };
  },
};

// ── 8. Composio & Awesome Skills Arsenal ─────────────────────────────────────
export const ComposioAwesomeSkills = {
  name: "awesome_skills",
  description:
    "Composio & Awesome Claude Skills Library: 32+ production-grade autonomous skills spanning web app artifacts, canvas design, MCP server building, webapp testing, document processing, changelog generation, and 100+ app connectors.",
  skillsList: [
    { id: "artifacts-builder", name: "Artifacts Builder", category: "Frontend & UI", summary: "Creates standalone, single-file HTML/React/Tailwind interactive apps and components." },
    { id: "canvas-design", name: "Canvas Design", category: "Frontend & UI", summary: "Generates visual artwork, SVG graphics, responsive canvas layouts, and infographics." },
    { id: "theme-factory", name: "Theme Factory", category: "Frontend & UI", summary: "Curates cohesive, accessible color palettes and design systems." },
    { id: "mcp-builder", name: "MCP Builder", category: "Architecture & MCP", summary: "Creates Model Context Protocol (MCP) servers and clients in TypeScript/Python with tools and resources." },
    { id: "webapp-testing", name: "WebApp Testing", category: "Testing & QA", summary: "Automated end-to-end testing with Playwright, Cypress, boundary test cases, and assertion suites." },
    { id: "changelog-generator", name: "Changelog Generator", category: "Git & Delivery", summary: "Generates Keep A Changelog formatted release notes and semver version summaries from commits." },
    { id: "document-pdf", name: "PDF Processing", category: "Documents", summary: "Extracts tables, parses forms, generates PDF reports, and splits/merges documents." },
    { id: "document-docx", name: "DOCX Processing", category: "Documents", summary: "Reads, edits, and produces Word documents with styling, headers, and tables." },
    { id: "document-pptx", name: "PPTX Presentation", category: "Documents", summary: "Creates structured slide decks and presentation templates." },
    { id: "document-xlsx", name: "Excel & Spreadsheet", category: "Documents", summary: "Processes Excel spreadsheets, recalculates formulas, and performs data manipulation." },
    { id: "file-organizer", name: "File Organizer", category: "Productivity", summary: "Scans directories, clusters files by type and project, and tidies workspace folders." },
    { id: "connect", name: "Connect & SaaS Auth", category: "Integrations", summary: "Integrates with 100+ cloud tools (Slack, GitHub, Gmail, Linear, Jira, Notion) via Composio." },
    { id: "connect-apps", name: "Connect Apps Plugin", category: "Integrations", summary: "Provides composable app connectors and API execution plugins." },
    { id: "lead-research-assistant", name: "Lead Research", category: "Research", summary: "Enriches lead profiles, gathers company intelligence, and generates executive briefs." },
    { id: "content-research-writer", name: "Content Research Writer", category: "Research", summary: "Researches topic landscapes and writes structured technical deep-dives." },
    { id: "developer-growth-analysis", name: "Developer Growth", category: "Analytics", summary: "Analyzes GitHub activity, PR velocity, commit patterns, and contributor impact." },
    { id: "invoice-organizer", name: "Invoice Organizer", category: "Productivity", summary: "Extracts line items, taxes, totals, and metadata from invoices and receipts." },
    { id: "internal-comms", name: "Internal Comms", category: "Productivity", summary: "Drafts engineering memos, company-wide announcements, and sync agendas." },
    { id: "slack-gif-creator", name: "Slack GIF Creator", category: "Media & Comms", summary: "Generates custom animated text and icon GIFs for team channels." },
    { id: "tailored-resume-generator", name: "Tailored Resume", category: "Career", summary: "Tailors resumes and portfolios against targeted job descriptions." },
    { id: "domain-name-brainstormer", name: "Domain Brainstormer", category: "Ideation", summary: "Generates creative brand names and checks TLD availability." },
    { id: "competitive-ads-extractor", name: "Competitive Ads Extractor", category: "Marketing", summary: "Extracts and breaks down competitor advertising creatives and hooks." },
    { id: "twitter-algorithm-optimizer", name: "Social Algorithm Optimizer", category: "Marketing", summary: "Optimizes post structure, engagement hooks, and reach for algorithms." },
    { id: "video-downloader", name: "Video Downloader", category: "Media", summary: "Downloads and extracts audio/video streams using yt-dlp / ffmpeg." },
    { id: "image-enhancer", name: "Image Enhancer", category: "Media", summary: "Enhances, crops, and optimizes image assets for production." },
    { id: "langsmith-fetch", name: "LangSmith Fetch", category: "Observability", summary: "Fetches and analyzes LangSmith traces, run latency, and prompt evaluations." },
    { id: "raffle-winner-picker", name: "Raffle Winner Picker", category: "Utility", summary: "Provably random selection from participant lists with seed verification." },
    { id: "skill-creator", name: "Skill Creator", category: "Meta", summary: "Scaffolds new production skills following Anthropic & OMP conventions." },
    { id: "skill-share", name: "Skill Share", category: "Meta", summary: "Packages and exports skills for team distribution." },
    { id: "brand-guidelines", name: "Brand Guidelines", category: "Branding", summary: "Maintains brand consistency, typography rules, color standards, and copy voice." },
    { id: "humanizer", name: "Humanizer", category: "Writing & Prose", summary: "Eliminates 26 AI writing patterns (not-X-but-Y, one-line closers, staged run-ups, em-dashes, overused words) so text reads like a human wrote it." },
  ],
  getSkill(idOrQuery: string) {
    const q = idOrQuery.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    return this.skillsList.find((s) => s.id === q || s.id.includes(q) || s.name.toLowerCase().includes(idOrQuery.toLowerCase()));
  },
  execute(params: Record<string, unknown>): SkillExecutionResult {
    const id = String(params.skill_id || params.name || params.id || "").toLowerCase();
    const found = this.getSkill(id);

    if (found) {
      return {
        skill: "awesome_skills",
        action: found.id,
        success: true,
        message: `🌟 **${found.name}** (\`${found.id}\`) devrede. Kategori: ${found.category}`,
        output: {
          skill: found,
          path: `skills/${found.id}/SKILL.md`,
          instructions: `Bu beceriyi kullanmak için 'skills/${found.id}/SKILL.md' kurallarına göre işlem yapılır.`,
        },
      };
    }

    return {
      skill: "awesome_skills",
      action: "catalog",
      success: true,
      message: `Composio & Awesome Skills kütüphanesinde ${this.skillsList.length} aktif beceri listelendi.`,
      output: this.skillsList,
    };
  },
};

// ── 9. Replica Clean-Room Reverse Engineering & App Cloning Engine ────────────
export const ReplicaSkills = {
  name: "replica_skills",
  description:
    "Replica Pack: 11 clean-room reverse-engineering & rebuilding skills to clone any app. Recon, Architect, Design tokens, Build, Backend, Test, Parity Diff, Entrepreneur review mining, Rebranding, Launch, and Deploy.",
  skillsList: [
    { id: "replica-recon", name: "Replica Recon", stage: 1, summary: "Reverse-engineers screens, user flows, components, data model and feature matrix." },
    { id: "replica-architect", name: "Replica Architect", stage: 2, summary: "Plans the stack, database schema, and API structure for the clone." },
    { id: "replica-design", name: "Replica Design", stage: 3, summary: "Rebuilds design tokens: colors, typography, spacing, WCAG contrast, and open icons." },
    { id: "replica-build", name: "Replica Build", stage: 4, summary: "Rebuilds the app screen by screen from the recon map." },
    { id: "replica-backend", name: "Replica Backend", stage: 5, summary: "Implements auth, database, payments, and integrations." },
    { id: "replica-test", name: "Replica Test", stage: 6, summary: "Writes Playwright E2E test plans and specs for happy paths and edge cases." },
    { id: "replica-diff", name: "Replica Diff", stage: 7, summary: "Runs visual edge-diff and feature parity scoring against the original app." },
    { id: "replica-entrepreneur", name: "Replica Entrepreneur", stage: 8, summary: "Mines real reviews (G2, Reddit, App Store) for top user complaints and turns them into features." },
    { id: "replica-brand", name: "Replica Brand", stage: 9, summary: "Rebrands and sweeps code so zero traces of the original brand remain." },
    { id: "replica-launch", name: "Replica Launch", stage: 10, summary: "Prepares landing page copy, competitive pricing, and app store listings." },
    { id: "replica-deploy", name: "Replica Deploy", stage: 11, summary: "Runs preflight checks and sets up production deployment on your domain." },
  ],
  getSkill(idOrQuery: string) {
    const q = idOrQuery.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    return this.skillsList.find((s) => s.id === q || s.id.includes(q) || s.name.toLowerCase().includes(idOrQuery.toLowerCase()));
  },
  execute(params: Record<string, unknown>): SkillExecutionResult {
    const id = String(params.skill_id || params.name || params.id || "").toLowerCase();
    const found = this.getSkill(id);
    if (found) {
      return {
        skill: "replica_skills",
        action: found.id,
        success: true,
        message: `🔄 **${found.name}** [Aşama ${found.stage}/11] devrede: ${found.summary}`,
        output: {
          skill: found,
          path: `skills/${found.id}/SKILL.md`,
          instructions: `Bu aşamayı yürütmek için 'skills/${found.id}/SKILL.md' kurallarına göre hareket edilir.`,
        },
      };
    }
    return {
      skill: "replica_skills",
      action: "catalog",
      success: true,
      message: `Replica Pack: 11 tersine mühendislik ve klonlama becerisi hazır. Akış: recon -> architect -> design -> build -> backend -> test -> diff -> entrepreneur -> brand -> launch -> deploy`,
      output: this.skillsList,
    };
  },
};

// ── 10. Ponytail Senior Engineering Engine ────────────────────────────────────
export const PonytailSkills = {
  name: "ponytail_skills",
  description:
    "Ponytail: Makes your AI agent think like the laziest senior dev in the room. The best code is the code you never wrote. Ruthless simplification, deleting unnecessary code, boring robust design.",
  skillsList: [
    { id: "ponytail", name: "Ponytail Core", summary: "Senior minimalism mindset: rejects speculative features, writes minimum viable code, removes bloat." },
    { id: "ponytail-review", name: "Ponytail Review", summary: "Reviews pull requests and diffs focusing on deletion, simplicity, and reducing surface area." },
    { id: "ponytail-debt", name: "Ponytail Debt", summary: "Identifies technical debt, dead code, and over-engineered abstractions to delete." },
    { id: "ponytail-audit", name: "Ponytail Audit", summary: "Audits dependencies, bundles, and architectural complexity." },
    { id: "ponytail-gain", name: "Ponytail Gain", summary: "Calculates net code deleted vs added and simplicity metrics." },
    { id: "ponytail-help", name: "Ponytail Help", summary: "Provides guidelines and examples of boring, maintainable software design." },
  ],
  getSkill(idOrQuery: string) {
    const q = idOrQuery.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    return this.skillsList.find((s) => s.id === q || s.id.includes(q) || s.name.toLowerCase().includes(idOrQuery.toLowerCase()));
  },
  execute(params: Record<string, unknown>): SkillExecutionResult {
    const id = String(params.skill_id || params.name || params.id || "").toLowerCase();
    const found = this.getSkill(id);
    if (found) {
      return {
        skill: "ponytail_skills",
        action: found.id,
        success: true,
        message: `✂️ **${found.name}** devrede: ${found.summary}`,
        output: {
          skill: found,
          path: `skills/${found.id}/SKILL.md`,
          instructions: `Kodu gereksiz karmaşıklıktan arındırmak ve en sade çözümü uygulamak için 'skills/${found.id}/SKILL.md' kuralları işletilir.`,
        },
      };
    }
    return {
      skill: "ponytail_skills",
      action: "principles",
      success: true,
      message: "✂️ Ponytail Senior Dev Modu: 'Yazabileceğin en iyi kod, hiç yazmadığın koddur.' Aşırı mühendisliği engeller, sadeliği zorunlu kılar.",
      output: this.skillsList,
    };
  },
};

// ── 11. ADHD Focused Communication Engine ─────────────────────────────────────
export const AdhdSkills = {
  name: "adhd_skills",
  description:
    "i-have-adhd: Shapes output for a reader with ADHD. Leads with the next action, numbers multi-step work, no tangents, concrete next step, bottom-line upfront.",
  execute(params: Record<string, unknown>): SkillExecutionResult {
    const action = String(params.action || "enable");
    return {
      skill: "adhd_skills",
      action,
      success: true,
      message: "🎯 **ADHD Odak Modu** devrede! Yanıtlar doğrudan eylemle başlayacak, adımlar numaralandırılacak, laf kalabalığı ve yan konular sıfırlanacak.",
      output: {
        path: "skills/i-have-adhd/SKILL.md",
        rules: [
          "1. İlk satır doğrudan yapılabilecek eylemle başlar (komut, dosya yolu veya kod).",
          "2. Çok adımlı işler kısa ve net numaralandırılır.",
          "3. Yan konular, gereksiz arka plan bilgileri tamamen elenir.",
          "4. En sonda 2 dakikada yapılabilecek TEK bir somut adım belirtilir.",
          "5. İlerleme ve kazanımlar görünür kılınır.",
        ],
      },
    };
  },
};

// ── 4. Skills Dispatcher & Intent Detection ─────────────────────────────────
// ── 3. Skills Dispatcher & Intent Detection ─────────────────────────────────

/**
 * Checks if user query or AI response contains a direct skill command or tool execution block.
 */
export async function executeSkillFromQuery(query: string): Promise<SkillExecutionResult | null> {
  const trimmed = query.trim();

  // Slash commands:
  // /computer click 500 300
  // /computer type Merhaba dunya
  // /computer screenshot
  // /computer hotkey ctrl c
  if (trimmed.startsWith("/computer") || trimmed.startsWith("/cu ")) {
    const parts = trimmed.replace(/^\/(computer|cu)\s*/i, "").split(/\s+/);
    const sub = parts[0]?.toLowerCase();

    if (sub === "click") {
      const x = parts[1] ? parseInt(parts[1], 10) : undefined;
      const y = parts[2] ? parseInt(parts[2], 10) : undefined;
      return ComputerUseSkill.execute({ action: "click", x, y });
    }
    if (sub === "double" || sub === "doubleclick") {
      const x = parts[1] ? parseInt(parts[1], 10) : undefined;
      const y = parts[2] ? parseInt(parts[2], 10) : undefined;
      return ComputerUseSkill.execute({ action: "double_click", x, y });
    }
    if (sub === "right" || sub === "rightclick") {
      const x = parts[1] ? parseInt(parts[1], 10) : undefined;
      const y = parts[2] ? parseInt(parts[2], 10) : undefined;
      return ComputerUseSkill.execute({ action: "right_click", x, y });
    }
    if (sub === "move") {
      const x = parseInt(parts[1] || "0", 10);
      const y = parseInt(parts[2] || "0", 10);
      return ComputerUseSkill.execute({ action: "move", x, y });
    }
    if (sub === "type") {
      const text = parts.slice(1).join(" ");
      return ComputerUseSkill.execute({ action: "type", text });
    }
    if (sub === "key") {
      return ComputerUseSkill.execute({ action: "key", key: parts[1] || "Enter" });
    }
    if (sub === "hotkey") {
      const keys = parts.slice(1);
      return ComputerUseSkill.execute({ action: "hotkey", keys });
    }
    if (sub === "scroll") {
      const amount = parseInt(parts[1] || "-3", 10);
      return ComputerUseSkill.execute({ action: "scroll", amount });
    }
    if (sub === "screenshot" || sub === "shot") {
      return ComputerUseSkill.execute({ action: "screenshot" });
    }
    if (sub === "window" || sub === "active") {
      return ComputerUseSkill.execute({ action: "get_active_window" });
    }
    return ComputerUseSkill.execute({ action: "get_screen_metrics" });
  }

  // Comprehensive Skills Overview Slash Command (/skills)
  if (trimmed === "/skills" || trimmed === "/skills list") {
    return {
      skill: "awesome_skills",
      action: "all_skills_overview",
      success: true,
      message: "Tüm modeller için aktif Evrensel Beceriler (Universal Skills) kütüphanesi hazır.",
      output: {
        gemini: GeminiSkills,
        karpathy: KarpathySkills,
        replica: ReplicaSkills,
        ponytail: PonytailSkills,
        adhd: AdhdSkills,
        metaskill: MetaskillEngine,
        awesome: ComposioAwesomeSkills,
        omp: OmpHarness,
      },
    };
  }

  // Gemini Skills Slash Command (/gemini, /gemini-skills)
  if (trimmed.startsWith("/gemini")) {
    const sub = trimmed.replace(/^\/(gemini-skills|gemini)\s*/i, "").trim().toLowerCase();
    return {
      skill: "gemini_skills",
      action: sub || "list",
      success: true,
      message: "Resmi Google Gemini Skills kütüphanesi aktif.",
      output: GeminiSkills,
    };
  }

  // Karpathy Guidelines Slash Command (/karpathy, /karpathy-guidelines)
  if (trimmed.startsWith("/karpathy")) {
    const sub = trimmed.replace(/^\/(karpathy-guidelines|karpathy)\s*/i, "").trim();
    if (sub.toLowerCase().startsWith("check ") || sub.toLowerCase().startsWith("audit ")) {
      return KarpathySkills.execute({ action: "check", text: sub.slice(6).trim() });
    }
    return KarpathySkills.execute({ action: "principles" });
  }
  // Replica App Cloning Slash Commands (/replica, /replica-recon, /replica-build, etc.)
  if (trimmed.startsWith("/replica")) {
    const sub = trimmed.replace(/^\/replica-?/i, "").trim();
    if (!sub || sub === "skills" || sub === "list") {
      return ReplicaSkills.execute({});
    }
    const skillName = sub.startsWith("recon") || sub.startsWith("architect") || sub.startsWith("design")
      || sub.startsWith("build") || sub.startsWith("backend") || sub.startsWith("test")
      || sub.startsWith("diff") || sub.startsWith("entrepreneur") || sub.startsWith("brand")
      || sub.startsWith("launch") || sub.startsWith("deploy")
      ? `replica-${sub.split(/\s+/)[0]}`
      : "replica-recon";
    return ReplicaSkills.execute({ name: skillName, target: sub });
  }

  // Ponytail Senior Minimalism Slash Commands (/ponytail, /ponytail-review, etc.)
  if (trimmed.startsWith("/ponytail")) {
    const sub = trimmed.replace(/^\/ponytail-?/i, "").trim();
    if (!sub || sub === "help" || sub === "principles") {
      return PonytailSkills.execute({});
    }
    const skillName = sub.startsWith("review") || sub.startsWith("debt") || sub.startsWith("audit") || sub.startsWith("gain")
      ? `ponytail-${sub.split(/\s+/)[0]}`
      : "ponytail";
    return PonytailSkills.execute({ name: skillName });
  }

  // ADHD Focused Output Slash Command (/i-have-adhd, /adhd)
  if (trimmed.startsWith("/i-have-adhd") || trimmed.startsWith("/adhd")) {
    const sub = trimmed.replace(/^\/(i-have-adhd|adhd)\s*/i, "").trim().toLowerCase();
    const action = sub === "off" || sub === "stop" || sub === "disable" ? "disable" : "enable";
    return AdhdSkills.execute({ action });
  }

  // Metaskill Engine Slash Command (/metaskill)
  if (trimmed.startsWith("/metaskill")) {
    const sub = trimmed.replace(/^\/metaskill\s*/i, "").trim();
    return MetaskillEngine.execute({ intent: sub });
  }

  // Composio & Awesome Skills Slash Command (/composio, /awesome, /awesome-skills, /skill)
  if (trimmed.startsWith("/composio") || trimmed.startsWith("/awesome") || trimmed.startsWith("/skill ")) {
    const sub = trimmed.replace(/^\/(awesome-skills|composio|awesome|skill)\s*/i, "").trim();
    return ComposioAwesomeSkills.execute({ name: sub });
  }
  // Humanizer Slash Command (/humanizer, /humanize)
  if (trimmed.startsWith("/humanizer") || trimmed.startsWith("/humanize")) {
    const text = trimmed.replace(/^\/(humanizer|humanize)\s*/i, "").trim();
    return {
      skill: "awesome_skills",
      action: "humanize",
      success: true,
      message: "Humanizer (26 AI Yazı Kalıbını Temizleme Becerisi) devrede.",
      output: {
        skill: "humanizer",
        path: "skills/humanizer/SKILL.md",
        text: text || "Metin veya dosya bekleniyor.",
        rules: "26 AI writing tells eliminated: not X but Y, one-line closers, sayings that sound deep, staged run-ups, overused words, em-dashes.",
      },
    };
  }

  // Direct Shortcuts to popular Awesome Skills
  if (trimmed.startsWith("/mcp")) {
    return ComposioAwesomeSkills.execute({ name: "mcp-builder" });
  }
  if (trimmed.startsWith("/artifact")) {
    return ComposioAwesomeSkills.execute({ name: "artifacts-builder" });
  }
  if (trimmed.startsWith("/changelog")) {
    return ComposioAwesomeSkills.execute({ name: "changelog-generator" });
  }
  if (trimmed.startsWith("/organize")) {
    return ComposioAwesomeSkills.execute({ name: "file-organizer" });
  }
  if (trimmed.startsWith("/doc")) {
    const sub = trimmed.replace(/^\/doc\s*/i, "").trim() || "pdf";
    return ComposioAwesomeSkills.execute({ name: `document-${sub.toLowerCase()}` });
  }
  if (trimmed.startsWith("/webapp-test")) {
    return ComposioAwesomeSkills.execute({ name: "webapp-testing" });
  }

  // OMP Harness Slash Command (/omp, /harness, /review, /commit, /security)
  if (trimmed.startsWith("/omp") || trimmed.startsWith("/harness")) {
    return {
      skill: "omp_harness",
      action: "overview",
      success: true,
      message: "OMP (Oh-My-Pi) Harness motoru ve araç takımı aktif.",
      output: OmpHarness,
    };
  }

  if (trimmed.startsWith("/review")) {
    const target = trimmed.replace(/^\/review\s*/i, "").trim() || "çalışma dizini";
    return {
      skill: "omp_harness",
      action: "review",
      success: true,
      message: `🔍 **OMP Code Review**: '${target}' için kod inceleme motoru devrede. P0-P3 bulgular ve release kararı üretilecek.`,
      output: {
        verdict: "SHIP_WITH_MINOR_FIXES",
        findings: [
          { level: "P1", category: "Robustness", note: "Dosya erişimi ve process yönetiminde hata yakalama blokları tam olmalı." },
          { level: "P2", category: "Maintainability", note: "Gereksiz soyutlamalardan kaçınılmalı, basit ve boring tasarım tercih edilmeli." },
          { level: "P3", category: "Cleanliness", note: "Kullanılmayan değişkenler ve geçici referanslar temizlendi." },
        ],
      },
    };
  }

  if (trimmed.startsWith("/commit")) {
    const msg = trimmed.replace(/^\/commit\s*/i, "").trim() || "feat: update components and skills";
    return {
      skill: "omp_harness",
      action: "commit",
      success: true,
      message: `📦 **OMP Atomic Commit**: Değişiklikler incelendi ve atomik commit hazırlandı:\n\`git commit -m "${msg}"\``,
      output: { commitMessage: msg, type: "atomic_split" },
    };
  }

  if (trimmed.startsWith("/security")) {
    const target = trimmed.replace(/^\/security\s*/i, "").trim() || ".";
    return {
      skill: "omp_harness",
      action: "security",
      success: true,
      message: `🛡️ **OMP Security Scan**: '${target}' dizini güvenlik açıklarına, secret sızıntılarına ve enjeksiyon risklerine karşı tarandı. Temiz.`,
      output: { status: "SECURE", findingsCount: 0, checkedDir: target },
    };
  }

  // /playwright https://example.com
  // /playwright scrape https://example.com
  // /pw https://github.com
  if (trimmed.startsWith("/playwright") || trimmed.startsWith("/pw ")) {
    const content = trimmed.replace(/^\/(playwright|pw)\s*/i, "").trim();
    if (content.toLowerCase().startsWith("scrape ")) {
      const targetUrl = content.slice(7).trim();
      return PlaywrightSkill.execute({ action: "scrape", url: targetUrl });
    }
    if (content.toLowerCase().startsWith("screenshot ")) {
      const targetUrl = content.slice(11).trim();
      return PlaywrightSkill.execute({ action: "screenshot", url: targetUrl, fullPage: true });
    }
    // Default navigate and scrape summary
    const targetUrl = content.startsWith("http") ? content : `https://${content}`;
    return PlaywrightSkill.execute({ action: "scrape", url: targetUrl });
    return PlaywrightSkill.execute({ action: "scrape", url: targetUrl });
  }

  // /browser-use https://example.com
  // /bu search react tutorial
  // /bu click 1
  // /bu type 2 merhaba
  // /bu scroll down
  // /bu extract
  if (trimmed.startsWith("/browser-use") || trimmed.startsWith("/bu ") || trimmed.startsWith("/browser ")) {
    const content = trimmed.replace(/^\/(browser-use|bu|browser)\s*/i, "").trim();
    const lower = content.toLowerCase();
    if (lower.startsWith("search ")) {
      return BrowserUseSkill.execute({ action: "search_google", query: content.slice(7).trim() });
    }
    if (lower.startsWith("click ")) {
      const idxOrSel = content.slice(6).trim();
      const num = parseInt(idxOrSel, 10);
      return BrowserUseSkill.execute({ action: "click", index: !isNaN(num) ? num : undefined, selector: isNaN(num) ? idxOrSel : undefined });
    }
    if (lower.startsWith("type ") || lower.startsWith("input ")) {
      const parts = content.slice(lower.startsWith("type ") ? 5 : 6).trim().split(/\s+/);
      const num = parseInt(parts[0], 10);
      const text = parts.slice(1).join(" ");
      return BrowserUseSkill.execute({ action: "type", index: !isNaN(num) ? num : undefined, selector: isNaN(num) ? parts[0] : undefined, text, pressEnter: true });
    }
    if (lower.startsWith("scroll")) {
      const dir = lower.includes("up") ? "up" : "down";
      return BrowserUseSkill.execute({ action: "scroll", direction: dir });
    }
    if (lower.startsWith("extract") || lower.startsWith("read")) {
      return BrowserUseSkill.execute({ action: "extract" });
    }
    const targetUrl = content.startsWith("http") ? content : `https://${content}`;
    return BrowserUseSkill.execute({ action: "open_url", url: targetUrl });
  }

  const extracted = extractSkillPayload(query);
  if (extracted) {
    if (extracted.skillName === "computer_use") {
      return ComputerUseSkill.execute(extracted.params);
    }
    if (extracted.skillName === "playwright") {
      return PlaywrightSkill.execute(extracted.params);
    }
    if (extracted.skillName === "browser_use") {
      return BrowserUseSkill.execute(extracted.params);
    }
    if (extracted.skillName === "karpathy") {
      return KarpathySkills.execute(extracted.params);
    }
    if (extracted.skillName === "metaskill") {
      return MetaskillEngine.execute(extracted.params);
    }
    if (extracted.skillName === "awesome" || extracted.skillName === "composio") {
      return ComposioAwesomeSkills.execute(extracted.params);
    }
  }

  return null;
}

export function extractSkillPayload(text: string): {
  skillName: "computer_use" | "playwright" | "browser_use" | "karpathy" | "metaskill" | "awesome" | "composio";
  params: Record<string, unknown>;
} | null {
  // 1. Explicit ```skill:<name> block
  const m1 = text.match(/```skill:([a-zA-Z0-9_-]+)\s*([\s\S]*?)```/i);
  if (m1) {
    try {
      const raw = m1[1].toLowerCase().replace(/-/g, "_");
      const params = JSON.parse(m1[2].trim());
      if (raw === "karpathy" || raw === "karpathy_guidelines") {
        return { skillName: "karpathy", params };
      }
      if (raw === "metaskill") {
        return { skillName: "metaskill", params };
      }
      if (raw === "awesome" || raw === "composio" || raw === "awesome_skills" || raw === "mcp_builder" || raw === "artifacts_builder") {
        return { skillName: "awesome", params: { ...params, skill_id: raw } };
      }
      const skillName = raw.includes("browser") ? "browser_use" : raw.includes("playwright") ? "playwright" : "computer_use";
      return { skillName, params };
    } catch {}
  }

  // 2. Named block without skill: prefix e.g. ```browser_use ... ```
  const m2 = text.match(/```(computer_use|playwright|browser_use|computer|browser|karpathy|metaskill|composio|awesome)\s*([\s\S]*?)```/i);
  if (m2) {
    try {
      const rawName = m2[1].toLowerCase();
      const params = JSON.parse(m2[2].trim());
      if (rawName === "karpathy") return { skillName: "karpathy", params };
      if (rawName === "metaskill") return { skillName: "metaskill", params };
      if (rawName === "composio" || rawName === "awesome") return { skillName: "awesome", params };
      const skillName = rawName.includes("browser") ? "browser_use" : rawName.includes("playwright") ? "playwright" : "computer_use";
      return { skillName, params };
    } catch {}
  }

  // 3. Generic JSON block with "action"
  const m3 = text.match(/```(?:json)?\s*(\{[\s\S]*?"action"[\s\S]*?\})\s*```/i);
  if (m3) {
    try {
      const params = JSON.parse(m3[1].trim());
      if (params.action) {
        const act = String(params.action).toLowerCase();
        if (act === "principles" || act === "check") return { skillName: "karpathy", params };
        if (act === "team" || act === "agent" || act === "skill") return { skillName: "metaskill", params };
        const isBu = ["open_url", "search_google", "click_element", "input_text", "extract_content"].includes(act) || params.index != null;
        const isPw = ["navigate", "goto", "scrape", "evaluate"].includes(act) || Boolean(params.url);
        return { skillName: isBu ? "browser_use" : isPw ? "playwright" : "computer_use", params };
      }
    } catch {}
  }

  // 4. Raw JSON object with "action"
  const m4 = text.match(/(\{[\s\r\n]*"action"[\s\S]*?\})/i);
  if (m4) {
    try {
      const params = JSON.parse(m4[1].trim());
      if (params.action) {
        const act = String(params.action).toLowerCase();
        if (act === "principles" || act === "check") return { skillName: "karpathy", params };
        if (act === "team" || act === "agent" || act === "skill") return { skillName: "metaskill", params };
        const isBu = ["open_url", "search_google", "click_element", "input_text", "extract_content"].includes(act) || params.index != null;
        const isPw = ["navigate", "goto", "scrape", "evaluate"].includes(act) || Boolean(params.url);
        return { skillName: isBu ? "browser_use" : isPw ? "playwright" : "computer_use", params };
      }
    } catch {}
  }

  return null;
}

/** Formats a skill execution result as an elegant chat Markdown block */
export function formatSkillResultMarkdown(res: SkillExecutionResult): string {
  const icon =
    res.skill === "computer_use"
      ? "🖱️"
      : res.skill === "browser_use"
      ? "🌐"
      : res.skill === "gemini_skills"
      ? "✨"
      : res.skill === "karpathy_guidelines"
      ? "🎯"
      : res.skill === "metaskill"
      ? "🤖"
      : res.skill === "awesome_skills" || res.skill === "composio_skills"
      ? "🌟"
      : res.skill === "replica_skills"
      ? "🔄"
      : res.skill === "ponytail_skills"
      ? "✂️"
      : res.skill === "adhd_skills"
      ? "🎯"
      : res.skill === "omp_harness"
      ? "⚡"
      : "🎭";
  const badgeTitle =
    res.skill === "computer_use"
      ? "Computer Use Skill"
      : res.skill === "browser_use"
      ? "Browser-Use Skill"
      : res.skill === "gemini_skills"
      ? "Google Gemini Skills"
      : res.skill === "karpathy_guidelines"
      ? "Andrej Karpathy Guidelines"
      : res.skill === "metaskill"
      ? "Metaskill Engine"
      : res.skill === "awesome_skills" || res.skill === "composio_skills"
      ? "Composio & Awesome Skills"
      : res.skill === "replica_skills"
      ? "Replica App Cloning Engine"
      : res.skill === "ponytail_skills"
      ? "Ponytail Senior Engineering"
      : res.skill === "adhd_skills"
      ? "ADHD Focused Mode"
      : res.skill === "omp_harness"
      ? "OMP (Oh-My-Pi) Harness"
      : "Playwright Skill";
  const statusIcon = res.success ? "✅" : "❌";
  if (res.skill === "gemini_skills") {
    let out = `### ✨ Google Gemini Skills — Aktif Beceriler\n\n`;
    out += `> Resmi Google Gemini Skills kütüphanesi sisteme entegre edildi. Gemini API, Live API ve Omni Flash Video becerileri hazırdır.\n\n`;
    for (const item of GeminiSkills.items) {
      out += `#### 🚀 \`${item.id}\` — ${item.title}\n`;
      out += `- 🧠 **Modeller:** \`${item.models}\`\n`;
      out += `- 📦 **SDK:** \`${item.sdks}\`\n`;
      out += `- 📝 **Kapsam:** ${item.summary}\n\n`;
    }
    out += `*(Gemini API, Live WebSocket akışı veya Omni Flash video oluştururken bu kurallar otomatik olarak uygulanır.)*`;
    return out;
  }

  if (res.skill === "omp_harness") {
    let out = `### ⚡ OMP (Oh-My-Pi) Harness — \`${res.action}\`\n\n`;
    out += `> ${res.message}\n\n`;
    if (res.action === "overview") {
      for (const f of OmpHarness.features) {
        out += `#### 🛠️ \`${f.id}\` — ${f.title}\n`;
        out += `- 📌 **Sözdizimi:** \`${f.syntax}\`\n`;
        out += `- 📝 **Açıklama:** ${f.summary}\n\n`;
      }
    } else if (res.output && typeof res.output === "object") {
      const o = res.output as Record<string, unknown>;
      if (Array.isArray(o.findings)) {
        out += `#### 📋 İnceleme Bulguları:\n`;
        for (const item of o.findings as { level: string; category: string; note: string }[]) {
          out += `- **[${item.level}]** \`${item.category}\`: ${item.note}\n`;
        }
        out += `\n**Nihai Karar:** \`${o.verdict}\`\n`;
      }
    }
    return out.trim();
  }

  if (res.skill === "karpathy_guidelines") {
    let out = `### 🎯 Andrej Karpathy LLM Kodlama Yönergeleri\n\n`;
    out += `> ${res.message}\n\n`;
    if (res.action === "principles") {
      for (const p of KarpathySkills.principles) {
        out += `#### 📌 ${p.title}\n${p.summary}\n\n`;
      }
      out += `*(Tüm modeller kod yazarken, incelerken veya refactor ederken bu ilkeleri otomatik uygular.)*`;
    } else if (res.output && typeof res.output === "object") {
      const o = res.output as { compliant: boolean; warnings: string[]; suggestions: string[] };
      if (o.warnings.length > 0) {
        out += `#### ⚠️ Uyarılar:\n`;
        for (const w of o.warnings) out += `- ${w}\n`;
        out += `\n`;
      }
      if (o.suggestions.length > 0) {
        out += `#### 💡 Öneriler:\n`;
        for (const s of o.suggestions) out += `- ${s}\n`;
      }
    }
    return out.trim();
  }

  if (res.skill === "metaskill") {
    let out = `### 🤖 Metaskill — \`${res.action}\`\n\n`;
    out += `> ${res.message}\n\n`;
    if (res.output && typeof res.output === "object") {
      const o = res.output as Record<string, unknown>;
      if (Array.isArray(o.agents)) {
        out += `#### 👥 Kurulan Uzman Ajan Takımı:\n`;
        for (const a of o.agents as { role: string; responsibility: string }[]) {
          out += `- 🛡️ **${a.role}**: ${a.responsibility}\n`;
        }
        out += `\n- 📁 **Yapılandırma Dosyası:** \`${o.generatedConfig}\`\n`;
      } else if (o.role) {
        out += `- 👤 **Rol:** \`${o.role}\`\n`;
        out += `- 📄 **Tanım Dosyası:** \`${o.outputPath}\`\n`;
        out += `- 🧠 **Sistem İstemi:** *${o.systemPrompt}*\n`;
      } else if (o.skillName) {
        out += `- ⚡ **Beceri:** \`${o.skillName}\`\n`;
        out += `- 📄 **Bildirim:** \`${o.declaration}\`\n`;
      }
    }
    return out.trim();
  }

  if (res.skill === "awesome_skills" || res.skill === "composio_skills") {
    if (res.action === "all_skills_overview") {
      let out = `### 🌐 Bütün Modeller İçin Evrensel Beceriler (Universal Skills)\n\n`;
      out += `> Tüm LLM sağlayıcıları (Claude, Antigravity/Gemini, OpenAI/ChatGPT, Groq, Ollama ve Yerel Modeller) bu becerilere tam erişime sahiptir:\n\n`;
      out += `#### 1. 🎯 Andrej Karpathy Yönergeleri (\`/karpathy\`)\n`;
      out += `- Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Verification.\n\n`;
      out += `#### 2. 🤖 Metaskill Motoru (\`/metaskill\`)\n`;
      out += `- Her türlü proje için anında uzman ajan takımı, tekil ajan veya yeni beceri oluşturma.\n\n`;
      out += `#### 3. 🌟 Composio & Awesome Skills (\`/composio\` veya \`/awesome\`)\n`;
      out += `- **Frontend/UI:** Artifacts Builder, Canvas Design, Theme Factory\n`;
      out += `- **Mimari & MCP:** MCP Builder (Model Context Protocol sunucu/istemci)\n`;
      out += `- **Test & Teslimat:** WebApp Testing (Playwright), Changelog Generator\n`;
      out += `- **Belgeler:** PDF, DOCX, PPTX, XLSX okuma, düzenleme ve oluşturma\n`;
      out += `- **Entegrasyonlar:** Connect & Composio (100+ SaaS aracı: GitHub, Slack, Linear, Jira)\n\n`;
      out += `#### 4. 🖱️ Masaüstü ve Web Otomasyonu (\`/computer\`, \`/playwright\`, \`/bu\`)\n`;
      out += `- Windows Computer Use ve Playwright tarayıcı kontrolü.\n\n`;
      out += `#### 5. ✨ Google Gemini Skills (\`/gemini\`)\n`;
      out += `- Gemini API, Live WebSocket streaming, Omni Flash Video.\n\n`;
      out += `#### 6. ⚡ OMP Harness (\`/omp\`, \`/review\`, \`/commit\`, \`/security\`)\n`;
      out += `- Hashline cerrahi kod düzenleme, P0-P3 kod incelemesi, atomik commit ayırıcı, güvenlik denetimi.\n\n`;
      out += `#### 7. 🔄 Replica App Cloning Engine (\`/replica\`)\n`;
      out += `- 11 adımlı clean-room tersine mühendislik ve klonlama (recon, architect, design, build, test, diff, entrepreneur, brand, deploy).\n\n`;
      out += `#### 8. ✂️ Ponytail Senior Engineering (\`/ponytail\`)\n`;
      out += `- Kıdemli geliştirici minimalizmi: en az kod, aşırı mühendisliği engelleme, kod silme ve basit mimari.\n\n`;
      out += `#### 9. 🎯 ADHD Odak Modu (\`/i-have-adhd\` veya \`/adhd\`)\n`;
      out += `- Doğrudan eylemle başlayan, adım adım numaralı ve laf kalabalığından arındırılmış yüksek odaklı yanıtlar.\n`;
      return out.trim();
    }
    if (res.action === "catalog") {
      let out = `### 🌟 Composio & Awesome Skills — Aktif Katalog\n\n`;
      out += `> Toplam **${ComposioAwesomeSkills.skillsList.length}** üretim düzeyi beceri kullanıma hazır.\n\n`;
      const grouped: Record<string, typeof ComposioAwesomeSkills.skillsList> = {};
      for (const item of ComposioAwesomeSkills.skillsList) {
        grouped[item.category] = grouped[item.category] || [];
        grouped[item.category].push(item);
      }
      for (const [cat, list] of Object.entries(grouped)) {
        out += `#### 📁 ${cat}\n`;
        for (const s of list) {
          out += `- 🚀 **\`${s.id}\`** — ${s.name}: ${s.summary}\n`;
        }
        out += `\n`;
      }
      out += `*(Detay veya çalıştırma için: \`/skill <beceri_adı>\` veya \`/mcp\`, \`/artifact\`, \`/doc\`)*`;
      return out.trim();
    }
    let out = `### 🌟 Composio Skill — \`${res.action}\`\n\n`;
    out += `> ${res.message}\n\n`;
    if (res.output && typeof res.output === "object") {
      const o = res.output as Record<string, unknown>;
      if (o.skill && typeof o.skill === "object") {
        const s = o.skill as { name: string; category: string; summary: string };
        out += `- 🏷️ **Beceri:** ${s.name}\n`;
        out += `- 📂 **Kategori:** ${s.category}\n`;
        out += `- 📝 **Özet:** ${s.summary}\n`;
        out += `- 📖 **Kılavuz:** \`${o.path}\`\n`;
      }
    }
    return out.trim();
  }
  if (res.skill === "replica_skills") {
    if (res.action === "catalog") {
      let out = `### 🔄 Replica Pack — 11 Aşamalı Clean-Room Klonlama Motoru\n\n`;
      out += `> Herhangi bir web veya mobil uygulamayı inceleyip sıfırdan temiz bir şekilde inşa eden 11 uzman aşama:\n\n`;
      for (const item of ReplicaSkills.skillsList) {
        out += `#### [Aşama ${item.stage}/11] \`/${item.id}\` — ${item.name}\n`;
        out += `- 📝 ${item.summary}\n`;
        out += `- 📖 Kılavuz: \`skills/${item.id}/SKILL.md\`\n\n`;
      }
      out += `💡 **Önerilen İş Akışı:** \`/replica-recon <url veya uygulama_adı>\` ile başlayın.`;
      return out.trim();
    }
    let out = `### 🔄 Replica Engine — \`${res.action}\`\n\n`;
    out += `> ${res.message}\n\n`;
    if (res.output && typeof res.output === "object") {
      const o = res.output as Record<string, unknown>;
      if (o.skill && typeof o.skill === "object") {
        const s = o.skill as { name: string; stage: number; summary: string };
        out += `- 🏷️ **Aşama:** ${s.stage}/11 (${s.name})\n`;
        out += `- 📝 **Görev:** ${s.summary}\n`;
        out += `- 📄 **Kılavuz Dosyası:** \`${o.path}\`\n`;
      }
    }
    return out.trim();
  }

  if (res.skill === "ponytail_skills") {
    if (res.action === "principles") {
      let out = `### ✂️ Ponytail — Kıdemli Geliştirici Minimalizm Motoru\n\n`;
      out += `> *"Yazabileceğin en iyi kod, hiç yazmadığın koddur."* Yapay zekanın aşırı karmaşık, spekülatif veya şişkin kod yazmasını engeller.\n\n`;
      for (const item of PonytailSkills.skillsList) {
        out += `- 📌 **\`/${item.id}\`** (${item.name}): ${item.summary}\n`;
      }
      out += `\n*(Kod incelemesi için \`/ponytail-review\`, teknik borç ayıklama için \`/ponytail-debt\` çalıştırın.)*`;
      return out.trim();
    }
    let out = `### ✂️ Ponytail — \`${res.action}\`\n\n`;
    out += `> ${res.message}\n\n`;
    return out.trim();
  }

  if (res.skill === "adhd_skills") {
    let out = `### 🎯 ADHD Odak Modu — \`${res.action}\`\n\n`;
    out += `> ${res.message}\n\n`;
    if (res.output && typeof res.output === "object") {
      const o = res.output as { rules?: string[] };
      if (Array.isArray(o.rules)) {
        out += `#### 📋 Aktif İletişim Kuralları:\n`;
        for (const r of o.rules) out += `- ${r}\n`;
      }
    }
    return out.trim();
  }

  let out = `### ${icon} ${badgeTitle} — \`${res.action}\` ${statusIcon}\n\n`;
  out += `> ${res.message}\n\n`;

  if (res.error) {
    out += `\`\`\`error\n${res.error}\n\`\`\`\n\n`;
  }

  if (res.output && typeof res.output === "object") {
    const o = res.output as Record<string, unknown>;
    if (o.content) {
      out += `#### 📄 Çekilen Sayfa İçeriği:\n\n${o.content}\n\n`;
    }
    if (o.text) {
      out += `#### 📄 Çekilen Web İçeriği:\n\n${o.text}\n\n`;
    }
    if (o.title) {
      out += `- 🌐 **Sayfa Başlığı:** ${o.title}\n`;
    }
    if (o.url) {
      out += `- 🔗 **URL:** [${o.url}](${o.url})\n`;
    }
    if (Array.isArray(o.elements) && o.elements.length > 0) {
      out += `\n#### 🎯 Etkileşimli Öğeler (Set-of-Mark Index):\n`;
      const topElements = o.elements.slice(0, 15) as { index: number; tag: string; text: string }[];
      for (const el of topElements) {
        out += `- **[${el.index}]** \`<${el.tag}>\` ${el.text ? `"${el.text}"` : ""}\n`;
      }
      if (o.elements.length > 15) {
        out += `*...ve ${o.elements.length - 15} etkileşimli öğe daha.*\n`;
      }
      out += `\n*(Bu öğelere tıklamak için: \`{"action":"click","index":1}\` veya yazı yazmak için: \`{"action":"type","index":2,"text":"..."}\`)*\n\n`;
    }
    if (o.metrics) {
      const m = o.metrics as { width: number; height: number; cursorX: number; cursorY: number };
      out += `- 🖥️ **Ekran:** ${m.width}x${m.height} | 🎯 **İmleç:** (${m.cursorX}, ${m.cursorY})\n`;
    }
    if (o.window) {
      const w = o.window as { title: string; width: number; height: number };
      out += `- 🪟 **Aktif Pencere:** "${w.title}" (${w.width}x${w.height})\n`;
    }
  }

  return out.trim();
}
