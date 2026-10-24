import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openExternal } from "../extras.js";
import { MODES, MODE_INFO, EFFORTS, EFFORT_ICON } from "./theme.js";
import { trunc, cap, kTokens, plural, rel, toolTitle, toolSummary, resultSummary } from "./format.js";
import { historyItems } from "./transcript.jsx";
import { copyText } from "../clipboard.js";
import { doctor } from "../doctor.js";
import { SETTINGS, listRules, addRule, removeRule, listHooks } from "../settings.js";
import { readJson, writeJson } from "../config.js";
import { SCOPES, readServers, addServer, removeServer, serverConfig, describeServer } from "../mcp.js";

export const LOCAL_COMMANDS = [
  { name: "help", desc: "Show commands and shortcuts" },
  { name: "model", desc: "Switch model and effort" },
  { name: "effort", desc: "Set how hard Claude thinks", argumentHint: "[low|medium|high|xhigh|max]" },
  { name: "mode", desc: "Change permission mode" },
  { name: "plan", desc: "Switch to plan mode" },
  { name: "clear", desc: "Start a new conversation", aliases: ["new"] },
  { name: "resume", desc: "Resume an earlier conversation" },
  { name: "rewind", desc: "Restore code and/or conversation to an earlier point (esc esc)" },
  { name: "context", desc: "Show what fills the context window" },
  { name: "agents", desc: "List and create subagents" },
  { name: "skills", desc: "List, create and add skills" },
  { name: "mcp", desc: "MCP servers: add, status, tools, reconnect" },
  { name: "tasks", desc: "Background tasks and subagents (stop them)" },
  { name: "memory", desc: "Open a CLAUDE.md memory file" },
  { name: "add-dir", desc: "Let Claude work in another folder too (this session)", argumentHint: "<path>" },
  { name: "vim", desc: "Toggle vim editing mode" },
  { name: "permissions", desc: "View, add and remove allow / ask / deny rules", aliases: ["allowed-tools"] },
  { name: "hooks", desc: "Show the hooks that run on Claude's actions" },
  { name: "export", desc: "Save the conversation to a file or the clipboard", argumentHint: "[file]" },
  { name: "doctor", desc: "Check the setup: key, versions, config files, tools, MCP" },
  { name: "emulator", desc: "Devices, emulators and window (headless) setting" },
  { name: "allowed", desc: "Commands that run without asking" },
  { name: "status", desc: "Show model, mode, auth, context and cost" },
  { name: "exit", desc: "Quit myclaude", aliases: ["quit"] },
];

const HELP_SHORTCUTS = [
  "Shortcuts",
  "  shift+tab        cycle mode: manual → accept edits → plan → auto",
  "  esc              interrupt Claude · esc esc rewind",
  "  ctrl+b           move running commands/agents to the background",
  "  ctrl+o           expand / collapse tool calls, thinking and subagent details",
  "  ctrl+r           search earlier prompts",
  "  ctrl+t           show / hide the task list",
  "  ctrl+l           clear the input · ctrl+d exit (empty input) · alt+p model picker",
  "  ctrl+x ctrl+k    stop all background tasks",
  "  (rebind keys in ~/.claude/keybindings.json, same format as Claude Code)",
  "  ctrl+c           interrupt · press twice to exit",
  "  ↑/↓              previous prompts (saved across sessions)",
  "  PgUp/PgDn, wheel scroll the conversation",
  "  shift/alt+enter  new line (or ctrl+j, or \\ then Enter)",
  "  @path            mention a file (tab to complete)",
  "  !command         run a shell command; its output goes to Claude with your next message",
  "  alt+v            paste an image (or paste/drag an image file's path)",
  "  ctrl+w/u/k       delete word / to start / to end",
];

const agentDirs = () => ({
  project: { dir: path.join(process.cwd(), ".claude", "agents"), label: "Project (.claude/agents)" },
  user: { dir: path.join(os.homedir(), ".claude", "agents"), label: "Personal (~/.claude/agents, all projects)" },
});
const skillDirs = () => ({
  user: { dir: path.join(os.homedir(), ".claude", "skills"), label: "Personal (~/.claude/skills, all projects)" },
  project: { dir: path.join(process.cwd(), ".claude", "skills"), label: "Project (.claude/skills)" },
});

async function pickScope(app, title, dirs) {
  return app.openDialog({ kind: "select", title, options: Object.entries(dirs).map(([value, d]) => ({ value, label: d.label })) });
}

/**
 * Runs a local slash command. Returns false for commands Claude should handle (custom commands, skills,
 * /compact, /init, ...). `app` is the bridge into the UI (see App in app.jsx).
 */
export async function runCommand(app, text) {
  const { ctl, push, openDialog, ask } = app;
  const [rawCmd, ...args] = text.slice(1).split(/\s+/);
  const arg = args.join(" ").trim();
  const q = () => ctl.session.q;
  const info = (t) => push({ kind: "info", text: t });
  const error = (t) => push({ kind: "error", text: t });

  switch (rawCmd.toLowerCase()) {
    case "help":
      info(
        [
          "Commands",
          ...LOCAL_COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.desc}`),
          "  Other /commands (/compact, /init, /review, your custom commands and skills) go to Claude.",
          "",
          ...HELP_SHORTCUTS,
        ].join("\n"),
      );
      return true;

    case "exit":
    case "quit":
      app.exit();
      return true;

    case "clear":
    case "new":
      app.newConversation();
      return true;

    case "model": {
      if (arg) {
        await ctl.session.setModel(arg);
        app.setModel(arg);
        info(`Model set to ${arg}`);
        return true;
      }
      const list = await app.loadModels();
      if (!list.length) {
        info("Couldn't load the model list. Use /model <name> (sonnet, opus, haiku or a model id).");
        return true;
      }
      const r = await openDialog({ kind: "model", models: list, current: ctl.session.model, effort: app.effort(), defaultEffort: app.startup.defaultEffort });
      if (!r) return true;
      await ctl.session.setModel(r.model);
      app.setModel(r.model);
      if (r.effort !== app.effort()) await app.setEffort(r.effort);
      if (r.save) ctl.onModelChosen?.(r.model, r.effort);
      info(`Set model to ${app.modelName(r.model)} · ${r.effort} effort${r.save ? " (saved as default)" : " (this session only)"}`);
      return true;
    }

    case "effort": {
      const e =
        EFFORTS.find((x) => x === arg.toLowerCase()) ||
        (arg
          ? null
          : await openDialog({
              kind: "select",
              title: "Effort",
              subtitle: "How hard Claude thinks. Higher effort is smarter but slower and uses more credit.",
              initial: EFFORTS.indexOf(app.effort()),
              current: app.effort(),
              options: EFFORTS.map((x) => ({ value: x, label: `${EFFORT_ICON[x]} ${cap(x)}`, hint: x === app.startup.defaultEffort ? "default" : "" })),
            }));
      if (e) {
        await app.setEffort(e);
        ctl.onEffortChosen?.(e);
        info(`Effort set to ${e}`);
      } else if (arg) error(`Unknown effort. Use one of: ${EFFORTS.join(", ")}`);
      return true;
    }

    case "plan":
      await app.changeMode("plan", true);
      return true;

    case "mode": {
      const m = MODES.find((x) => x.toLowerCase() === arg.toLowerCase()) || (arg ? null : await openDialog(app.modeDialog("Choose a permission mode")));
      if (m) await app.changeMode(m, true);
      else if (arg) error(`Unknown mode. Use one of: ${MODES.join(", ")}`);
      return true;
    }

    case "resume": {
      const id = arg || (await app.pickResume());
      if (id) await app.resume(id);
      return true;
    }

    case "rewind":
      await app.rewind();
      return true;

    case "context": {
      const u = await q()?.getContextUsage().catch((e) => ({ error: e?.message ?? String(e) }));
      if (!u || u.error) error(`Couldn't read context usage${u?.error ? `: ${u.error}` : ""}`);
      else push({ kind: "context", usage: u });
      return true;
    }

    case "memory": {
      const u = await q()?.getContextUsage().catch(() => null);
      const known = new Map((u?.memoryFiles ?? []).map((f) => [path.resolve(f.path), f]));
      for (const p of [path.join(process.cwd(), "CLAUDE.md"), path.join(os.homedir(), ".claude", "CLAUDE.md")]) if (!known.has(p)) known.set(p, null);
      const file = await openDialog({
        kind: "select",
        title: "Memory files",
        subtitle: "Claude reads these at the start of every conversation.",
        options: [...known].map(([p, f]) => ({
          value: p,
          label: p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : rel(p),
          hint: f ? `${f.type} · ${kTokens(f.tokens)} tokens` : fs.existsSync(p) ? "not loaded" : "create",
        })),
      });
      if (!file) return true;
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "# Memory\n\n");
      }
      openExternal(file);
      info(`Opened ${file}. Changes apply to new conversations (/clear).`);
      return true;
    }

    case "add-dir": {
      const dirArg = arg || (await ask("Add a working folder", "Path to the folder"));
      if (!dirArg) return true;
      const dir = path.resolve(dirArg.replace(/^["']|["']$/g, ""));
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return error(`Not a folder: ${dir}`), true;
      const dirs = new Set(ctl.session.base.additionalDirectories ?? []);
      dirs.add(dir);
      ctl.session.base.additionalDirectories = [...dirs];
      app.reloadSession();
      info(`Claude can now read and edit files in ${dir} (this session). Start with --add-dir to do it from the start.`);
      return true;
    }

    case "permissions":
    case "allowed-tools":
      await permissionsCommand(app);
      return true;

    case "hooks": {
      const hooks = listHooks();
      if (!hooks.length) {
        info('No hooks set up. Add them under "hooks" in .claude/settings.json or ~/.claude/settings.json (same format as Claude Code). Plugin hooks run too.');
        return true;
      }
      const rows = hooks.map((h) => (h.disabled ? `  ${h.scope}: disableAllHooks is on (no hooks run)` : `  ${h.event.padEnd(18)} ${h.matcher.padEnd(14)} ${trunc(h.command, Math.max(20, app.width - 50))}  (${h.scope})`));
      info([`Hooks (${hooks.filter((h) => !h.disabled).length}), from your settings files. Plugin hooks run too.`, ...rows].join("\n"));
      return true;
    }

    case "export": {
      const items = ctl.session.sessionId
        ? historyItems(await app.startup.getSessionMessages(ctl.session.sessionId).catch(() => []), Infinity)
        : app.items();
      const text = transcriptText(items);
      if (!text) return info("Nothing to export yet."), true;
      const where =
        arg ||
        (await openDialog({
          kind: "select",
          title: "Export conversation",
          options: [
            { value: "__file", label: "Save to a file", hint: "in this folder" },
            { value: "__clip", label: "Copy to clipboard" },
          ],
        }));
      if (!where) return true;
      if (where === "__clip") {
        info((await copyText(text)) ? `Copied the conversation (${plural(text.split("\n").length, "line")}) to the clipboard.` : "Couldn't reach the clipboard.");
        return true;
      }
      const first = items.find((i) => i.kind === "user")?.text ?? "conversation";
      const name = where === "__file" ? `${new Date().toISOString().slice(0, 10)}-${first.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "conversation"}.txt` : where;
      const file = path.resolve(name);
      fs.writeFileSync(file, text + "\n");
      info(`Saved the conversation to ${file}`);
      return true;
    }

    case "doctor":
      info("Checking…");
      info((await doctor(ctl.session)).join("\n"));
      return true;

    case "vim":
      info(app.toggleVim() ? "Vim mode on: esc for normal mode, i/a to insert. /vim again to turn it off." : "Vim mode off.");
      return true;

    case "agents": {
      const agents = (await q()?.supportedAgents().catch(() => null)) ?? (await ctl.session.init())?.agents ?? [];
      const pick = await openDialog({
        kind: "select",
        title: "Agents",
        subtitle: "Claude hands work to these subagents on its own, or when you ask (\"use the X agent to …\").",
        options: [
          { value: "__new", label: "Create new agent…", hint: "describe it, Claude writes it" },
          ...agents.map((a) => ({ value: a.name, label: a.name, hint: trunc(`${a.model ? `${a.model} · ` : ""}${a.description ?? ""}`, Math.max(20, app.width - 40)) })),
        ],
      });
      if (!pick) return true;
      if (pick !== "__new") {
        const a = agents.find((x) => x.name === pick);
        info(`${a.name}${a.model ? ` (${a.model})` : ""}\n${a.description ?? ""}`);
        app.input.current?.set(`Use the ${a.name} agent to `);
        return true;
      }
      const dirs = agentDirs();
      const scope = await pickScope(app, "Where should the agent live?", dirs);
      if (!scope) return true;
      const desc = await ask("Describe the agent", "What should it do, and when should Claude use it?");
      if (!desc) return true;
      app.afterTurn(() => ctl.session.reload());
      app.runTurn(
        [
          `Create a new Claude Code subagent in ${dirs[scope].dir} (create the folder if needed). The user wants: ${desc}`,
          "Write exactly one Markdown file named <kebab-case-name>.md with YAML frontmatter:",
          "name (kebab-case), description (when Claude should delegate to it - specific; add \"Use proactively\" if it should run without being asked),",
          "tools (comma-separated, only if it should be restricted; omit to inherit all tools), model (sonnet, opus, haiku or inherit; omit for inherit).",
          "After the frontmatter write a focused system prompt: its role, how it works step by step, and what it reports back.",
          "Don't create other files. Finish with the file path.",
        ].join("\n"),
        `/agents create: ${desc}`,
      );
      return true;
    }

    case "skills": {
      const names = ctl.session.info?.skills;
      const cmds = app.commands().filter((c) => !c.local && !c.builtin);
      const skills = names ? cmds.filter((c) => names.includes(c.name)) : cmds;
      const pick = await openDialog({
        kind: "select",
        title: `Skills (${skills.length})`,
        subtitle: "Claude loads a skill when it fits the task, or type /<skill-name> to use one.",
        options: [
          { value: "__new", label: "Create a new skill…", hint: "describe it, Claude writes it" },
          { value: "__add", label: "Add a skill from a folder…", hint: "a folder with a SKILL.md" },
          ...skills.map((s) => ({ value: s.name, label: s.name, hint: trunc(s.desc ?? "", Math.max(20, app.width - 40)) })),
        ],
      });
      if (!pick) return true;
      if (pick !== "__new" && pick !== "__add") {
        app.input.current?.set(`/${pick} `);
        return true;
      }
      const dirs = skillDirs();
      if (pick === "__add") {
        const src = await ask("Add a skill", "Path to the skill folder (it must contain SKILL.md)");
        if (!src) return true;
        const from = path.resolve(src.replace(/^["']|["']$/g, ""));
        const skillMd = path.join(from, "SKILL.md");
        if (!fs.existsSync(skillMd)) return error(`No SKILL.md in ${from}`), true;
        const name = /^name:\s*["']?([\w.-]+)/m.exec(fs.readFileSync(skillMd, "utf8"))?.[1] ?? path.basename(from);
        const scope = await pickScope(app, `Install "${name}" where?`, dirs);
        if (!scope) return true;
        const dest = path.join(dirs[scope].dir, name);
        if (fs.existsSync(dest)) return error(`${dest} already exists`), true;
        fs.cpSync(from, dest, { recursive: true });
        await app.reloadSkills();
        info(`✓ Added skill "${name}" to ${dest}`);
        return true;
      }
      const scope = await pickScope(app, "Where should the skill live?", dirs);
      if (!scope) return true;
      const desc = await ask("Describe the skill", "What should it teach Claude to do, and when should it be used?");
      if (!desc) return true;
      app.afterTurn(() => app.reloadSkills());
      app.runTurn(
        [
          `Create a new Agent Skill in ${dirs[scope].dir}/<kebab-case-name>/SKILL.md. The user wants: ${desc}`,
          "If the skill-creator skill is available, follow it. Otherwise: YAML frontmatter with name (kebab-case) and description",
          "(what it does and exactly when to use it, so Claude can pick it automatically), then concise instructions.",
          "Put long reference material or scripts in extra files next to SKILL.md and point to them. Finish with the folder path.",
        ].join("\n"),
        `/skills create: ${desc}`,
      );
      return true;
    }

    case "mcp":
      await mcpCommand(app);
      return true;

    case "tasks": {
      const tasks = app.bgTasks();
      if (!tasks.length) {
        info("No background tasks. Claude can run commands and agents in the background, or press ctrl+b while one is running.");
        return true;
      }
      const id = await openDialog({
        kind: "select",
        title: `Background tasks (${tasks.length})`,
        options: tasks.map((t) => ({ value: t.task_id, label: trunc(t.description, 50), hint: t.subagent_type ?? t.task_type })),
      });
      if (!id) return true;
      const ok = await openDialog({ kind: "select", title: "Stop this task?", options: [{ value: "stop", label: "Stop it" }, { value: null, label: "Keep it running" }] });
      if (ok === "stop") {
        await q()?.stopTask(id).catch((e) => error(e?.message ?? String(e)));
        info("Stopping the task…");
      }
      return true;
    }

    case "emulator": {
      const devs = ctl.runHelper(["devices"]);
      const avds = ctl.runHelper(["avds"]);
      const headless = app.headless();
      info(
        [
          "Connected devices:",
          ...devs.split("\n").map((l) => `  ${l}`),
          "Emulators you can start:",
          ...avds.split("\n").map((l) => `  ${l}`),
          `Emulator window: ${headless ? "hidden (headless)" : "visible"}`,
        ].join("\n"),
      );
      const choice =
        arg === "headless" || arg === "hide"
          ? "hide"
          : arg === "window" || arg === "show"
            ? "show"
            : arg
              ? null
              : await openDialog({
                  kind: "select",
                  title: "Emulator window",
                  subtitle: "Claude sees and controls the emulator through screenshots and adb either way.",
                  current: headless ? "hide" : "show",
                  initial: headless ? 1 : 0,
                  options: [
                    { value: "show", label: "Show the emulator window", hint: "you can watch what Claude does" },
                    { value: "hide", label: "Hide the emulator window (headless)", hint: "runs invisibly, saves screen space and some memory" },
                  ],
                });
      if (!choice) return true;
      const h = choice === "hide";
      ctl.applyEmulatorPreference(h);
      app.setHeadless(h);
      app.reloadSession();
      info(`Emulator window: ${h ? "hidden. New emulators start headless (already-running ones keep their window)" : "visible"}`);
      return true;
    }

    case "allowed":
      info(
        [
          'These run without asking (edit "autoAllow" in ~/.myclaude/config.json to change):',
          ...app.startup.autoAllow.map((r) => `  ${r}`),
          ...(ctl.autoAllowAndroid ? ["  + any single adb / emulator / android helper call, by full path too (no ; | & or $ in it)"] : []),
          'Rules you add with "Yes, and don\'t ask again" are saved in .claude/settings.local.json.',
        ].join("\n"),
      );
      return true;

    case "status": {
      const u = await q()?.getContextUsage().catch(() => null);
      info(
        [
          `Model:    ${app.modelName(ctl.session.model)} (${ctl.session.model})`,
          `Effort:   ${app.effort()}`,
          `Mode:     ${MODE_INFO[ctl.session.mode]?.label ?? ctl.session.mode}`,
          `Session:  ${ctl.session.sessionId ?? "(not started)"}`,
          `Folder:   ${process.cwd()}`,
          `Auth:     ${ctl.session.info?.apiKeySource ?? "?"} (key …${app.startup.keyTail})`,
          u ? `Context:  ${kTokens(u.totalTokens)}/${kTokens(u.maxTokens)} tokens (${Math.round(u.percentage)}%)` : null,
          `Tasks:    ${plural(app.bgTasks().length, "background task")}`,
          `Cost:     $${ctl.session.cost.toFixed(4)} this session`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return true;
    }

    default:
      return false;
  }
}

// Plain-text version of the transcript for /export.
function transcriptText(items) {
  return items
    .map((it) => {
      switch (it.kind) {
        case "user": return `> ${it.text}`;
        case "assistant": return `● ${it.text}`;
        case "thinking": return it.text ? `∴ ${it.text}` : null;
        case "tool": {
          const s = toolSummary(it.name, it.input);
          const out = it.result === undefined ? [] : resultSummary(it.name, it.result, it.isError, it.input);
          return `● ${toolTitle(it.name, it.input)}${s ? `(${s})` : ""}${out.length ? `\n  ⎿  ${out.join("\n     ")}` : ""}`;
        }
        case "bash": return `! ${it.command}\n  ⎿  ${(it.output || "(No output)").split("\n").join("\n     ")}`;
        case "todos": return (it.todos ?? []).map((t) => `  ${t.status === "completed" ? "☒" : "☐"} ${t.content ?? t.subject ?? ""}`).join("\n");
        case "info": return it.text;
        case "error": return `✗ ${it.text}`;
        default: return null;
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

const RULE_HELP = "e.g. Bash(npm test:*) · Bash(git diff *) · Read(./secrets/**) · WebFetch(domain:github.com) · mcp__figma";

async function permissionsCommand(app) {
  const { openDialog, ask, push } = app;
  const rules = listRules();
  const icon = { allow: "✔", ask: "?", deny: "✗" };
  const pick = await openDialog({
    kind: "select",
    title: `Permission rules (${rules.length})`,
    subtitle: "deny beats ask beats allow. Same rules and files as Claude Code.",
    options: [
      { value: "__add", label: "Add a rule…" },
      ...rules.map((r, i) => ({ value: i, label: `${icon[r.kind]} ${r.kind.padEnd(5)} ${trunc(r.rule, 40)}`, hint: r.scope })),
    ],
  });
  if (pick == null) return;
  if (pick !== "__add") {
    const r = rules[pick];
    const yes = await openDialog({ kind: "select", title: `Remove "${r.rule}"?`, subtitle: `${r.kind} rule in ${SETTINGS[r.scope].file()}`, options: [{ value: "rm", label: "Remove it" }, { value: null, label: "Keep it" }] });
    if (yes !== "rm") return;
    removeRule(r.scope, r.kind, r.rule);
    app.reloadSession();
    return push({ kind: "info", text: `Removed ${r.kind} rule ${r.rule}` });
  }
  const kind = await openDialog({
    kind: "select",
    title: "What should the rule do?",
    options: [
      { value: "allow", label: "Allow", hint: "run without asking" },
      { value: "ask", label: "Ask", hint: "always ask, even in auto modes" },
      { value: "deny", label: "Deny", hint: "never allow" },
    ],
  });
  if (!kind) return;
  const rule = await ask(`New ${kind} rule`, RULE_HELP);
  if (!rule) return;
  if (!/^(mcp__[\w.-]+|[A-Z][\w]*(\(.+\))?)$/.test(rule)) return push({ kind: "error", text: `"${rule}" doesn't look like a rule. ${RULE_HELP}` });
  const scope = await openDialog({ kind: "select", title: "Save it where?", options: Object.entries(SETTINGS).map(([value, s]) => ({ value, label: s.label })) });
  if (!scope) return;
  addRule(scope, kind, rule);
  app.reloadSession();
  push({ kind: "info", text: `Added ${kind} rule ${rule} to ${SETTINGS[scope].file()}` });
}

async function mcpCommand(app) {
  const { ctl, push, openDialog, ask } = app;
  const q = ctl.session.q;
  const info = (t) => push({ kind: "info", text: t });
  let st = [];
  try {
    st = (await q?.mcpServerStatus()) ?? [];
  } catch {}
  const label = (s) => s.name.replace(/^plugin:([^:]+):.*$/, "$1");
  const icon = { connected: "✔ connected", "needs-auth": "⚠ needs sign-in", failed: "✗ failed", pending: "… connecting", disabled: "○ disabled" };
  const pick = await openDialog({
    kind: "select",
    title: "MCP servers",
    subtitle: st.length ? "Tools from these servers are available to Claude when connected." : "No MCP servers yet.",
    options: [
      { value: "__add", label: "Add a server…", hint: "local command or remote URL" },
      ...st.map((s) => ({ value: s.name, label: label(s), hint: `${icon[s.status] ?? s.status}${s.tools?.length ? ` · ${s.tools.length} tools` : ""}${s.scope ? ` · ${s.scope}` : ""}` })),
    ],
  });
  if (!pick) return;
  if (pick === "__add") return addMcpServer(app);

  const s = st.find((x) => x.name === pick);
  const owner = readServers("user")[s.name] ? "user" : readServers("project")[s.name] ? "project" : null;
  const action = await openDialog({
    kind: "select",
    title: label(s),
    subtitle: `Status: ${icon[s.status] ?? s.status}${s.error ? ` · ${trunc(s.error, 80)}` : ""}`,
    options: [
      ...(s.status === "needs-auth" ? [{ value: "auth", label: "How to sign in", hint: "one-time, uses your Claude Code login" }] : []),
      ...(s.tools?.length ? [{ value: "tools", label: `Show tools (${s.tools.length})` }] : []),
      { value: "reconnect", label: "Reconnect", hint: "after signing in, or if it failed" },
      s.status === "disabled" ? { value: "enable", label: "Enable" } : { value: "disable", label: "Disable for this session" },
      ...(owner ? [{ value: "remove", label: "Remove", hint: SCOPES[owner].file() }] : []),
    ],
  });
  try {
    if (action === "auth") {
      info(
        [
          `To sign in to ${label(s)} (one time):`,
          "  1. Open another terminal and run:  claude",
          `  2. Type /mcp, pick ${label(s)}, choose Authenticate and finish in the browser`,
          `  3. Come back here and run /mcp → ${label(s)} → Reconnect`,
          "The sign-in is saved by Claude Code and myclaude uses it too. It doesn't use your Claude usage.",
        ].join("\n"),
      );
    } else if (action === "tools") {
      info([`${label(s)} tools:`, ...s.tools.map((t) => `  ${t.name}${t.annotations?.readOnly ? " (read-only)" : ""}${t.description ? ` · ${trunc(t.description, 80)}` : ""}`)].join("\n"));
    } else if (action === "reconnect") {
      await q.reconnectMcpServer(s.name);
      const after = ((await q.mcpServerStatus()) ?? []).find((x) => x.name === s.name);
      info(`${label(s)}: ${icon[after?.status] ?? after?.status ?? "reconnecting"}`);
    } else if (action === "enable" || action === "disable") {
      await q.toggleMcpServer(s.name, action === "enable");
      info(`${label(s)} ${action}d`);
    } else if (action === "remove") {
      removeServer(owner, s.name);
      await applyMcp(app, owner);
      info(`Removed ${label(s)} from ${SCOPES[owner].file()}`);
    }
  } catch (e) {
    push({ kind: "error", text: `${label(s)}: ${e?.message ?? e}` });
  }
}

async function addMcpServer(app) {
  const { openDialog, ask, push } = app;
  const name = await ask("New MCP server", "Name (e.g. playwright, sentry)");
  if (!name) return;
  if (!/^[\w.-]+$/.test(name)) return push({ kind: "error", text: "Use letters, numbers, dots, dashes or underscores for the name." });
  const type = await openDialog({
    kind: "select",
    title: `${name}: how does it run?`,
    options: [
      { value: "stdio", label: "Local command (stdio)", hint: "e.g. npx @playwright/mcp@latest" },
      { value: "http", label: "Remote URL (HTTP)", hint: "e.g. https://mcp.example.com/mcp" },
      { value: "sse", label: "Remote URL (SSE)", hint: "older remote servers" },
    ],
  });
  if (!type) return;
  const target = await ask(name, type === "stdio" ? "Command to run, with its arguments" : "Server URL");
  if (!target) return;
  const scope = await openDialog({
    kind: "select",
    title: "Where should it be saved?",
    options: Object.entries(SCOPES).map(([value, s]) => ({ value, label: s.label })),
  });
  if (!scope) return;
  const config = serverConfig(type, target);
  const file = addServer(scope, name, config);
  try {
    await applyMcp(app, scope, name);
    push({ kind: "info", text: `✓ Added ${name} (${describeServer(config)}) to ${file}. It connects in a moment; check with /mcp.` });
  } catch (e) {
    push({ kind: "error", text: `Saved to ${file}, but connecting failed: ${e?.message ?? e}` });
  }
}

// Applies a change to myclaude's MCP files: user servers live (setMcpServers), project ones by
// approving them in .claude/settings.local.json and restarting the session on the same conversation.
async function applyMcp(app, scope, added) {
  const { ctl } = app;
  if (scope === "user") {
    ctl.session.base.mcpServers = readServers("user");
    const r = await ctl.session.q?.setMcpServers(ctl.session.base.mcpServers);
    const errs = Object.entries(r?.errors ?? {});
    if (errs.length) throw new Error(errs.map(([n, e]) => `${n}: ${e}`).join("; "));
    return;
  }
  if (added) {
    // Same approval Claude Code records when you accept a project server.
    const file = path.join(process.cwd(), ".claude", "settings.local.json");
    const local = readJson(file, {});
    local.enabledMcpjsonServers = [...new Set([...(local.enabledMcpjsonServers ?? []), added])];
    writeJson(file, local);
  }
  app.reloadSession();
}
