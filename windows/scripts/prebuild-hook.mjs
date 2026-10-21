// Smart prebuild script for coucou-hook:
// Attempts to build `coucou-hook` with cargo and llvm-mingw in PATH.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(root, "target", "release");
const hookExe = join(targetDir, process.platform === "win32" ? "coucou-hook.exe" : "coucou-hook");
const snipperExe = join(targetDir, "omi-snipper.exe");
const snipperCs = join(root, "snipper", "OmiSnipper.cs");
const tempSnipper = join(process.env.TEMP || tmpdir(), "omi_snipper.exe");
const cscExe = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

if (process.platform === "win32" && existsSync(snipperCs) && existsSync(cscExe)) {
  try {
    mkdirSync(targetDir, { recursive: true });
    execSync(`"${cscExe}" /nologo /target:winexe /optimize+ /out:"${snipperExe}" "${snipperCs}"`, { stdio: "ignore" });
    execSync(`"${cscExe}" /nologo /target:winexe /optimize+ /out:"${tempSnipper}" "${snipperCs}"`, { stdio: "ignore" });
    console.log("[Omi] omi-snipper.exe is ready.");
  } catch (err) {
    console.warn("[Omi] Could not precompile omi-snipper.exe:", err);
  }
}

const home = process.env.USERPROFILE || process.env.HOME || "";
const mingwBin = join(home, ".cargo", "llvm-mingw-20261006-ucrt-x86_64", "bin");
const cargoBin = join(home, ".cargo", "bin");

if (existsSync(hookExe)) {
  console.log("[Omi] coucou-hook.exe is ready.");
  process.exit(0);
}

try {
  execSync("cargo build --release -p coucou-hook", {
    cwd: root,
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: `${mingwBin};${cargoBin};${process.env.PATH || ""}`,
    },
  });
  console.log("[Omi] Built coucou-hook successfully.");
} catch {
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(hookExe)) {
    writeFileSync(hookExe, "");
  }
  console.log("[Omi] Skipping native hook compilation (running in Web / Dev mode).");
}
