// Programming language detection and official brand colors.
// Ported and adapted from dotpals (MIT).

export interface LanguageInfo {
  label: string;
  color: string;
}

const LANG_MAP: Record<string, [string, string]> = {
  ts: ["TS", "#3178C6"],
  tsx: ["TSX", "#3178C6"],
  mts: ["TS", "#3178C6"],
  cts: ["TS", "#3178C6"],
  js: ["JS", "#F7DF1E"],
  mjs: ["JS", "#F7DF1E"],
  cjs: ["JS", "#F7DF1E"],
  jsx: ["JSX", "#61DAFB"],
  py: ["PY", "#3776AB"],
  rs: ["RS", "#DEA584"],
  go: ["GO", "#00ADD8"],
  rb: ["RB", "#CC342D"],
  java: ["JAVA", "#ED8B00"],
  kt: ["KT", "#7F52FF"],
  swift: ["SWIFT", "#F05138"],
  cs: ["C#", "#68217A"],
  cpp: ["C++", "#00599C"],
  c: ["C", "#555555"],
  h: ["H", "#555555"],
  hpp: ["C++", "#00599C"],
  php: ["PHP", "#777BB4"],
  lua: ["LUA", "#000080"],
  dart: ["DART", "#0175C2"],
  html: ["HTML", "#E34F26"],
  css: ["CSS", "#1572B6"],
  scss: ["SCSS", "#CF649A"],
  vue: ["VUE", "#4FC08D"],
  svelte: ["SVELTE", "#FF3E00"],
  astro: ["ASTRO", "#BC52EE"],
  json: ["JSON", "#858585"],
  yml: ["YAML", "#CB171E"],
  yaml: ["YAML", "#CB171E"],
  toml: ["TOML", "#9C4221"],
  md: ["MD", "#71717A"],
  mdx: ["MDX", "#1B1F24"],
  sh: ["SH", "#4EAA25"],
  bash: ["BASH", "#4EAA25"],
  ps1: ["PS", "#012456"],
  bat: ["BAT", "#C1F12E"],
  sql: ["SQL", "#E38C00"],
  dockerfile: ["DOCKER", "#2496ED"],
};

export function fileLanguage(path: string): LanguageInfo | null {
  const clean = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (!clean) return null;

  if (clean === "dockerfile" || clean.startsWith("dockerfile.")) {
    return { label: LANG_MAP.dockerfile[0], color: LANG_MAP.dockerfile[1] };
  }

  const parts = clean.split(".");
  if (parts.length > 1) {
    const ext = parts[parts.length - 1];
    const match = LANG_MAP[ext];
    if (match) {
      return { label: match[0], color: match[1] };
    }
    if (/^[a-z0-9]{1,5}$/.test(ext)) {
      return { label: ext.toUpperCase(), color: "#64748B" };
    }
  }

  return null;
}
