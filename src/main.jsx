import React from "react";
import { render } from "ink";
import { listSessions, getSessionMessages, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "node:readline/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { doctor } from "./doctor.js";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { AgentSession } from "./session.js";
import { App, makeCanUseTool, makeOnElicitation } from "./ui/app.jsx";
import { MODES } from "./ui/theme.js";
import { buildPlugin, systemPromptAppend, DEFAULT_AUTO_ALLOW, runHelper, PKG_DIR } from "./extras.js";
import { VERSION, CONFIG_PATH, loadConfig, saveConfig, updateConfig, loadHistory, saveHistory, claudeSettingsEffort } from "./config.js";
import { mcpCli, readServers } from "./mcp.js";

// Ink drops mouse reports, so wheel scrolling never reaches the app. Sit between the terminal and Ink:
// pull SGR mouse reports (ESC [ < b ; x ; y M/m) out of stdin, emit them, and pass everything else on.
function mouseFilteredStdin() {
  const mouse = new EventEmitter();
  const proxy = new PassThrough();
  const src = process.stdin;
  proxy.isTTY = src.isTTY;
  proxy.setRawMode = (mode) => {
    src.setRawMode?.(mode);
    return proxy;
  };
  proxy.ref = () => (src.ref(), proxy);
  proxy.unref = () => (src.unref(), proxy);
  let pending = "";
  src.setEncoding("utf8");
  src.on("data", (chunk) => {
    let s = pending + chunk;
    pending = "";
    const tail = /\x1b\[<[\d;]*$/.exec(s);
    if (tail) {
      pending = tail[0];
      s = s.slice(0, -tail[0].length);
    }
    const rest = s.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_, b, x, y, kind) => {
      mouse.emit("mouse", { button: Number(b), x: Number(x), y: Number(y), release: kind === "m" });
      return "";
    });
    if (rest) proxy.write(rest);
  });
  return { stdin: proxy, mouse };
}

function parseArgs(argv) {
  const o = { prompt: null, print: false, model: null, mode: null, cont: false, resume: null, cmd: null, maxBudget: null, maxTurns: null, addDirs: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--print") o.print = true;
    else if (a === "-m" || a === "--model") o.model = argv[++i];
    else if (a === "--mode") o.mode = argv[++i];
    else if (a === "-c" || a === "--continue") o.cont = true;
    else if (a === "-r" || a === "--resume") o.resume = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true;
    else if (a === "--max-budget-usd") o.maxBudget = Number(argv[++i]);
    else if (a === "--max-turns") o.maxTurns = Number(argv[++i]);
    else if (a === "--output-format") o.format = argv[++i];
    else if (a === "--add-dir") o.addDirs.push(path.resolve(argv[++i]));
    else if (a === "-h" || a === "--help") o.cmd = "help";
    else if (a === "-v" || a === "--version") o.cmd = "version";
    else if (i === 0 && ["login", "logout", "mcp", "doctor", "update"].includes(a)) {
      o.cmd = a;
      o.args = argv.slice(1);
      break;
    } else rest.push(a);
  }
  if (rest.length) o.prompt = rest.join(" ");
  return o;
}

async function login(cfg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput;
  let prompted = false;
  rl._writeToOutput = (s) => {
    if (!prompted) {
      prompted = true;
      process.stdout.write(s);
    } else if (s.includes("\n") || s.includes("\r")) process.stdout.write("\n");
    else process.stdout.write("*".repeat(s.length));
  };
  console.log("Paste your Claude Console API key (from the organization linked to your Max plan).");
  const key = (await rl.question("API key: ")).trim();
  rl._writeToOutput = write;
  rl.close();
  if (!key.startsWith("sk-ant-")) {
    console.log("That doesn't look like an Anthropic API key (it should start with sk-ant-).");
    process.exit(1);
  }
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  }).catch((e) => ({ ok: false, status: e.message }));
  if (!res.ok) {
    console.log(`Key check failed (${res.status}). Not saved.`);
    process.exit(1);
  }
  saveConfig({ ...cfg, apiKey: key });
  console.log(`✓ Key …${key.slice(-6)} saved to ${CONFIG_PATH}`);
  process.exit(0);
}

// Updates the dependencies within their allowed versions (package.json ranges) and rebuilds.
function update(checkOnly) {
  const run = (cmd) => spawnSync(cmd, { cwd: PKG_DIR, shell: true, encoding: "utf8" });
  // Installed from npm (no src/ to rebuild): update the package itself.
  if (!existsSync(path.join(PKG_DIR, "src"))) {
    const latest = run("npm view @tanishq03/myclaude version").stdout.trim();
    if (!latest || latest === VERSION) return console.log(`✓ myclaude ${VERSION} is up to date.`);
    console.log(`  myclaude: ${VERSION} → ${latest}`);
    if (checkOnly) return console.log("Run `myclaude update` to install it.");
    const up = run("npm install -g @tanishq03/myclaude@latest");
    return console.log(up.status === 0 ? "✓ Updated." : `✗ npm install failed:
${up.stderr}`);
  }
  const outdated = JSON.parse(run("npm outdated --json").stdout || "{}");
  const rows = Object.entries(outdated).filter(([, v]) => v.current !== v.wanted);
  if (!rows.length) return console.log(`✓ myclaude ${VERSION} is up to date (dependencies are at the newest allowed versions).`);
  for (const [name, v] of rows) console.log(`  ${name}: ${v.current} → ${v.wanted}`);
  if (checkOnly) return console.log("Run `myclaude update` to install these.");
  console.log("Updating…");
  const up = run("npm update");
  if (up.status !== 0) return console.log(`✗ npm update failed:\n${up.stderr}`);
  const build = run("npm run build");
  console.log(build.status === 0 ? "✓ Updated and rebuilt." : `✗ Build failed:\n${build.stderr}`);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

// -p output: "text" (default, human readable), "json" (the final result message, same shape as
// `claude -p --output-format json`) or "stream-json" (every SDK message, one JSON object per line).
async function printMode(session, prompt, format = "text") {
  const w = (s) => process.stdout.write(s);
  let last = null;
  session.onRaw = (m) => {
    if (m.type === "result") last = m;
    if (format === "stream-json" && m.type !== "stream_event") w(JSON.stringify(m) + "\n");
  };
  if (format === "json" || format === "stream-json") {
    session.emit = () => {};
    await session.send(prompt);
    if (format === "json" && last) w(JSON.stringify(last) + "\n");
    session.close();
    process.exit(!last || last.is_error ? 1 : 0);
  }
  session.emit = (e) => {
    if (e.type === "text_delta") w(e.text);
    else if (e.type === "text_done") w("\n");
    else if (e.type === "text") w(e.text + "\n");
    else if (e.type === "tool_use" && !e.parent) w(`● ${e.name}${e.input?.command ? `(${String(e.input.command).slice(0, 100)})` : ""}\n`);
    else if (e.type === "tool_result" && e.isError && !e.parent) w(`  ⎿  ${e.text.split("\n")[0]}\n`);
    else if (e.type === "error") w(`✗ ${e.text}\n`);
    else if (e.type === "result") process.stderr.write(`\n✻ ${(e.durationMs / 1000).toFixed(1)}s · $${e.cost.toFixed(4)}\n`);
  };
  await session.send(prompt);
  session.close();
  process.exit(!last || last.is_error ? 1 : 0);
}

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (!String(w.code ?? "").startsWith("CLAUDE_SDK_")) console.error(w);
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  if (opts.cmd === "version") return console.log(`myclaude ${VERSION}`);
  if (opts.cmd === "help") {
    return console.log(`myclaude ${VERSION} – a Claude Code-style agent on the Claude Agent SDK (billed to your API credits)

Usage:
  myclaude [prompt]          Start an interactive session (optionally with a first prompt)
  myclaude -p "prompt"       Run one prompt, print the answer and exit
  myclaude -c                Continue the most recent conversation in this folder
  myclaude -r [id]           Resume a conversation (pick from a list if no id)
  myclaude login | logout    Save or remove your API key
  myclaude mcp ...           Add, list or remove MCP servers (myclaude mcp for help)
  myclaude doctor            Check the setup (no credits used)
  myclaude update [--check]  Update dependencies within their allowed versions and rebuild

Options:
  -m, --model <name>         sonnet | opus | haiku | full model id (default: ${cfg.model ?? "sonnet"})
  --mode <mode>              ${MODES.join(" | ")} (skips the startup question)
  --max-budget-usd <n>       -p only: stop once this run has cost $n
  --max-turns <n>            -p only: stop after n agent turns
  --output-format <f>        -p only: text | json | stream-json
  --add-dir <path>           Let Claude work in another folder too (repeatable)

Piped input goes to Claude before the prompt:  git diff | myclaude -p "review this"`);
  }
  if (opts.cmd === "login") return login(cfg);
  if (opts.cmd === "logout") {
    delete cfg.apiKey;
    saveConfig(cfg);
    return console.log("✓ API key removed");
  }
  if (opts.cmd === "mcp") return mcpCli(opts.args);
  if (opts.cmd === "doctor") return console.log((await doctor()).join("\n"));
  if (opts.cmd === "update") return update(opts.args.includes("--check"));

  const apiKey = process.env.MYCLAUDE_API_KEY || cfg.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("No API key found. Run: myclaude login");
    process.exit(1);
  }

  // Bill the Console API key only: drop any claude.ai login the SDK could otherwise pick up.
  const env = { ...process.env, ANTHROPIC_API_KEY: apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: `myclaude/${VERSION}` };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.MYCLAUDE_API_KEY;

  let plugin = null;
  try {
    plugin = buildPlugin(VERSION);
  } catch (e) {
    console.error(`(could not set up myclaude skills: ${e.message})`);
  }

  const ctl = { request: null };
  const session = new AgentSession(
    {
      cwd: process.cwd(),
      model: opts.model ?? cfg.model ?? "sonnet",
      permissionMode: opts.mode ?? cfg.mode ?? "default",
      effort: cfg.effort,
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend(cfg) },
      tools: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      skills: "all",
      plugins: plugin ? [{ type: "local", path: plugin.path }] : [],
      mcpServers: readServers("user"),
      ...(opts.addDirs.length ? { additionalDirectories: opts.addDirs } : {}),
      // Claude still decides when to think; "summarized" only returns the thinking text (ctrl+o shows it).
      ...(cfg.showThinking !== false ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
      allowedTools: cfg.autoAllow ?? DEFAULT_AUTO_ALLOW,
      includePartialMessages: true,
      enableFileCheckpointing: true,
      // Interrupting Claude leaves background tasks running; stop them with /tasks.
      perTaskStopAffordance: true,
      agentProgressSummaries: cfg.agentSummaries !== false,
      promptSuggestions: !opts.print && cfg.suggestions !== false,
      ...(opts.print && (opts.maxBudget ?? cfg.maxBudgetUsd) ? { maxBudgetUsd: opts.maxBudget ?? cfg.maxBudgetUsd } : {}),
      ...(opts.print && opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      canUseTool: makeCanUseTool(ctl),
      onElicitation: makeOnElicitation(ctl),
      env,
    },
    () => {},
  );
  ctl.session = session;
  ctl.runHelper = runHelper;
  ctl.autoAllowAndroid = cfg.autoAllowAndroid !== false;
  ctl.applyEmulatorPreference = (headless) => {
    const next = { ...loadConfig(), emulator: { ...(loadConfig().emulator ?? {}), headless } };
    saveConfig(next);
    session.base.systemPrompt = { type: "preset", preset: "claude_code", append: systemPromptAppend(next) };
  };

  const startExtra = typeof opts.resume === "string" ? { resume: opts.resume } : opts.cont ? { continue: true } : {};

  if (opts.print) {
    // `cat error.log | myclaude -p "explain this"`: piped input comes first, then the prompt.
    const prompt = [await readStdin(), opts.prompt].filter(Boolean).join("\n\n");
    if (!prompt) {
      console.log('Usage: myclaude -p "your prompt"   (or pipe text in: cat file | myclaude -p "question")');
      process.exit(1);
    }
    if (opts.format && !["text", "json", "stream-json"].includes(opts.format)) {
      console.log("--output-format must be text, json or stream-json");
      process.exit(1);
    }
    ctl.request = async () => ({
      behavior: "deny",
      message: "This is a non-interactive run, so the user can't approve this. Finish what you can and tell the user what still needs approval.",
    });
    session.start(startExtra);
    return printMode(session, prompt, opts.format);
  }

  if (!process.stdin.isTTY) {
    console.log("myclaude needs an interactive terminal. Use -p for one-off prompts.");
    process.exit(1);
  }

  ctl.onModeChosen = (m) => updateConfig({ mode: m });
  ctl.onModelChosen = (m, effort) => updateConfig({ model: m, effort });
  ctl.onEffortChosen = (effort) => updateConfig({ effort });
  ctl.saveHistory = saveHistory;
  ctl.interactive = true;
  ctl.onVimToggled = (vim) => updateConfig({ vim });

  const mouseOn = "\x1b[?1000h\x1b[?1006h";
  const mouseOff = "\x1b[?1000l\x1b[?1006l";
  process.stdout.write(mouseOn);
  process.on("exit", () => process.stdout.write(mouseOff));
  const { stdin: inkStdin, mouse } = mouseFilteredStdin();
  ctl.mouse = mouse;

  const app = render(
    <App
      ctl={ctl}
      startup={{
        version: VERSION,
        history: loadHistory(),
        defaultEffort: claudeSettingsEffort() ?? "medium",
        headless: !!cfg.emulator?.headless,
        notify: cfg.notify,
        vim: !!cfg.vim,
        autoAllow: cfg.autoAllow ?? DEFAULT_AUTO_ALLOW,
        keyTail: apiKey.slice(-6),
        prompt: opts.prompt,
        askMode: !opts.mode && !opts.cont && !opts.resume,
        pickResume: opts.resume === true,
        startExtra,
        listSessions: () => listSessions({ dir: process.cwd(), limit: 15 }),
        getSessionMessages: (id) => getSessionMessages(id, { dir: process.cwd() }),
        getSessionInfo: (id) => getSessionInfo(id, { dir: process.cwd() }),
      }}
    />,
    { exitOnCtrlC: false, incrementalRendering: true, alternateScreen: true, stdin: inkStdin },
  );

  await app.waitUntilExit();
  process.stdout.write(mouseOff);
  if (session.sessionId) console.log(`\nResume this conversation with: myclaude --resume ${session.sessionId}`);
  session.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`✗ ${e?.stack ?? e}`);
  process.exit(1);
});
