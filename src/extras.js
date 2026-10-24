import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUILTIN_SKILLS_DIR = path.join(PKG_DIR, "skills");
export const ANDROID_HELPER = path.join(BUILTIN_SKILLS_DIR, "android", "scripts", "android.mjs");
const PLUGIN_DIR = path.join(os.homedir(), ".myclaude", "plugin");
const SYNCED_DIR = path.join(os.homedir(), ".claude", "skills", "synced");

// claude.ai-synced skills that only work inside the Claude apps (browser, desktop control,
// connectors) or duplicate a skill Claude Code already ships.
const SYNCED_EXCLUDE = new Set(["built-in-browser", "chrome-browser", "computer-use", "docs", "google-workspace", "morning", "import-memory", "deep-research"]);

// Leading-wildcard rules like "Bash(node *android.mjs*)" also matched `node -e "<any code>" android.mjs`,
// so only plain prefixes live here; full-path adb/emulator/helper calls are checked by isAndroidCommand.
export const DEFAULT_AUTO_ALLOW = [
  "Bash(adb *)",
  "Bash(adb:*)",
  "PowerShell(adb *)",
  "Bash(emulator *)",
  "Bash(emulator:*)",
  "PowerShell(emulator *)",
];

const ANDROID_EXES = new Set(["adb", "adb.exe", "emulator", "emulator.exe"]);
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// True for a single adb/emulator call (any path) or `node <the android helper> ...`.
// Anything with shell operators, substitution or chaining is left to the normal permission prompt.
export function isAndroidCommand(cmd) {
  if (typeof cmd !== "string" || /[;&|<>`$()\r\n]/.test(cmd.replace(/^\s*&\s+/, ""))) return false;
  const tokens = [...cmd.replace(/^\s*&\s+/, "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (!tokens.length) return false;
  const exe = path.basename(tokens[0].replace(/\\/g, "/")).toLowerCase();
  if (ANDROID_EXES.has(exe)) return true;
  return (exe === "node" || exe === "node.exe") && !!tokens[1] && samePath(path.resolve(tokens[1]), ANDROID_HELPER);
}

function syncedSkills() {
  const found = new Map();
  if (!fs.existsSync(SYNCED_DIR)) return found;
  const buckets = fs
    .readdirSync(SYNCED_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => path.join(SYNCED_DIR, d.name))
    .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { p } of buckets) {
    for (const d of fs.readdirSync(p, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".") || SYNCED_EXCLUDE.has(d.name) || found.has(d.name)) continue;
      const dir = path.join(p, d.name);
      if (fs.existsSync(path.join(dir, "SKILL.md"))) found.set(d.name, dir);
    }
  }
  return found;
}

function linkDir(target, link) {
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) {
      if (path.resolve(fs.readlinkSync(link)) === path.resolve(target)) return;
      fs.rmdirSync(link);
    } else return;
  } catch {}
  fs.symlinkSync(target, link, "junction");
}

// Builds a local plugin that carries myclaude's built-in skills plus the user's claude.ai-synced
// skills (which Claude Code only loads when signed in to claude.ai).
export function buildPlugin(version) {
  const skillsDir = path.join(PLUGIN_DIR, "skills");
  fs.mkdirSync(path.join(PLUGIN_DIR, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "myclaude", version, description: "myclaude built-in skills and your claude.ai skills" }, null, 2),
  );
  const wanted = new Map();
  for (const d of fs.readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true })) {
    if (d.isDirectory()) wanted.set(d.name, path.join(BUILTIN_SKILLS_DIR, d.name));
  }
  for (const [name, dir] of syncedSkills()) if (!wanted.has(name)) wanted.set(name, dir);

  for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    const p = path.join(skillsDir, d.name);
    if (!wanted.has(d.name)) {
      try {
        if (fs.lstatSync(p).isSymbolicLink()) fs.rmdirSync(p);
      } catch {}
    }
  }
  for (const [name, dir] of wanted) {
    try {
      linkDir(dir, path.join(skillsDir, name));
    } catch {}
  }
  return { path: PLUGIN_DIR, skills: [...wanted.keys()] };
}

export function systemPromptAppend(cfg) {
  const parts = [];
  if (process.platform === "win32") {
    parts.push(
      "The user is on Windows. When you start long-running or GUI programs (Android emulators, dev servers, watchers, apps), launch them so your command returns immediately: use the run_in_background option of the Bash/PowerShell tool, or Start-Process without waiting. Then check on them with separate short commands. Never run a command that waits for a program that does not exit.",
    );
  }
  // Kept short: this is sent with every request. The full how-to lives in the myclaude:android skill,
  // which only loads when Android work comes up.
  const headless = !!cfg.emulator?.headless;
  parts.push(
    [
      `Android devices and emulators: load the myclaude:android skill first. Its helper is node "${ANDROID_HELPER}" <command>.`,
      headless
        ? "The user's emulator window preference: HIDDEN. Always start emulators with --headless unless they ask to see it."
        : "The user's emulator window preference: VISIBLE. Start emulators with a window (no --headless) unless they ask to hide it.",
    ].join(" "),
  );
  return parts.join("\n\n");
}

// Opens a file or URL with the system's default app, without waiting.
export function openExternal(target) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

export function runHelper(args) {
  const r = spawnSync(process.execPath, [ANDROID_HELPER, ...args], { encoding: "utf8", timeout: 20000 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}
