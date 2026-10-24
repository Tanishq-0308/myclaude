// Drives the built myclaude in a real pseudo-terminal (ConPTY on Windows) and reads the screen through a
// terminal emulator. Uses a temporary home folder and a dummy API key and never sends a prompt to Claude,
// so it touches none of your files and uses no credits. Run: npm run test:pty
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "@lydell/node-pty";
import xterm from "@xterm/headless";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-pty-"));
const home = path.join(tmp, "home");
const project = path.join(tmp, "project");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, "package.json"), "{}\n");
const editor = path.join(tmp, "editor.mjs");
fs.writeFileSync(editor, 'import fs from "node:fs"; fs.appendFileSync(process.argv[2], " via-editor");\n');

const cols = 110;
const rows = 40;
const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
const env = { ...process.env, USERPROFILE: home, HOME: home, MYCLAUDE_API_KEY: "sk-ant-dummy-key-not-used", EDITOR: `node "${editor}"`, VISUAL: "" };
delete env.ANTHROPIC_API_KEY;
const p = pty.spawn(process.execPath, [path.join(ROOT, "dist", "myclaude.js"), "--mode", "default"], { name: "xterm-256color", cols, rows, cwd: project, env });
p.onData((d) => term.write(d));
let exited = null;
p.onExit((e) => (exited = e));

const screen = () => {
  const b = term.buffer.active;
  return Array.from({ length: rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? "").join("\n");
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(text, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (typeof text === "function" ? text(screen()) : screen().includes(text)) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${typeof text === "function" ? "condition" : JSON.stringify(text)}. Screen:\n${screen()}`);
}
const send = async (s, ms = 120) => {
  p.write(s);
  await wait(ms);
};
const ESC = "\x1b";
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (e) {
    results.push(`✗ ${name}\n${String(e.message).split("\n").slice(0, 45).join("\n")}`);
  }
  await send("\x0c"); // ctrl+l: clear the input between checks
}

try {
  await waitFor("myclaude v", 20000);
  await waitFor("❯");

  await check("slash completion + /help", async () => {
    await send("/he");
    await waitFor("/help");
    await send("\r");
    await waitFor("Commands");
  });
  await check("/doctor", async () => {
    await send("/doctor\r");
    await waitFor("Agent SDK", 15000);
  });
  await check("ctrl+r history search", async () => {
    await send("/status\r");
    await waitFor("Folder:");
    await send("\x12");
    await waitFor("search prompts:");
    await send("stat");
    await waitFor((s) => s.includes("search prompts: stat") && s.includes("/status"));
    await send(ESC, 300);
    await waitFor((s) => !s.includes("search prompts:") && /❯ \/status/.test(s));
  });
  await check("shift+tab cycles mode", async () => {
    await send("\x1b[Z");
    await waitFor("accept edits on");
    for (let i = 0; i < 3; i++) await send("\x1b[Z");
    await waitFor((s) => !s.includes("auto mode on") && !s.includes("plan mode on") && !s.includes("accept edits on"));
  });
  await check("ctrl+o and ctrl+t", async () => {
    await send("\x0f");
    await waitFor("expanded");
    await send("\x0f");
    await waitFor((s) => !s.includes("expanded · ctrl+o"));
    await send("\x14");
  });
  await check("! bash mode", async () => {
    await send("!");
    await waitFor("bash mode");
    await send("echo pty-bash-ok\r");
    await waitFor((s) => s.split("pty-bash-ok").length >= 3, 15000);
  });
  await check("@ file completion", async () => {
    await send("look at @pack");
    await waitFor("package.json");
    await send("\t");
    await waitFor("@package.json");
  });
  await check("vim mode", async () => {
    await send("/vim\r");
    await waitFor("Vim mode on");
    await waitFor("-- INSERT --");
    await send("abc");
    await send(ESC, 300);
    await waitFor("-- NORMAL --");
    await send("i");
    await waitFor("-- INSERT --");
    await send("\x0c");
    await send("/vim\r");
    await waitFor("Vim mode off");
  });
  await check("ctrl+g external editor", async () => {
    await send("draft");
    await send("\x07", 300);
    await waitFor("draft via-editor", 15000);
  });
  await check("/permissions add rule", async () => {
    await send("/permissions\r");
    await waitFor("Permission rules");
    await send("\r");
    await waitFor("What should the rule do?");
    await send("\r");
    await waitFor("New allow rule");
    await send("Bash(npm test:*)\r");
    await waitFor("Save it where?");
    await send("\r");
    await waitFor("Added allow rule");
    const local = JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8"));
    if (!local.permissions.allow.includes("Bash(npm test:*)")) throw new Error("rule not saved");
  });
  await check("/hooks", async () => {
    await send("/hooks\r");
    await waitFor("No hooks set up");
  });
  await check("/export to file", async () => {
    await send("/export\r");
    await waitFor("Export conversation");
    await send("\r");
    await waitFor("Saved the conversation to");
    if (!fs.readdirSync(project).some((f) => f.endsWith(".txt"))) throw new Error("no export file");
  });
  await check("long transcript loads older items on scroll", async () => {
    for (let i = 0; i < 130; i++) await send("/hooks\r", 30);
    await waitFor((s) => (s.match(/No hooks set up/g) ?? []).length > 3, 15000);
    // Only the newest 120 items are drawn; reaching the top loads the rest, so the header comes back.
    await waitFor((s) => !s.includes("myclaude v"));
    for (let i = 0; i < 400 && !screen().includes("myclaude v"); i++) await send("\x1b[5~", 25); // PgUp
    if (!screen().includes("myclaude v")) throw new Error(`never reached the start. Screen:\n${screen()}`);
    for (let i = 0; i < 400 && screen().includes("more below"); i++) await send("\x1b[6~", 25); // PgDn back down
    if (screen().includes("more below")) throw new Error(`couldn't scroll back down. Screen:\n${screen()}`);
  });
  await check("big paste collapses", async () => {
    await send(`\x1b[200~${"line\r".repeat(30)}\x1b[201~`, 400);
    await waitFor("[Pasted text #1 +");
  });
  await check("ctrl+c twice exits", async () => {
    await send("\x03", 200);
    await waitFor("Press Ctrl+C again");
    await send("\x03", 500);
    const end = Date.now() + 8000;
    while (!exited && Date.now() < end) await wait(50);
    if (!exited) throw new Error("did not exit");
  });
} catch (e) {
  results.push(`✗ startup\n${e.message}`);
} finally {
  if (!exited) p.kill();
  await wait(300);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("✗")).length;
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} real-terminal checks passed`);
process.exit(failed ? 1 : 0);
