import path from "node:path";
import { CONFIG_DIR, readJson, writeJson } from "./config.js";

// myclaude's own MCP servers. "user" servers live in ~/.myclaude/mcp.json and are passed to the SDK
// (so they can be changed live with setMcpServers); "project" servers go in ./.mcp.json, the same file
// Claude Code reads. Servers added with `claude mcp add` are loaded too, through Claude Code's settings.
const USER_FILE = path.join(CONFIG_DIR, "mcp.json");
export const SCOPES = {
  user: { file: () => USER_FILE, label: "User (all your projects, myclaude only)" },
  project: { file: () => path.join(process.cwd(), ".mcp.json"), label: "Project (.mcp.json in this folder, shared)" },
};

export const readServers = (scope) => readJson(SCOPES[scope].file(), {}).mcpServers ?? {};

export function addServer(scope, name, config) {
  const file = SCOPES[scope].file();
  const data = readJson(file, {});
  data.mcpServers = { ...data.mcpServers, [name]: config };
  writeJson(file, data);
  return file;
}

export function removeServer(scope, name) {
  const file = SCOPES[scope].file();
  const data = readJson(file, {});
  if (!data.mcpServers?.[name]) return false;
  delete data.mcpServers[name];
  writeJson(file, data);
  return true;
}

export const splitCommandLine = (s) => [...String(s).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

export function serverConfig(type, target, { env = {}, headers = {} } = {}) {
  if (type === "http" || type === "sse") {
    return { type, url: target, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  let [command, ...args] = Array.isArray(target) ? target : splitCommandLine(target);
  // npx/npm/pnpm/yarn are .cmd shims on Windows and can't be spawned directly.
  if (process.platform === "win32" && /^(npx|npm|pnpm|yarn|bunx)$/i.test(command)) {
    args = ["/c", command, ...args];
    command = "cmd";
  }
  return { type: "stdio", command, args, ...(Object.keys(env).length ? { env } : {}) };
}

export const describeServer = (c) => c.url ?? [c.command, ...(c.args ?? [])].join(" ");

const USAGE = `Usage:
  myclaude mcp list
  myclaude mcp add [-s user|project] [-t stdio|http|sse] [-e KEY=value] [-H "Name: value"] <name> <url | command> [args...]
  myclaude mcp remove [-s user|project] <name>

Examples:
  myclaude mcp add playwright -- npx @playwright/mcp@latest
  myclaude mcp add -t http -s project sentry https://mcp.sentry.dev/mcp
  myclaude mcp add -e API_KEY=xyz mytool -- node ./server.js

user (default): ~/.myclaude/mcp.json · project: ./.mcp.json
Servers from \`claude mcp add\` and plugins load too; manage those with \`claude mcp\`.`;

export function mcpCli(argv) {
  const [sub, ...rest] = argv;
  const opts = { scope: "user", type: null, env: {}, headers: {} };
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") {
      pos.push(...rest.slice(i + 1));
      break;
    } else if (a === "-s" || a === "--scope") opts.scope = rest[++i];
    else if (a === "-t" || a === "--transport") opts.type = rest[++i];
    else if (a === "-e" || a === "--env") {
      const [k, ...v] = String(rest[++i]).split("=");
      opts.env[k] = v.join("=");
    } else if (a === "-H" || a === "--header") {
      const [k, ...v] = String(rest[++i]).split(":");
      opts.headers[k.trim()] = v.join(":").trim();
    } else pos.push(a);
  }
  if (!SCOPES[opts.scope]) return console.log(`Unknown scope "${opts.scope}". Use user or project.`);

  if (sub === "list") {
    for (const scope of Object.keys(SCOPES)) {
      const servers = Object.entries(readServers(scope));
      console.log(`${scope} (${SCOPES[scope].file()}):`);
      if (!servers.length) console.log("  (none)");
      for (const [name, c] of servers) console.log(`  ${name}: ${describeServer(c)} (${c.type ?? "stdio"})`);
    }
    return console.log("\nServers from Claude Code (`claude mcp list`) and plugins are loaded too.");
  }
  if (sub === "add" && pos.length >= 2) {
    const [name, target, ...args] = pos;
    const type = opts.type ?? (/^https?:\/\//.test(target) ? "http" : "stdio");
    if (!["stdio", "http", "sse"].includes(type)) return console.log(`Unknown transport "${type}".`);
    const file = addServer(opts.scope, name, serverConfig(type, type === "stdio" ? [target, ...args] : target, opts));
    return console.log(`✓ Added ${type} server "${name}" to ${file}`);
  }
  if (sub === "remove" && pos.length === 1) {
    const ok = removeServer(opts.scope, pos[0]);
    return console.log(ok ? `✓ Removed "${pos[0]}" (${opts.scope})` : `No ${opts.scope} server named "${pos[0]}".`);
  }
  console.log(USAGE);
}
