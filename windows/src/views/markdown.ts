// Markdown in the chat's answers, as on the Mac (ChatMarkdown.swift and
// ChatMarkdownView.swift): headings, paragraphs, fenced code with a copy button,
// bullet and numbered lists, quotes and rules, with bold, italic, `code` and
// links inside the text.
//
// Everything is built as DOM nodes with textContent, never as HTML, so nothing
// a model writes can inject markup. Links open only when they are http(s), and
// even then through Rust, which checks the scheme again.

import { Bridge } from "../core/bridge";
import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { N_, t } from "../i18n/i18n";

const STRINGS = {
  copy: N_("Copy"),
  copied: N_("Copied"),
};

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; code: string; file?: string }
  /** `prefix` is "•" or "1."; `indent` the nesting level, from 0. */
  | { kind: "item"; prefix: string; text: string; indent: number }
  | { kind: "quote"; text: string }
  | { kind: "rule" };

const isRule = (s: string) => s === "---" || s === "***" || s === "___";
const isBullet = (s: string) => /^[-*+] /.test(s);
const ordered = (s: string) => /^(\d+)\.\s+/.exec(s);
const isQuote = (s: string) => s.startsWith("> ") || s === ">";

/** Same rules as the Mac's parser, line by line. */
export function parseMarkdown(input: string): Block[] {
  const blocks: Block[] = [];
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const info = line.slice(3).trim();
      let lang = info;
      let file = "";
      if (info.includes(":")) {
        const [l, ...rest] = info.split(":");
        lang = l.trim();
        file = rest.join(":").trim();
      } else if (info.includes(" ")) {
        const [l, ...rest] = info.split(" ");
        lang = l.trim();
        file = rest.join(" ").trim();
      }

      if (!file) {
        for (let p = Math.max(0, i - 4); p < i; p++) {
          const prev = lines[p];
          const m = prev.match(/`([^`\n]+?\.[a-zA-Z0-9_-]+)`/) || prev.match(/\[(?:Okundu|Yamalandı|Dosya Yazıldı|Silindi)\]\s*`?([^\s:`]+)/i);
          if (m) {
            file = m[1].trim();
            break;
          }
        }
      }

      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      blocks.push({ kind: "code", lang, code: code.join("\n"), file });
      i++;
      continue;
    }

    // A heading needs a space after the #s; "#hashtag" stays a paragraph.
    const hashes = /^#+/.exec(line)?.[0].length ?? 0;
    if (hashes && (line.length === hashes || line[hashes] === " ")) {
      const text = line.slice(hashes).trim();
      if (text) blocks.push({ kind: "heading", level: Math.min(hashes, 6), text });
      i++;
      continue;
    }

    const stripped = line.trim();
    if (isRule(stripped)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (isQuote(stripped)) {
      blocks.push({ kind: "quote", text: stripped.startsWith("> ") ? stripped.slice(2) : "" });
      i++;
      continue;
    }

    const indent = Math.floor((line.length - line.trimStart().length) / 2);
    if (isBullet(stripped)) {
      blocks.push({ kind: "item", prefix: "•", text: stripped.slice(2), indent });
      i++;
      continue;
    }
    const number = ordered(stripped);
    if (number) {
      blocks.push({ kind: "item", prefix: `${number[1]}.`, text: stripped.slice(number[0].length), indent });
      i++;
      continue;
    }
    if (!stripped) {
      i++;
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const para = [line];
    for (i++; i < lines.length; i++) {
      const next = lines[i];
      const s = next.trim();
      if (!s || next.startsWith("#") || next.startsWith("```") || isQuote(s) || isBullet(s) || isRule(s) || ordered(s)) break;
      para.push(next);
    }
    blocks.push({ kind: "paragraph", text: para.join("\n") });
  }
  return blocks;
}

// ── Inline ────────────────────────────────────────────────────────────────────

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  /** `url` is null when the target is not a web address: the text stays, the link goes. */
  | { kind: "link"; url: string | null; children: Inline[] };

/**
 * `code`, **bold**, __bold__, *italic*, _italic_ and [text](url), whichever
 * comes first. No lookbehind: older WebKitGTK builds reject it, and one bad
 * regex literal would take the whole island down with it.
 */
const INLINE = /`([^`\n]+)`|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

const isWordChar = (c: string | undefined) => c != null && /\w/.test(c);

/** The address if it is an http(s) one; anything else (javascript:, file:, data:…) is not a link. */
export function safeWebUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  const re = new RegExp(INLINE.source, "g");
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // snake_case_words are not italics: an opening _ must not follow a letter.
    if (m[5] != null && isWordChar(text[m.index - 1])) {
      re.lastIndex = m.index + 1;
      continue;
    }
    pushText(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] != null) out.push({ kind: "code", text: m[1] });
    else if (m[6] != null) out.push({ kind: "link", url: safeWebUrl(m[7]), children: parseInline(m[6]) });
    else if (m[2] != null || m[3] != null) out.push({ kind: "strong", children: parseInline(m[2] ?? m[3]) });
    else out.push({ kind: "em", children: parseInline(m[4] ?? m[5]) });
  }
  pushText(text.slice(at));
  return out;
}

function appendInline(into: HTMLElement, nodes: Inline[]) {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        into.append(document.createTextNode(node.text));
        break;
      case "code":
        into.append(h("code", { class: "md-code", text: node.text }));
        break;
      case "strong":
      case "em": {
        const el = h(node.kind === "strong" ? "strong" : "em");
        appendInline(el, node.children);
        into.append(el);
        break;
      }
      case "link": {
        if (!node.url) {
          appendInline(into, node.children);
          break;
        }
        const url = node.url;
        const a = h("a", { class: "md-link", href: url, title: url });
        a.addEventListener("click", (e) => {
          e.preventDefault();
          void Bridge.openUrl(url);
        });
        appendInline(a, node.children);
        into.append(a);
        break;
      }
    }
  }
}

function inline(text: string, into: HTMLElement) {
  appendInline(into, parseInline(text));
}

// ── Blocks ────────────────────────────────────────────────────────────────────

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard API (or no permission): the old way, through a hidden field.
    const area = h("textarea", { style: "position:fixed;opacity:0" }) as HTMLTextAreaElement;
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/** Puts the code on the clipboard; the check mark shows for a moment. */
function copyButton(text: string): HTMLElement {
  const btn = h("button", { class: "md-copy", title: t(STRINGS.copy), "aria-label": t(STRINGS.copy) }, svg(ICONS.copy, 11));
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await writeClipboard(text);
    btn.replaceChildren(svg(ICONS.check, 11, { stroke: 2.2 }));
    btn.classList.add("done");
    btn.title = t(STRINGS.copied);
    window.setTimeout(() => {
      btn.replaceChildren(svg(ICONS.copy, 11));
      btn.classList.remove("done");
      btn.title = t(STRINGS.copy);
    }, 1500);
  });
  return btn;
}
const LANG_CONFIG: Record<string, { tag: string; name: string; file: string; color: string }> = {
  python: { tag: "PY", name: "python", file: "main.py", color: "#38bdf8" },
  py: { tag: "PY", name: "python", file: "main.py", color: "#38bdf8" },
  typescript: { tag: "TS", name: "typescript", file: "invoice.ts", color: "#3178c6" },
  ts: { tag: "TS", name: "typescript", file: "invoice.ts", color: "#3178c6" },
  javascript: { tag: "JS", name: "javascript", file: "index.js", color: "#facc15" },
  js: { tag: "JS", name: "javascript", file: "index.js", color: "#facc15" },
  rust: { tag: "RS", name: "rust", file: "main.rs", color: "#fb923c" },
  rs: { tag: "RS", name: "rust", file: "main.rs", color: "#fb923c" },
  bash: { tag: "SH", name: "bash", file: "script.sh", color: "#4ade80" },
  sh: { tag: "SH", name: "shell", file: "script.sh", color: "#4ade80" },
  zsh: { tag: "SH", name: "zsh", file: "script.zsh", color: "#4ade80" },
  sql: { tag: "SQL", name: "sql", file: "query.sql", color: "#f472b6" },
  json: { tag: "JSON", name: "json", file: "data.json", color: "#eab308" },
  html: { tag: "HTML", name: "html", file: "index.html", color: "#f97316" },
  css: { tag: "CSS", name: "css", file: "style.css", color: "#38bdf8" },
  swift: { tag: "SWIFT", name: "swift", file: "App.swift", color: "#f97316" },
  c: { tag: "C", name: "c", file: "main.c", color: "#60a5fa" },
  cpp: { tag: "C++", name: "cpp", file: "main.cpp", color: "#60a5fa" },
  go: { tag: "GO", name: "go", file: "main.go", color: "#22d3ee" },
};

const KEYWORDS: Record<string, true> = {
  def: true, class: true, import: true, from: true, return: true, with: true, as: true,
  if: true, elif: true, else: true, for: true, while: true, try: true, except: true,
  finally: true, raise: true, self: true, True: true, False: true, None: true, lambda: true,
  pass: true, break: true, continue: true, yield: true, async: true, await: true, in: true,
  is: true, not: true, and: true, or: true,
  const: true, let: true, var: true, function: true, export: true, default: true,
  interface: true, type: true, enum: true, implements: true, switch: true, case: true,
  throw: true, new: true, this: true, super: true, null: true, undefined: true,
  true: true, false: true, fn: true, pub: true, struct: true, impl: true, mut: true,
  match: true, loop: true, mod: true, use: true, crate: true,
  SELECT: true, INSERT: true, INTO: true, VALUES: true, UPDATE: true, SET: true,
  DELETE: true, FROM: true, WHERE: true, JOIN: true, LEFT: true, RIGHT: true,
  INNER: true, GROUP: true, BY: true, ORDER: true, HAVING: true, LIMIT: true,
  CREATE: true, TABLE: true,
};

function highlightCodeLine(line: string): HTMLElement {
  const isDel = line.startsWith("- ") || line === "-";
  const isAdd = line.startsWith("+ ") || line === "+";
  const rowClass = isDel ? "md-code-row diff-del" : isAdd ? "md-code-row diff-add" : "md-code-row";
  const row = h("div", { class: rowClass });

  const tokenRegex = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|#.*|\/\/.*|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_]\w*\b|[^\s\w]+|\s+)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(line)) !== null) {
    const tok = match[0];
    if (tok.startsWith("#") || tok.startsWith("//")) {
      row.append(h("span", { class: "tok-comment", text: tok }));
    } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith("`")) {
      row.append(h("span", { class: "tok-string", text: tok }));
    } else if (/^\d+(?:\.\d+)?$/.test(tok)) {
      row.append(h("span", { class: "tok-number", text: tok }));
    } else if (KEYWORDS[tok]) {
      row.append(h("span", { class: "tok-keyword", text: tok }));
    } else if (/^[A-Z][a-zA-Z0-9_]*$/.test(tok)) {
      row.append(h("span", { class: "tok-type", text: tok }));
    } else {
      const nextChar = line[tokenRegex.lastIndex];
      if (nextChar === "(" && /^[a-zA-Z_]\w*$/.test(tok)) {
        row.append(h("span", { class: "tok-fn", text: tok }));
      } else {
        row.append(document.createTextNode(tok));
      }
    }
  }

  if (!line) {
    row.append(document.createTextNode(" "));
  }
  return row;
}

function renderCodeCard(code: string, lang: string, file?: string): HTMLElement {
  let normLang = (lang || "").trim().toLowerCase();
  let rawFile = (file || "").trim();

  if (normLang.includes(":")) {
    const [l, ...rest] = normLang.split(":");
    normLang = l.trim();
    if (!rawFile) rawFile = rest.join(":").trim();
  } else if (normLang.includes(" ")) {
    const [l, ...rest] = normLang.split(" ");
    normLang = l.trim();
    if (!rawFile) rawFile = rest.join(" ").trim();
  }

  if (!rawFile && normLang.includes(".")) {
    rawFile = normLang;
    normLang = "";
  }

  let ext = "";
  if (rawFile) {
    const dotIdx = rawFile.lastIndexOf(".");
    if (dotIdx >= 0) ext = rawFile.slice(dotIdx + 1).toLowerCase();
  }

  if (!normLang || normLang === "code" || normLang === "text" || normLang === "diff") {
    if (ext && ext !== "txt") {
      const extMap: Record<string, string> = {
        py: "python", js: "javascript", ts: "typescript", rs: "rust",
        html: "html", htm: "html", css: "css", json: "json", sh: "bash",
        sql: "sql", swift: "swift", c: "c", cpp: "cpp", md: "markdown",
      };
      normLang = extMap[ext] || ext;
    }
  }

  const cleanName = rawFile ? (rawFile.split(/[\\/]/).pop() || rawFile) : "";
  const cfg = LANG_CONFIG[normLang] ?? {
    tag: (ext ? ext.slice(0, 4).toUpperCase() : normLang ? normLang.slice(0, 4).toUpperCase() : "CODE"),
    name: normLang || "text",
    file: cleanName || (normLang ? `code.${normLang}` : "snippet"),
    color: "#475569",
  };

  const displayName = cleanName || cfg.file;

  const lines = code.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let addedCount = 0;
  let removedCount = 0;
  for (const l of lines) {
    if (l.startsWith("+") && !l.startsWith("+++")) addedCount++;
    else if (l.startsWith("-") && !l.startsWith("---")) removedCount++;
  }

  const openBtn = rawFile ? h(
    "button",
    {
      class: "icon-btn md-code-open",
      title: "Dosyayı Düzenleyicide Aç",
      onclick: (e: Event) => {
        e.stopPropagation();
        void Bridge.openFileInVSCode(rawFile);
      },
    },
    svg(ICONS.arrowUpRight, 8),
  ) : null;

  const header = h("div", { class: "md-code-header" },
    h("div", { class: "code-card-left md-code-left" },
      h("span", { class: "md-code-tag", style: `background:${cfg.color};`, text: cfg.tag }),
      h("span", { class: "md-code-title", text: displayName }),
      h("span", { class: "md-code-dot", text: "•" }),
    ),
    h("div", { class: "code-card-right md-code-right" },
      rawFile ? h("span", { class: "md-code-path", style: "font-size:10px;color:var(--dim-3);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", text: rawFile }) : h("span", { class: "md-code-lang", text: cfg.name }),
      addedCount > 0 ? h("span", { class: "tick-count plus", style: "color:#22c55e;font-size:10.5px;font-weight:600;margin-left:4px;", text: `+${addedCount}` }) : null,
      removedCount > 0 ? h("span", { class: "tick-count minus", style: "color:#ef4444;font-size:10.5px;font-weight:600;margin-left:2px;", text: `−${removedCount}` }) : null,
      openBtn,
      copyButton(code),
    ),
  );

  const gutter = h("div", { class: "md-code-gutter" });
  const codeContent = h("div", { class: "md-code-lines" });

  lines.forEach((lineText, idx) => {
    gutter.append(h("div", { text: String(idx + 1) }));
    codeContent.append(highlightCodeLine(lineText));
  });

  const body = h("div", { class: "md-code-body" }, gutter, codeContent);
  return h("div", { class: "md-code-card" }, header, body);
}

function render(block: Block): HTMLElement {
  switch (block.kind) {
    case "heading": {
      const el = h("div", { class: block.level <= 2 ? "md-h md-h1" : "md-h" });
      inline(block.text, el);
      return el;
    }
    case "paragraph": {
      const el = h("div", { class: "md-p" });
      inline(block.text, el);
      return el;
    }
    case "code":
      return renderCodeCard(block.code, block.lang, block.file);
    case "item": {
      const text = h("span", { class: "md-p" });
      inline(block.text, text);
      const item = h("div", { class: "md-item" }, h("span", { class: "md-bullet", text: block.prefix }), text);
      if (block.indent) item.style.paddingLeft = `${block.indent * 12}px`;
      return item;
    }
    case "quote": {
      const text = h("span", { class: "md-p" });
      inline(block.text, text);
      return h("div", { class: "md-quote" }, h("i"), text);
    }
    case "rule":
      return h("hr", { class: "md-rule" });
  }
}

/** Replaces what `into` shows with the Markdown rendered. */
export function renderMarkdown(into: HTMLElement, markdown: string) {
  into.replaceChildren(...parseMarkdown(markdown).map(render));
}
