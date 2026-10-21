// Wrapper around @tauri-apps/cli that ensures llvm-mingw and cargo bin directories
// are in PATH even in an already-open terminal window.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.USERPROFILE || process.env.HOME || "";
const mingwBin = join(home, ".cargo", "llvm-mingw-20261006-ucrt-x86_64", "bin");
const cargoBin = join(home, ".cargo", "bin");

const env = {
  ...process.env,
  PATH: `${mingwBin};${cargoBin};${process.env.PATH || ""}`,
};

const tauriBin = join(root, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
const args = process.argv.slice(2);

const child = spawn(tauriBin, args, {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
