import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_PATH, CONFIG_DIR, VERSION, loadConfig } from "./config.js";
import { PKG_DIR } from "./extras.js";
import { SETTINGS } from "./settings.js";

const ok = (t) => `✔ ${t}`;
const warn = (t) => `⚠ ${t}`;
const bad = (t) => `✗ ${t}`;

function jsonCheck(label, file) {
  if (!fs.existsSync(file)) return null;
  try {
    JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return ok(`${label}: ${file}`);
  } catch (e) {
    return bad(`${label} is not valid JSON: ${file} (${e.message})`);
  }
}

function newestMtime(dir) {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}

/**
 * Health check. Makes no Claude requests: the key check lists models, which uses no credits.
 * `session` (optional) adds live checks: auth source and MCP servers.
 */
export async function doctor(session) {
  const out = [];
  const cfg = loadConfig();
  const sdkVersion = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(PKG_DIR, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")).version;
    } catch {
      return null;
    }
  })();

  out.push("Versions");
  out.push(ok(`myclaude ${VERSION}`));
  const major = Number(process.versions.node.split(".")[0]);
  out.push(major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} (needs 20 or newer)`));
  out.push(sdkVersion ? ok(`Agent SDK ${sdkVersion}${session?.info?.claude_code_version ? ` · Claude Code engine ${session.info.claude_code_version}` : ""}`) : bad("Agent SDK not installed (run npm install in the myclaude folder)"));
  try {
    if (newestMtime(path.join(PKG_DIR, "src")) > fs.statSync(path.join(PKG_DIR, "dist", "myclaude.js")).mtimeMs) out.push(warn("src/ changed after the last build: run npm run build"));
  } catch {}

  out.push("", "API key");
  const key = process.env.MYCLAUDE_API_KEY || cfg.apiKey || process.env.ANTHROPIC_API_KEY;
  const from = process.env.MYCLAUDE_API_KEY ? "MYCLAUDE_API_KEY" : cfg.apiKey ? CONFIG_PATH : process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null;
  if (!key) out.push(bad("No API key. Run: myclaude login"));
  else {
    out.push(ok(`Key …${key.slice(-6)} from ${from}`));
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }).catch((e) => ({ ok: false, status: e.message }));
    out.push(res.ok ? ok("Key accepted by the API (checked without using credits)") : bad(`Key check failed: ${res.status}`));
  }
  if (session?.info) {
    out.push(session.info.apiKeySource === "ANTHROPIC_API_KEY" ? ok("Requests are billed to this API key") : bad(`Requests use "${session.info.apiKeySource}" instead of your API key`));
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN) out.push(ok("A claude.ai token is set in your environment; myclaude removes it before starting Claude"));

  out.push("", "Config files");
  for (const line of [
    jsonCheck("myclaude config", CONFIG_PATH),
    jsonCheck("myclaude MCP servers", path.join(CONFIG_DIR, "mcp.json")),
    ...Object.entries(SETTINGS).map(([scope, s]) => jsonCheck(`${scope} settings`, s.file())),
    jsonCheck("project MCP servers", path.join(process.cwd(), ".mcp.json")),
    jsonCheck("keybindings", path.join(os.homedir(), ".claude", "keybindings.json")),
  ]) {
    if (line) out.push(line);
  }

  out.push("", "Tools");
  if (process.platform === "win32") {
    const bash = [process.env.CLAUDE_CODE_GIT_BASH_PATH, "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find((p) => p && fs.existsSync(p));
    out.push(bash ? ok(`Git Bash: ${bash}`) : warn("Git Bash not found: Claude uses PowerShell for commands, and bash status line scripts won't run"));
  }
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk") : path.join(os.homedir(), "Android", "Sdk"));
  const adb = path.join(sdkRoot, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  out.push(fs.existsSync(adb) ? ok(`adb: ${adb}`) : warn("adb not found in the Android SDK (only needed for the Android skill)"));

  if (session?.q) {
    out.push("", "MCP servers");
    const st = await session.q.mcpServerStatus().catch(() => null);
    if (!st?.length) out.push(ok("none configured"));
    for (const s of st ?? []) {
      const name = s.name.replace(/^plugin:([^:]+):.*$/, "$1");
      out.push(s.status === "connected" ? ok(`${name} (${s.tools?.length ?? 0} tools)`) : s.status === "failed" ? bad(`${name} failed${s.error ? `: ${s.error}` : ""}`) : warn(`${name}: ${s.status}`));
    }
  }
  return out;
}
