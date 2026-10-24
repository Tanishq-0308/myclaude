// Renders the App against a fake session and fake terminal, plays a turn with a subagent, a task list
// and slash/file completion, and fails if anything throws or expected text is missing.
// Run: npm test
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { App } from "../src/ui/app.jsx";

const stdout = new PassThrough();
Object.assign(stdout, { columns: 100, rows: 40, isTTY: true });
let frame = "";
stdout.on("data", (d) => (frame += d.toString()));
const stdin = new PassThrough();
Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });

const session = {
  mode: "default", model: "sonnet", effort: "high", turns: [], cost: 0, sessionId: null,
  emit: () => {},
  q: { supportedCommands: async () => [{ name: "compact", description: "Compact the conversation" }], getContextUsage: async () => ({ percentage: 12 }) },
  start() {}, init: async () => ({ models: [], commands: [{ name: "compact", description: "Compact the conversation" }] }),
  models: async () => [],
  send(content, text) {
    this.turns.push({ uuid: "u1", text, at: Date.now() });
    return new Promise((r) => (this.finish = r));
  },
  setMode: async () => {}, interrupt: async () => {}, close() {},
};
const ctl = { session, runHelper: () => "" };
const startup = {
  version: "test", history: [], defaultEffort: "high", autoAllow: [], keyTail: "abc123", askMode: false, startExtra: {},
  listSessions: async () => [], getSessionMessages: async () => [], getSessionInfo: async () => null,
};

const app = render(<App ctl={ctl} startup={startup} />, { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const type = async (s) => {
  stdin.write(s);
  await wait(60);
};
const expect = (what) => {
  const plain = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  if (!plain.includes(what)) throw new Error(`missing "${what}" in output:\n${plain.slice(-3000)}`);
};

await wait(150);
await type("/co");
expect("/compact");
expect("/context");
await type("\x15"); // ctrl+u clears
await type("hello");
await type("\r");
const emit = (e) => session.emit(e);
emit({ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "Look around", activeForm: "Looking around", status: "in_progress" }, { content: "Report", status: "pending" }] }, parent: null });
for (const [id, description] of [["a1", "Find config"], ["a2", "Find tests"], ["a3", "Find docs"]]) {
  emit({ type: "tool_use", id, name: "Agent", input: { description, subagent_type: "Explore" }, parent: null });
}
emit({ type: "tool_use", id: "s1", name: "Read", input: { file_path: "package.json" }, parent: "a1" });
emit({ type: "tool_use", id: "s2", name: "Glob", input: { pattern: "**/*.test.js" }, parent: "a2" });
emit({ type: "task", m: { subtype: "task_progress", tool_use_id: "a1", usage: { total_tokens: 4321, tool_uses: 3 }, summary: "Reading package.json" } });
await wait(120);
expect("Running 3 Explore agents…");
expect("├─ Find config · 3 tool uses · 4.3k tokens");
expect("Reading package.json");
expect("Search(**/*.test.js)");
expect("└─ Find docs");
expect("Looking around");
emit({ type: "tool_result", id: "a1", text: "Config is in config.js", isError: false, parent: null });
emit({ type: "tool_result", id: "a2", text: "Tests are in test/", isError: false, parent: null });
emit({ type: "tool_result", id: "a3", text: "Docs are in README.md", isError: false, parent: null });
emit({ type: "text_delta", text: "All **done**." });
emit({ type: "text_done" });
emit({ type: "result", durationMs: 1500, cost: 0.0123 });
session.finish();
await wait(150);
expect("3 Explore agents finished");
expect("Find config · Done (3 tool uses · 4.3k tokens");
expect("└─ Find docs · Done (");
expect("All done.");
expect("$0.0123");
await type("!echo hi-from-bash");
expect("bash mode");
await type("\r");
await wait(1500);
expect("hi-from-bash");
await type("look at @package.js");
expect("package.json");
await type("\x15");
await type("\x1b");
await type("\x1b");
await wait(150);
expect("Go back to before one of your messages");
await type("\x1b");
await wait(100);

// Big pastes collapse into a token.
await type("\x1b[200~" + "line\n".repeat(30) + "\x1b[201~");
expect("[Pasted text #1 +31 lines]");
await type("\x15");

// MCP elicitation form: text, enum and boolean fields.
const answer = ctl.request({
  kind: "elicit",
  abortValue: { action: "cancel" },
  opts: {},
  req: {
    serverName: "demo",
    message: "Pick details",
    requestedSchema: { type: "object", required: ["name"], properties: { name: { type: "string", title: "Your name" }, size: { type: "string", enum: ["s", "m"] }, ok: { type: "boolean" } } },
  },
});
await wait(100);
expect("Your name");
await type("Ada");
await type("\r");
await type("\r");
await type("\r");
const res = await answer;
if (JSON.stringify(res) !== JSON.stringify({ action: "accept", content: { name: "Ada", size: "s", ok: true } })) throw new Error(`elicitation result: ${JSON.stringify(res)}`);

// ctrl+r history search finds the earlier prompt.
await type("\x12");
await type("hel");
expect("search prompts: hel");
await type("\x1b");
await type("\x15");

// Thinking shows collapsed.
session.emit({ type: "thinking", text: "Let me think about it.", ms: 2400 });
await wait(100);
expect("∴ Thought for 2s");

// Vim mode: esc goes to normal mode, i back to insert.
await type("/vim");
await type("\r");
await wait(100);
expect("Vim mode on");
await type("abc");
await type("\x1b");
await wait(100);
expect("-- NORMAL --");
await type("i");
await type("\x15");
await type("/vim");
await type("\r");

// Permission dialog for an edit: line numbers and the changed lines.
const fs = await import("node:fs");
const os = await import("node:os");
const file = `${os.tmpdir()}/myclaude-smoke-${process.pid}.js`;
fs.writeFileSync(file, "// header\nconst value = 1;\nexport default value;\n");
frame = "";
const perm = ctl.request({ kind: "permission", toolName: "Edit", input: { file_path: file, old_string: "const value = 1;", new_string: "const value = 2;" }, opts: {} });
await wait(150);
expect("2 - const value = 1;");
expect("2 + const value = 2;");
expect("1   // header");
await type("\r");
const p = await perm;
fs.rmSync(file);
if (p.behavior !== "allow") throw new Error(`permission result: ${JSON.stringify(p)}`);
app.unmount();
console.log("ui smoke test passed");
process.exit(0);
