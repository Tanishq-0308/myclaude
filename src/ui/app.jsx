import React, { useState, useEffect, useRef, useReducer } from "react";
import { Box, Text, useInput, useApp, useWindowSize, useBoxMetrics } from "ink";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderMarkdown } from "../markdown.js";
import { readClipboardImage, readImageFile } from "../clipboard.js";
import { isAndroidCommand } from "../extras.js";
import { Rule, TextInput, Spinner, MOUSE_RE } from "./components.jsx";
import { Dialog } from "./dialogs.jsx";
import { Header, Item, AgentsRunning, TaskPanel, groupItems, historyItems } from "./transcript.jsx";
import { LOCAL_COMMANDS, runCommand } from "./commands.js";
import { makeCompleter } from "./complete.js";
import { loadKeymap, strokeOf } from "./keymap.js";
import { statusLineSetting, statusInput, runStatusLine } from "../statusline.js";
import { ORANGE, PERI, PINK, MODES, CYCLE, MODE_INFO, EFFORT_ICON } from "./theme.js";
import { trunc, plural, kTokens, toolTitle, toolSummary, isAgentTool, HIDDEN_TOOLS } from "./format.js";

const MAX_CONTEXT_CHARS = 30000;
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";
// Transcript items kept in memory, and how many are drawn at once (more load when you scroll to the top).
const MAX_ITEMS = 2000;
const WINDOW = 120;

function displayModel(models, value, initModel) {
  const m = models.find((x) => x.value === value);
  if (m) return (m.description ?? m.displayName).split(" · ")[0].replace(/^Use the default model \(currently (.+)\)$/, "$1");
  return initModel ?? (value ? value[0].toUpperCase() + value.slice(1) : "");
}

// Runs a `!command` the way the user's terminal would.
function runShell(command) {
  const [cmd, args] =
    process.platform === "win32" ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]] : [process.env.SHELL || "/bin/sh", ["-c", command]];
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const p = spawn(cmd, args, { cwd: process.cwd(), windowsHide: true });
    const timer = setTimeout(() => p.kill(), 120000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => (err += e.message));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, err, code: code ?? 1 });
    });
  });
}

const clip = (s) => (s.length > MAX_CONTEXT_CHARS ? `${s.slice(0, MAX_CONTEXT_CHARS)}\n… (output truncated)` : s);

// Dialogs that block Claude until the user answers.
const NEEDS_YOU = new Set(["permission", "question", "plan", "elicit"]);
const PASTE_RE = /\[Pasted text #(\d+) \+\d+ lines\]/g;
const OSC9_TERMINALS = new Set(["iTerm.app", "WezTerm", "ghostty"]);

// Terminal bell (flashes the taskbar / plays the bell sound), plus a desktop notification where the
// terminal supports OSC 9. Off with "notify": false in the config.
let notifyEnabled = true;
function notify(message) {
  if (!notifyEnabled) return;
  process.stdout.write(`${OSC9_TERMINALS.has(process.env.TERM_PROGRAM) ? `\x1b]9;${message}\x07` : ""}\x07`);
}

export function App({ ctl, startup }) {
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(40, columns || 100);
  const height = Math.max(10, rows || 30);
  const inner = width - 2;

  const [items, setItems] = useState([]);
  const [live, setLive] = useState("");
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [since, setSince] = useState(Date.now());
  const [label, setLabel] = useState("Working");
  const [tokens, setTokens] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [mode, setModeState] = useState(ctl.session.mode);
  const [model, setModelState] = useState(ctl.session.model);
  const [effort, setEffortState] = useState(ctl.session.effort ?? startup.defaultEffort);
  const [models, setModels] = useState([]);
  const [initModel, setInitModel] = useState(null);
  const [cost, setCost] = useState(0);
  const [ctxPct, setCtxPct] = useState(null);
  const [queued, setQueued] = useState([]);
  const [exitHint, setExitHint] = useState(false);
  const [slashCommands, setSlashCommands] = useState(LOCAL_COMMANDS.map((c) => ({ ...c, local: true })));
  const [suggestions, setSuggestions] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [inputMode, setInputMode] = useState("prompt");
  const [follow, setFollow] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [verbose, setVerbose] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [headless, setHeadless] = useState(!!startup.headless);
  const [todos, setTodos] = useState([]);
  const [showTodos, setShowTodos] = useState(true);
  const [vimOn, setVimOn] = useState(!!startup.vim);
  const [vimMode, setVimMode] = useState("insert");
  const [statusText, setStatusText] = useState(null);
  const [statusTick, setStatusTick] = useState(0);
  const keymap = useRef(null);
  keymap.current ??= loadKeymap();
  const statusSetting = useRef(undefined);
  if (statusSetting.current === undefined) statusSetting.current = statusLineSetting();
  const [bgTasks, setBgTasks] = useState([]);
  const [, bump] = useReducer((x) => x + 1, 0);

  const viewRef = useRef(null);
  const contentRef = useRef(null);
  const view = useBoxMetrics(viewRef);
  const content = useBoxMetrics(contentRef);
  const maxScroll = Math.max(0, content.height - view.height);
  const offset = follow ? maxScroll : Math.min(scrollTop, maxScroll);

  const idRef = useRef(1);
  const liveRef = useRef("");
  const liveTimer = useRef(null);
  const pendingRef = useRef(new Map());
  const agentsRef = useRef(new Map());
  const skipRef = useRef(new Map());
  const queueRef = useRef([]);
  const busyRef = useRef(false);
  const dialogRef = useRef(null);
  const lastCtrlC = useRef(0);
  const lastEsc = useRef(0);
  const history = useRef(Array.isArray(startup.history) ? startup.history : []);
  const imagesRef = useRef(new Map());
  const nextImageId = useRef(1);
  const pastesRef = useRef(new Map());
  notifyEnabled = startup.notify !== false;
  const mcpNoticeShown = useRef(false);
  const afterTurnRef = useRef([]);
  const reloadPending = useRef(false);
  const shellContext = useRef([]);
  const inputApi = useRef(null);
  // Latest values for async command handlers that outlive a render.
  const latest = useRef({});
  latest.current = { models, initModel, effort, bgTasks, slashCommands, headless, vimOn, items };

  const push = (...its) => {
    const first = idRef.current;
    setItems((prev) => [...prev, ...its.map((i) => ({ ...i, id: idRef.current++ }))].slice(-MAX_ITEMS));
    return first;
  };
  const flushLive = () => {
    clearTimeout(liveTimer.current);
    liveTimer.current = null;
    if (liveRef.current.trim()) push({ kind: "assistant", text: liveRef.current });
    liveRef.current = "";
    setLive("");
  };
  const syncPending = () => setPending([...pendingRef.current.values()]);

  // ---------- scrolling ----------
  const [windowSize, setWindowSize] = useState(WINDOW);
  const growFrom = useRef(null);
  const hiddenRef = useRef(0);
  const display = verbose ? items : groupItems(items);
  const hidden = Math.max(0, display.length - windowSize);
  hiddenRef.current = hidden;
  const scrollState = useRef({ offset: 0, max: 0 });
  scrollState.current = { offset, max: maxScroll };
  const scrollBy = (delta) => {
    const { offset: cur, max } = scrollState.current;
    const next = Math.max(0, Math.min(max, cur + delta));    scrollState.current.offset = next;
    setScrollTop(next);
    setFollow(next >= max);
    // At the top with older items not drawn: draw more, and keep the view where it was (see below).
    if (delta < 0 && next === 0 && hiddenRef.current > 0 && growFrom.current == null) {
      growFrom.current = content.height;
      setWindowSize((w) => w + WINDOW);
    }
  };
  // Older items were added above the view: shift the scroll position by their height.
  useEffect(() => {
    if (growFrom.current == null || content.height === growFrom.current) return;
    const grown = content.height - growFrom.current;
    growFrom.current = null;
    setScrollTop((t) => t + grown);
  }, [content.height]);
  const scrollByRef = useRef(scrollBy);
  scrollByRef.current = scrollBy;
  useEffect(() => {
    if (!ctl.mouse) return;
    const onMouse = (m) => {
      if (m.release || !(m.button & 64)) return;
      scrollByRef.current(m.button & 1 ? 3 : -3);
    };
    ctl.mouse.on("mouse", onMouse);
    return () => ctl.mouse.off("mouse", onMouse);
  }, []);

  // ---------- helpers used by commands ----------
  const changeMode = async (m, announce = false) => {
    setModeState(m);
    await ctl.session.setMode(m);
    ctl.onModeChosen?.(m);
    if (announce) push({ kind: "info", text: `Permission mode: ${MODE_INFO[m].label}` });
  };

  const openDialog = (d) =>
    new Promise((res) => {
      const token = {};
      const done = (v) => {
        if (dialogRef.current === token) {
          dialogRef.current = null;
          setDialog(null);
        }
        res(v);
      };
      dialogRef.current = token;
      d.opts?.signal?.addEventListener("abort", () => done(d.abortValue ?? { behavior: "deny", message: "Cancelled" }), { once: true });
      if (NEEDS_YOU.has(d.kind)) notify("Claude needs your input");
      setDialog({ ...d, resolve: done });
    });
  const ask = (title, placeholder) => openDialog({ kind: "input", title, placeholder });

  const modeDialog = (title) => ({
    kind: "select",
    title,
    subtitle: "You can change this any time with shift+tab or /mode.",
    initial: Math.max(0, MODES.indexOf(ctl.session.mode)),
    current: ctl.session.mode,
    options: MODES.map((m) => ({ value: m, label: MODE_INFO[m].label, hint: MODE_INFO[m].desc })),
  });

  const refreshCommands = async (list) => {
    const cmds = list ?? (await ctl.session.q?.supportedCommands().catch(() => null));
    if (!cmds) return;
    const local = new Set(LOCAL_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    setSlashCommands([
      ...LOCAL_COMMANDS.map((c) => ({ ...c, local: true })),
      ...cmds
        .filter((c) => !local.has(c.name))
        .map((c) => ({ name: c.name, desc: c.description, argumentHint: c.argumentHint, aliases: c.aliases, builtin: c.builtin })),
    ]);
  };

  const refreshContext = () =>
    ctl.session.q
      ?.getContextUsage()
      .then((u) => setCtxPct(Math.round(u.percentage)))
      .catch(() => {});

  const loadInit = async () => {
    const init = await ctl.session.init();
    if (!init) return;
    if (init.models?.length) setModels(init.models);
    await refreshCommands(init.commands);
  };

  // Changes that need a fresh CLI process wait until Claude is idle.
  const reloadSession = () => {
    if (busyRef.current) reloadPending.current = true;
    else ctl.session.reload();
  };

  const resetView = () => {
    pendingRef.current.clear();
    agentsRef.current.clear();
    syncPending();
    setItems([]);
    setTodos([]);
    setCost(0);
    setCtxPct(null);
    setGhost(null);
  };

  const newConversation = () => {
    ctl.session.close();
    Object.assign(ctl.session, { sessionId: null, cost: 0, turns: [], lastChainUuid: null });
    resetView();
    ctl.session.start();
  };

  const pickResume = async () => {
    const sessions = await startup.listSessions();
    if (!sessions.length) {
      push({ kind: "info", text: "No earlier conversations in this folder." });
      return null;
    }
    return openDialog({
      kind: "select",
      title: "Resume a conversation",
      options: sessions.map((s) => ({ value: s.sessionId, label: trunc(s.summary, Math.max(20, width - 50)), hint: new Date(s.lastModified).toLocaleString() })),
    });
  };

  // Shows the saved messages of a conversation being resumed.
  const showHistory = async (id) => {
    try {
      const [msgs, info] = await Promise.all([startup.getSessionMessages(id), startup.getSessionInfo(id).catch(() => null)]);
      const title = info?.customTitle || info?.summary;
      ctl.session.lastChainUuid = msgs.filter((m) => !m.parent_tool_use_id && m.uuid).at(-1)?.uuid ?? null;
      push(
        { kind: "info", text: `↺ Resumed${title ? ` "${trunc(title, 80)}"` : ""}${info?.lastModified ? ` · last active ${new Date(info.lastModified).toLocaleString()}` : ""}` },
        ...historyItems(msgs),
        { kind: "divider" },
      );
      setFollow(true);
    } catch (e) {
      push({ kind: "error", text: `Couldn't load the earlier messages: ${e?.message ?? e}` });
    }
  };

  const resume = async (id) => {
    Object.assign(ctl.session, { cost: 0, turns: [] });
    ctl.session.restart({ resume: id });
    ctl.session.sessionId = id;
    resetView();
    await showHistory(id);
  };

  const rewind = async () => {
    if (busyRef.current) return push({ kind: "info", text: "Press esc to stop Claude first, then rewind." });
    const turns = [...ctl.session.turns].reverse();
    if (!turns.length) return push({ kind: "info", text: "Nothing to rewind yet in this session." });
    const i = await openDialog({
      kind: "select",
      title: "Rewind",
      subtitle: "Go back to before one of your messages.",
      options: turns.map((t, i) => ({ value: i, label: trunc(t.text || "(image)", Math.max(20, width - 30)), hint: new Date(t.at).toLocaleTimeString() })),
    });
    if (i == null) return;
    const turn = turns[i];
    const preview = await ctl.session.previewRewind(turn);
    const n = preview?.canRewind ? (preview.filesChanged?.length ?? 0) : 0;
    const change = n ? `${plural(n, "file")} · +${preview.insertions ?? 0} -${preview.deletions ?? 0}` : "";
    const action = await openDialog({
      kind: "select",
      title: "Restore what?",
      subtitle: n ? `Code changes since then: ${change}` : "No file changes to undo since then.",
      options: [
        ...(n ? [{ value: "both", label: "Restore code and conversation" }] : []),
        { value: "conversation", label: "Restore conversation", hint: "files stay as they are" },
        ...(n ? [{ value: "code", label: "Restore code", hint: "keep the conversation" }] : []),
        { value: null, label: "Never mind" },
      ],
    });
    if (!action) return;
    try {
      await ctl.session.rewind(turn, { code: action !== "conversation", conversation: action !== "code" });
      if (action !== "code") {
        setItems((prev) => (turn.itemId ? prev.filter((it) => it.id < turn.itemId) : []));
        setTodos([]);
        inputApi.current?.set(turn.text);
      }
      push({ kind: "info", text: `↺ Rewound ${action === "both" ? `code (${change}) and conversation` : action === "code" ? `code (${change})` : "conversation"}` });
    } catch (e) {
      push({ kind: "error", text: `Rewind failed: ${e?.message ?? e}` });
    }
  };

  const setEffort = async (e) => {
    setEffortState(e);
    await ctl.session.setEffort(e);
  };

  // ---------- images ----------
  const addImage = (img) => {
    const id = nextImageId.current++;
    imagesRef.current.set(id, img);
    return `[Image #${id}]`;
  };
  const pasteImage = async () => {
    setPasting(true);
    const img = await readClipboardImage();
    setPasting(false);
    if (!img) return push({ kind: "info", text: "No image on the clipboard. Copy a screenshot first (Win+Shift+S or PrtSc), then press Alt+V." }), null;
    if (img.error) return push({ kind: "error", text: `Couldn't paste the image: ${img.error}` }), null;
    return addImage(img);
  };
  const attachImageFile = async (file) => {
    setPasting(true);
    const img = await readImageFile(file);
    setPasting(false);
    if (img?.error || !img) return push({ kind: "error", text: `Couldn't attach ${file}: ${img?.error ?? "unknown error"}` }), null;
    return addImage(img);
  };

  // Big pastes show as "[Pasted text #n +k lines]" in the input and are expanded when sent.
  const collapsePaste = (t) => {
    const n = t.split("\n").length;
    if (t.length < 800 && n <= 10) return null;
    const id = pastesRef.current.size + 1;
    pastesRef.current.set(id, t);
    return `[Pasted text #${id} +${n} lines]`;
  };

  // Expands pasted text, turns "[Image #n]" placeholders into image blocks, and prepends output of `!` commands.
  const buildContent = (raw) => {
    const text = raw.replace(PASTE_RE, (m, id) => pastesRef.current.get(Number(id)) ?? m);
    const blocks = [];
    const seen = new Set();
    for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
      const img = imagesRef.current.get(Number(m[1]));
      if (img && !seen.has(m[1])) {
        seen.add(m[1]);
        blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
      }
    }
    const shell = shellContext.current.splice(0);
    if (shell.length) blocks.push({ type: "text", text: shell.join("\n") });
    return blocks.length ? [...blocks, { type: "text", text }] : text;
  };

  // ---------- turns ----------
  const runTurn = async (text, display = text) => {
    const itemId = push({ kind: "user", text: display });
    setFollow(true);
    busyRef.current = true;
    setBusy(true);
    setSince(Date.now());
    setLabel("Working");
    setTokens(0);
    setGhost(null);
    setTodos((t) => (t.length && t.every((x) => x.status === "completed") ? [] : t));
    setWindowSize(WINDOW);
    const started = Date.now();
    const done = ctl.session.send(buildContent(text), display);
    const turn = ctl.session.turns.at(-1);
    if (turn) turn.itemId = itemId;
    await done;
    busyRef.current = false;
    setBusy(false);
    if (Date.now() - started > 15000 && !queueRef.current.length) notify("Claude is done");
    for (const fn of afterTurnRef.current.splice(0)) {
      try {
        await fn();
      } catch (e) {
        push({ kind: "error", text: e?.message ?? String(e) });
      }
    }
    if (reloadPending.current) {
      reloadPending.current = false;
      ctl.session.reload();
    }
    if (queueRef.current.length) {
      const next = queueRef.current.splice(0).join("\n");
      setQueued([]);
      runTurn(next);
    }
  };

  // ctrl+g: edit the prompt in $VISUAL / $EDITOR (Notepad on Windows). Ink hands the terminal over
  // while the editor runs and repaints afterwards.
  const editInEditor = async () => {
    const file = path.join(os.tmpdir(), `myclaude-prompt-${process.pid}.md`);
    fs.writeFileSync(file, inputApi.current?.get() ?? "");
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
    let failed = null;
    await suspendTerminal(async () => {
      process.stdout.write(MOUSE_OFF);
      process.stdin.pause();
      const code = await new Promise((resolve) => {
        const p = spawn(`${editor} "${file}"`, { shell: true, stdio: "inherit" });
        p.on("error", (e) => resolve(e.message));
        p.on("close", resolve);
      });
      process.stdin.resume();
      process.stdout.write(MOUSE_ON);
      if (code !== 0) failed = `${editor} exited with ${code}`;
    });
    const text = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    fs.rmSync(file, { force: true });
    if (failed) push({ kind: "error", text: failed });
    else inputApi.current?.set(text);
  };

  const runBash = async (command) => {
    setBashRunning(true);
    setSince(Date.now());
    const r = await runShell(command);
    setBashRunning(false);
    const output = [r.out.trimEnd(), r.err.trimEnd()].filter(Boolean).join("\n");
    push({ kind: "bash", command, output, code: r.code });
    shellContext.current.push(
      `<bash-input>${command}</bash-input>\n<bash-stdout>${clip(r.out.trimEnd())}</bash-stdout>\n<bash-stderr>${clip(r.err.trimEnd())}</bash-stderr>`,
    );
  };

  const app = {
    ctl, startup, width, push, openDialog, ask, changeMode, modeDialog, pickResume, resume, rewind, newConversation,
    runTurn, reloadSession, input: inputApi,
    exit: () => {
      ctl.exiting = true;
      exit();
    },
    afterTurn: (fn) => afterTurnRef.current.push(fn),
    effort: () => latest.current.effort,
    setEffort,
    setModel: setModelState,
    modelName: (v) => displayModel(latest.current.models, v, latest.current.initModel),
    loadModels: async () => {
      const list = latest.current.models.length ? latest.current.models : await ctl.session.models().catch(() => []);
      if (list.length) setModels(list);
      return list;
    },
    commands: () => latest.current.slashCommands,
    items: () => latest.current.items,
    toggleVim: () => {
      const on = !latest.current.vimOn;
      setVimOn(on);
      setVimMode("insert");
      ctl.onVimToggled?.(on);
      return on;
    },
    bgTasks: () => latest.current.bgTasks,
    headless: () => latest.current.headless,
    setHeadless,
    reloadSkills: async () => {
      const r = await ctl.session.q?.reloadSkills();
      await refreshCommands();
      return r;
    },
  };

  const submit = async (text) => {
    ctl.saveHistory?.(history.current);
    const t = text.trim();
    if (t.startsWith("!") && t.length > 1) return runBash(t.slice(1).trim());
    if (t.startsWith("/") && (await runCommand(app, t))) return;
    if (busyRef.current) {
      queueRef.current.push(text);
      setQueued([...queueRef.current]);
      return;
    }
    runTurn(text);
  };

  // ---------- SDK events ----------
  const onTool = (e) => {
    if (e.parent) {
      const a = agentsRef.current.get(e.parent);
      if (!a) return;
      a.count++;
      a.last = `${toolTitle(e.name, e.input)}(${trunc(toolSummary(e.name, e.input), 60)})`;
      a.tools.push(a.last);
      if (a.tools.length > 200) a.tools.shift();
      return bump();
    }
    if (HIDDEN_TOOLS.has(e.name)) {
      skipRef.current.set(e.id, e);
      if (e.name === "TodoWrite") setTodos((e.input.todos ?? []).map((t, i) => ({ id: String(i), ...t })));
      if (e.name === "TaskUpdate") {
        setTodos((list) =>
          e.input.status === "deleted"
            ? list.filter((t) => t.id !== String(e.input.taskId))
            : list.map((t) => (t.id === String(e.input.taskId) ? { ...t, ...(e.input.status ? { status: e.input.status } : {}), ...(e.input.subject ? { content: e.input.subject } : {}), ...(e.input.activeForm ? { activeForm: e.input.activeForm } : {}) } : t)),
        );
      }
      return;
    }
    if (isAgentTool(e.name)) {
      agentsRef.current.set(e.id, { id: e.id, name: e.name, input: e.input, count: 0, tokens: 0, tools: [], last: "", summary: "", start: Date.now() });
      return bump();
    }
    pendingRef.current.set(e.id, { id: e.id, name: e.name, input: e.input });
    syncPending();
  };

  const onToolResult = (e) => {
    if (e.parent) return;
    const hidden = skipRef.current.get(e.id);
    if (hidden) {
      skipRef.current.delete(e.id);
      const taskId = hidden.name === "TaskCreate" && !e.isError ? /#?(\d+)/.exec(e.text)?.[1] : null;
      if (taskId) setTodos((list) => [...list, { id: taskId, content: hidden.input.subject, activeForm: hidden.input.activeForm, status: "pending" }]);
      return;
    }
    const a = agentsRef.current.get(e.id);
    if (a) {
      agentsRef.current.delete(e.id);
      push({ kind: "tool", name: a.name, input: a.input, result: e.text, isError: e.isError, agent: { count: a.count, tokens: a.tokens, tools: a.tools, ms: Date.now() - a.start } });
      return;
    }
    const t = pendingRef.current.get(e.id);
    pendingRef.current.delete(e.id);
    syncPending();
    push({ kind: "tool", name: t?.name ?? e.name ?? "Tool", input: t?.input ?? {}, result: e.text, isError: e.isError });
  };

  const onTask = (m) => {
    const a = m.tool_use_id ? agentsRef.current.get(m.tool_use_id) : null;
    if (m.subtype === "task_progress" && a) {
      a.tokens = m.usage?.total_tokens ?? a.tokens;
      a.count = Math.max(a.count, m.usage?.tool_uses ?? 0);
      if (m.summary) a.summary = m.summary;
      return bump();
    }
    if (m.subtype === "task_notification" && !a && !m.skip_transcript) {
      const desc = latest.current.bgTasks.find((t) => t.task_id === m.task_id)?.description ?? "Background task";
      const icon = m.status === "completed" ? "✔" : m.status === "failed" ? "✗" : "■";
      const stats = m.usage ? ` · ${plural(m.usage.tool_uses, "tool use")} · ${kTokens(m.usage.total_tokens)} tokens` : "";
      push({ kind: "info", text: `${icon} ${desc} ${m.status}${stats}${m.summary ? `\n  ⎿  ${trunc(m.summary, 300)}` : ""}` });
    }
  };

  useEffect(() => {
    ctl.request = openDialog;
    ctl.session.emit = (e) => {
      switch (e.type) {
        case "init": {
          setInitModel(e.info.model);
          if (e.info.apiKeySource !== "ANTHROPIC_API_KEY") {
            push({ kind: "error", text: `Auth source is "${e.info.apiKeySource}", not your API key. Run: myclaude login` });
          }
          if (!latest.current.models.length) ctl.session.models().then(setModels).catch(() => {});
          if (!mcpNoticeShown.current) {
            mcpNoticeShown.current = true;
            setTimeout(async () => {
              try {
                const st = await ctl.session.q?.mcpServerStatus();
                const needs = (st ?? []).filter((s) => s.status === "needs-auth").map((s) => s.name.replace(/^plugin:[^:]+:/, ""));
                if (needs.length) push({ kind: "info", text: `${needs.join(", ")} need${needs.length === 1 ? "s" : ""} a one-time sign-in to be used · type /mcp for how` });
              } catch {}
            }, 6000);
          }
          break;
        }
        case "status":
          setLabel(e.label);
          break;
        case "tokens":
          setTokens(e.tokens);
          break;
        case "text_delta":
          liveRef.current += e.text;
          // Re-rendering markdown on every chunk gets slow on long answers; repaint at most every 50ms.
          if (!liveTimer.current) {
            liveTimer.current = setTimeout(() => {
              liveTimer.current = null;
              setLive(liveRef.current);
            }, 50);
          }
          break;
        case "text_done":
          flushLive();
          break;
        case "text":
          push({ kind: "assistant", text: e.text });
          break;
        case "thinking":
          if (e.text.trim() || e.ms > 1000) {
            flushLive();
            push({ kind: "thinking", text: e.text.trim(), ms: e.ms });
          }
          break;
        case "tool_use":
          onTool(e);
          break;
        case "tool_result":
          onToolResult(e);
          break;
        case "tool_progress": {
          const t = !e.parent && pendingRef.current.get(e.id);
          if (t) {
            t.secs = e.secs;
            syncPending();
          }
          break;
        }
        case "task":
          onTask(e.m);
          break;
        case "bg_tasks":
          setBgTasks(e.tasks.filter((t) => !t.ambient));
          break;
        case "state":
          setAutoBusy(e.state === "running");
          break;
        case "commands":
          refreshCommands(e.commands);
          break;
        case "suggestion":
          if (!busyRef.current) setGhost(e.text);
          break;
        case "error":
          flushLive();
          push({ kind: "error", text: e.text });
          break;
        case "info":
          push({ kind: "info", text: e.text });
          break;
        case "mode":
          setModeState(e.mode);
          break;
        case "result": {
          flushLive();
          const left = [...pendingRef.current.values()];
          pendingRef.current.clear();
          syncPending();
          if (left.length) push(...left.map((t) => ({ kind: "tool", name: t.name, input: t.input })));
          agentsRef.current.clear();
          setCost(e.cost);
          push({ kind: "done", secs: e.durationMs / 1000, cost: e.cost });
          refreshContext();
          break;
        }
      }
    };

    (async () => {
      let extra = startup.startExtra;
      if (startup.pickResume) {
        const id = await pickResume();
        if (id) extra = { resume: id };
      }
      if (extra.continue) {
        const latestSession = (await startup.listSessions().catch(() => []))[0];
        extra = latestSession ? { resume: latestSession.sessionId } : {};
        if (!latestSession) push({ kind: "info", text: "No earlier conversation in this folder. Starting a new one." });
      }
      if (extra.resume) await showHistory(extra.resume);
      if (startup.askMode) {
        const m = await openDialog(modeDialog("How should Claude work in this session?"));
        if (m) {
          setModeState(m);
          ctl.session.mode = m;
          ctl.onModeChosen?.(m);
        }
      }
      ctl.session.start(extra);
      if (extra.resume) ctl.session.sessionId = extra.resume;
      loadInit();
      if (startup.prompt) submit(startup.prompt);
    })();
  }, []);

  // Status line from Claude Code settings: re-run (debounced) when what it shows may have changed.
  useEffect(() => {
    const s = statusSetting.current;
    if (!s?.refreshInterval) return;
    const t = setInterval(() => setStatusTick((x) => x + 1), Math.max(1, s.refreshInterval) * 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const s = statusSetting.current;
    if (!s) return;
    const t = setTimeout(async () => {
      const out = await runStatusLine(
        s,
        statusInput({
          sessionId: ctl.session.sessionId, model: ctl.session.info?.model ?? model, modelName: displayModel(models, model, initModel),
          cost, contextPct: ctxPct, vimMode: vimOn ? vimMode : null, version: startup.version, outputStyle: ctl.session.info?.output_style,
        }),
      );
      setStatusText(out);
    }, 300);
    return () => clearTimeout(t);
  }, [model, mode, cost, ctxPct, vimOn, vimMode, initModel, busy, statusTick]);

  const cycleMode = () => changeMode(CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]);

  useInput((input, key) => {
    let wheel = 0;
    for (const m of input.matchAll(MOUSE_RE)) {
      const b = Number(m[1]);
      if (m[4] === "M" && b & 64) wheel += b & 1 ? 3 : -3;
    }
    if (wheel) return scrollBy(wheel);
    if (MOUSE_RE.test(input)) return void (MOUSE_RE.lastIndex = 0);
    MOUSE_RE.lastIndex = 0;
    if (key.pageUp) return scrollBy(-Math.max(3, Math.floor(view.height / 2)));
    if (key.pageDown) return scrollBy(Math.max(3, Math.floor(view.height / 2)));
    // The input box already used this key (history search, vim escape, closing completions).
    if (inputApi.current?.consumed) {
      inputApi.current.consumed = false;
      return;
    }
    const contexts = dialog ? ["Global"] : ["Global", "Chat", ...(busyRef.current ? ["Task"] : [])];
    const stroke = strokeOf(input, key);
    const chord = keymap.current.chord(contexts, stroke);
    if (chord?.pending) return;
    switch (chord?.action ?? keymap.current.action(contexts, stroke)) {
      case "app:toggleTranscript":
        return setVerbose((v) => !v);
      case "app:toggleTodos":
        return setShowTodos((v) => !v);
      case "history:search":
        return void (!dialog && inputApi.current?.startSearch());
      case "app:exit":
        return void (!dialog && !inputApi.current?.get() && app.exit());
      case "chat:externalEditor":
        return void (!dialog && editInEditor());
      case "chat:modelPicker":
        return void (!dialog && runCommand(app, "/model"));
      case "chat:killAgents": {
        const tasks = latest.current.bgTasks;
        for (const t of tasks) ctl.session.q?.stopTask(t.task_id).catch(() => {});
        return push({ kind: "info", text: tasks.length ? `Stopping ${plural(tasks.length, "background task")}…` : "No background tasks running." });
      }
      case "task:background":
        ctl.session.q
          ?.backgroundTasks()
          .then(() => push({ kind: "info", text: "Moved running work to the background · /tasks to see it" }))
          .catch((e) => push({ kind: "error", text: e?.message ?? String(e) }));
        return;
    }
    if (dialog) return;
    if (key.ctrl && input === "c") {
      if (busyRef.current) {
        ctl.session.interrupt();
        push({ kind: "error", text: "Interrupted by user" });
        return;
      }
      const now = Date.now();
      if (now - lastCtrlC.current < 2000) return app.exit();
      lastCtrlC.current = now;
      setExitHint(true);
      setTimeout(() => setExitHint(false), 2000);
      return;
    }
    if (key.escape) {
      if (busyRef.current) {
        ctl.session.interrupt();
        push({ kind: "error", text: "Interrupted by user" });
        return;
      }
      const now = Date.now();
      if (now - lastEsc.current < 600 && !inputApi.current?.get()) {
        lastEsc.current = 0;
        rewind();
      } else lastEsc.current = now;
    }
  });

  const modeInfo = MODE_INFO[mode] ?? MODE_INFO.default;
  const activeTodo = todos.find((t) => t.status === "in_progress");
  const spinning = (busy || autoBusy || bashRunning) && !dialog;
  const agents = [...agentsRef.current.values()];
  const footerRight = [
    !showTodos && todos.length ? "tasks hidden · ctrl+t" : null,
    bgTasks.length ? `${bgTasks.length} background · /tasks` : null,
    verbose ? "expanded · ctrl+o to collapse" : null,
    headless ? "emulator: headless" : null,
    ctxPct != null ? `ctx ${ctxPct}%` : null,
    `$${cost.toFixed(4)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box ref={viewRef} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" contentOffsetY={offset}>
        <Box ref={contentRef} flexDirection="column" flexShrink={0} paddingX={1} paddingTop={1}>
          <Header modelName={displayModel(models, model, initModel)} cwd={process.cwd()} version={startup.version} />
          {hidden ? <Text dimColor>{`↑ ${hidden} earlier item${hidden === 1 ? "" : "s"} · scroll up to show`}</Text> : null}
          {display.slice(hidden).map((item) => (
            <Item key={item.id} item={item} width={inner} verbose={verbose} />
          ))}
          {live ? (
            <Box marginTop={1}>
              <Text>{"● "}</Text>
              <Box width={inner - 2}>
                <Text>{renderMarkdown(live, inner - 4)}</Text>
              </Box>
            </Box>
          ) : null}
          <AgentsRunning agents={agents} width={inner} verbose={verbose} />
          {pending.map((t) => (
            <Box key={t.id} flexDirection="column" marginTop={1}>
              <Text>
                <Text dimColor>{"● "}</Text>
                <Text bold>{toolTitle(t.name, t.input)}</Text>
                {toolSummary(t.name, t.input) ? <Text dimColor>{`(${toolSummary(t.name, t.input)})`}</Text> : null}
              </Text>
              {!dialog ? <Text dimColor>{`  ⎿  Running…${t.secs ? ` (${Math.round(t.secs)}s · ctrl+b to run in background)` : ""}`}</Text> : null}
            </Box>
          ))}
          {queued.map((q, i) => (
            <Box key={i} marginTop={1}>
              <Text dimColor>{`❯ ${q}  (queued)`}</Text>
            </Box>
          ))}
          <Text> </Text>
        </Box>
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {!follow && offset < maxScroll ? (
          <Box justifyContent="center">
            <Text color="cyan">↓ more below · PgDn to scroll</Text>
          </Box>
        ) : null}
        {spinning ? <Spinner label={bashRunning ? "Running command" : (activeTodo?.activeForm ?? label)} since={since} tokens={busy ? tokens : 0} /> : null}
        {!dialog && showTodos ? <TaskPanel todos={todos} /> : null}
        {spinning || (showTodos && todos.length) ? <Text> </Text> : null}

        {dialog ? (
          <Dialog
            d={dialog}
            width={width}
            onModeChange={(m) => {
              setModeState(m);
              ctl.session.mode = m;
            }}
          />
        ) : (
          <>
            <Box justifyContent="flex-end" paddingRight={2}>
              <Text dimColor>
                <Text color={ORANGE}>{EFFORT_ICON[effort] ?? "◐"}</Text>
                {` ${effort} · /effort`}
              </Text>
            </Box>
            <Rule width={width} color={inputMode === "bash" ? PINK : "gray"} />
            <Box>
              <Text color={inputMode === "bash" ? PINK : undefined}>{inputMode === "bash" ? "! " : "❯ "}</Text>
              <Box flexGrow={1}>
                <TextInput
                  active={!dialog}
                  api={inputApi}
                  ghost={!busy && ghost ? ghost : null}
                  placeholder={busy ? "Type a message to queue it…" : 'Try "check if my tablet is connected with adb"'}
                  onSubmit={submit}
                  onShiftTab={cycleMode}
                  onChange={(v) => {
                    const m = v.startsWith("!") ? "bash" : "prompt";
                    if (m !== inputMode) setInputMode(m);
                    if (v && ghost) setGhost(null);
                  }}
                  history={history.current}
                  keymap={keymap.current}
                  vim={vimOn}
                  onVimMode={setVimMode}
                  complete={makeCompleter(() => slashCommands)}
                  onPasteImage={pasteImage}
                  onImagePath={attachImageFile}
                  onPasteText={collapsePaste}
                  onSuggestions={(s) => {
                    if (JSON.stringify(s) !== JSON.stringify(suggestions)) setSuggestions(s);
                  }}
                />
              </Box>
            </Box>
            <Rule width={width} color={inputMode === "bash" ? PINK : "gray"} />
            {statusText && !suggestions ? (
              <Box paddingLeft={2 + (statusSetting.current?.padding ?? 0)}>
                <Text>{statusText}</Text>
              </Box>
            ) : null}
            {suggestions ? (
              <Box flexDirection="column" paddingLeft={2}>
                {suggestions.items.map((c, i) => (
                  <Text key={c.label} color={i === suggestions.sel ? PERI : undefined} dimColor={i !== suggestions.sel}>
                    {c.desc ? `${c.label.padEnd(24)} ${trunc(c.desc, Math.max(10, width - 32))}` : c.label}
                  </Text>
                ))}
              </Box>
            ) : (
              <Box paddingLeft={2} paddingRight={2} justifyContent="space-between">
                {exitHint ? (
                  <Text color="yellow">Press Ctrl+C again to exit</Text>
                ) : pasting ? (
                  <Text color="cyan">Pasting image…</Text>
                ) : vimOn && !statusSetting.current?.hideVimModeIndicator && vimMode === "insert" ? (
                  <Text dimColor>-- INSERT --</Text>
                ) : vimOn && !statusSetting.current?.hideVimModeIndicator && vimMode === "normal" ? (
                  <Text dimColor>-- NORMAL --</Text>
                ) : inputMode === "bash" ? (
                  <Text color={PINK}>! bash mode · output goes to Claude with your next message</Text>
                ) : modeInfo.footer ? (
                  <Text>
                    <Text color={modeInfo.color}>{modeInfo.footer}</Text>
                    <Text dimColor> (shift+tab to cycle)</Text>
                  </Text>
                ) : (
                  <Text dimColor>? /help · shift+tab mode · ! bash · @ files · alt+v image</Text>
                )}
                <Text dimColor>{footerRight}</Text>
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

export function makeCanUseTool(ctl) {
  return async (toolName, input, opts) => {
    if ((toolName === "Bash" || toolName === "PowerShell") && ctl.autoAllowAndroid && isAndroidCommand(input.command)) {
      return { behavior: "allow", updatedInput: input };
    }
    if (!ctl.request) return { behavior: "deny", message: "No interactive UI available." };
    const kind = toolName === "AskUserQuestion" ? "question" : toolName === "ExitPlanMode" ? "plan" : "permission";
    return ctl.request({ kind, toolName, input, opts });
  };
}

// MCP servers asking the user for form input or to open a link (e.g. to sign in).
export function makeOnElicitation(ctl) {
  return async (req, { signal }) => {
    if (!ctl.interactive || !ctl.request) return { action: "decline" };
    return ctl.request({ kind: "elicit", req, opts: { signal }, abortValue: { action: "cancel" } });
  };
}
