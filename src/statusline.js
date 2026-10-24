import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readJson } from "./config.js";

// The `statusLine` setting from Claude Code's settings files (later files win, like Claude Code).
export function statusLineSetting(cwd = process.cwd()) {
  let found = null;
  let disabled = false;
  for (const f of [path.join(os.homedir(), ".claude", "settings.json"), path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")]) {
    const s = readJson(f, {});
    if (s.statusLine) found = s.statusLine;
    if (s.disableAllHooks) disabled = true;
  }
  return !disabled && found?.type === "command" && found.command ? found : null;
}

// Claude Code runs commands with bash on Windows when Git Bash is installed, so status line scripts
// written for it expect bash.
let shell;
function shellFor() {
  if (shell) return shell;
  if (process.platform !== "win32") return (shell = [process.env.SHELL || "/bin/sh", "-c"]);
  const bash = [process.env.CLAUDE_CODE_GIT_BASH_PATH, "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find((p) => p && fs.existsSync(p));
  return (shell = bash ? [bash, "-c"] : ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
}

// Same JSON input Claude Code pipes to the status line command (the fields myclaude knows).
export function statusInput({ sessionId, model, modelName, cost, durationMs, contextPct, vimMode, version, outputStyle }) {
  const cwd = process.cwd();
  return {
    hook_event_name: "Status",
    session_id: sessionId ?? "",
    transcript_path: sessionId ? path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`) : "",
    cwd,
    model: { id: model, display_name: modelName ?? model },
    workspace: { current_dir: cwd, project_dir: cwd },
    version,
    output_style: { name: outputStyle ?? "default" },
    cost: { total_cost_usd: cost ?? 0, total_duration_ms: durationMs ?? 0 },
    ...(contextPct != null ? { context_window: { used_percentage: contextPct, remaining_percentage: 100 - contextPct } } : {}),
    ...(vimMode ? { vim: { mode: vimMode.toUpperCase() } } : {}),
  };
}

export function runStatusLine(setting, input) {
  const [cmd, ...args] = shellFor();
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(cmd, [...args, setting.command], { cwd: process.cwd(), windowsHide: true });
    const timer = setTimeout(() => p.kill(), 5000);
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(null));
    p.on("close", () => {
      clearTimeout(timer);
      resolve(out.replace(/\s+$/, "").split(/\r?\n/).slice(0, 3).join("\n") || null);
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(input));
  });
}
