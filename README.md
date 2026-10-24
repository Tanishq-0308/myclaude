# myclaude

A Claude Code-style terminal agent built on the Claude Agent SDK. It uses your Claude Console API key, so usage is billed to the monthly API credits included with your Max plan (Agent SDK usage is covered; interactive Claude Code is not).

## Setup

```powershell
npm install -g @tanishq03/myclaude   # Node 20+
myclaude login            # paste your Claude Console API key (saved to ~/.myclaude/config.json)
```

From source: `npm install` (also builds `dist/myclaude.js`), then `npm link`. After changing anything in `src/`, run `npm run build`.
To publish a new version: bump `version` in `package.json` and `VERSION` in `src/config.js`, then `npm publish`.

## Use

```powershell
cd D:\your\project
myclaude                         # asks for a mode, then starts
myclaude "fix the failing test"  # start with a prompt
myclaude -p "summarize this repo"   # one-shot, prints and exits
myclaude -c                      # continue last conversation in this folder
myclaude -r                      # pick a conversation to resume
myclaude --model opus            # pick a model (default: sonnet)
myclaude --mode acceptEdits      # skip the startup question
myclaude -p "fix lint" --max-budget-usd 0.50 --max-turns 20   # capped one-shot run
myclaude mcp add playwright -- npx @playwright/mcp@latest     # add an MCP server
myclaude doctor                                               # check the setup (no credits used)
myclaude update --check                                       # newer dependency versions? (update installs + rebuilds)
git diff | myclaude -p "review this"                          # piped input goes before the prompt
myclaude -p "list TODOs" --output-format json                 # json | stream-json, for scripts (exit 1 on error)
```

Big pastes (over 10 lines or 800 characters) show as `[Pasted text #1 +120 lines]` and are sent in full.
When an MCP server asks for input (a form) or for a link to be opened (e.g. to sign in), myclaude shows a dialog.
The terminal bell rings when Claude needs your answer or finishes a turn that took over 15 seconds; set
`"notify": false` in the config to turn it off.

Shortcuts: `shift+tab` cycle mode · `esc` interrupt · `esc esc` rewind · `ctrl+b` send running work to the
background · `ctrl+o` expand tool calls, thinking and subagent details · `ctrl+r` search earlier prompts ·
`ctrl+t` show/hide the task list · `ctrl+l` clear input · `alt+p` model picker · `ctrl+x ctrl+k` stop background
tasks · `ctrl+c` twice (or `ctrl+d` on an empty prompt) to exit · `↑/↓` history · PgUp/PgDn or wheel to scroll ·
`shift/alt+enter`, `ctrl+j` or `\` + Enter for a new line · `@` file completion · `!cmd` run a shell command
(output goes to Claude with your next message) · `alt+v` paste an image · `/vim` vim editing mode · `ctrl+g` edit the prompt in your editor ($EDITOR, Notepad by default).

Keys can be changed in `~/.claude/keybindings.json` (Claude Code's format; myclaude reads the actions it has).
A `statusLine` command in your Claude Code settings is shown under the prompt, with the same JSON input.
Edit permissions show line numbers, surrounding lines and the changed words highlighted.
`--add-dir <path>` (or `/add-dir`) lets Claude work in another folder too.

Commands:

| | |
|---|---|
| `/model`, `/effort`, `/mode`, `/plan` | model, thinking effort, permission mode |
| `/clear`, `/resume`, `/rewind` | new / earlier conversation; restore code and/or conversation to before a message |
| `/context`, `/status`, `/memory` | context window breakdown; session info; open a CLAUDE.md |
| `/agents` | list subagents, or describe a new one and Claude writes it (`.claude/agents`) |
| `/skills` | list skills, create one with Claude, or install a skill folder (`~/.claude/skills`) |
| `/mcp` | server status and tools, reconnect, enable/disable, add or remove servers |
| `/tasks` | background commands and subagents; stop them |
| `/permissions`, `/hooks` | view, add and remove allow/ask/deny rules (Claude Code's settings files); list hooks |
| `/export`, `/doctor` | save the conversation to a file or clipboard; health check (no credits used) |
| `/add-dir`, `/vim` | another working folder; vim editing |
| `/emulator`, `/allowed`, `/help`, `/exit` | |

Other slash commands (`/compact`, `/init`, `/review`, skills, your custom commands) go to Claude.

Subagents show live progress (current step, tool uses, tokens) and finish with a summary like Claude Code;
`ctrl+o` shows each tool they used. The task list Claude keeps (TodoWrite/TaskCreate) shows under the spinner.

## What it loads

The same things Claude Code loads: `CLAUDE.md`, `.claude/settings.json`, permission rules, hooks, MCP servers
(Figma, Vercel, Playwright, …), plugins and their skills. On top of that it adds a local plugin
(`~/.myclaude/plugin`) with:

- `myclaude:android` – built-in skill + helper (`skills/android/scripts/android.mjs`) for emulators and devices:
  start/stop (optionally headless), screenshots, tap by text/id, type, swipe, scroll, draw strokes, launch apps,
  install APKs, logcat, and comparing screens with Figma designs.
- Your claude.ai-synced skills (mobile-qa, pdf, docx, xlsx, pptx, skill-creator), which Claude Code itself only
  loads when signed in to claude.ai.

MCP servers that need OAuth (Figma, Vercel): sign in once with `claude` → `/mcp` → Authenticate. myclaude uses the
saved sign-in; use `/mcp` → Reconnect afterwards.

## Config

`~/.myclaude/config.json`:

```json
{
  "apiKey": "sk-ant-...",
  "model": "sonnet",
  "effort": "high",
  "mode": "default",
  "emulator": { "headless": false },
  "autoAllow": ["Bash(adb *)", "PowerShell(adb *)"],
  "autoAllowAndroid": true
}
```

`autoAllow` lists permission rules for commands that run without asking (default: `adb …` and `emulator …`).
`autoAllowAndroid` (default `true`) also lets a single adb/emulator call by full path, or `node <android helper> …`,
run without asking. A command with `;`, `|`, `&`, `$` or `` ` `` in it always asks.
Don't add leading-wildcard rules like `Bash(node *android.mjs*)`: they also match `node -e "<any code>" android.mjs`.

Other config keys: `suggestions: false` turns off the greyed next-prompt suggestion, `agentSummaries: false`
turns off the short "what the subagent is doing" summaries (both reuse the prompt cache, so they cost very
little), `maxBudgetUsd` sets a default cap for `-p` runs, `showThinking: false` stops requesting Claude's
thinking text (shown with ctrl+o), `vim: true` starts in vim mode (`/vim` toggles and saves it).

Prompt history (↑/↓) is saved in `~/.myclaude/history.json` (last 200). MCP servers added with myclaude go
to `~/.myclaude/mcp.json` (user) or `./.mcp.json` (project); servers from `claude mcp add` load too.
`MYCLAUDE_API_KEY` overrides the saved key.

## Files

- `src/main.jsx` – CLI entry: args, login, `mcp` subcommand, SDK options, print mode
- `src/config.js` – config, history and JSON file helpers
- `src/session.js` – Agent SDK session: message queue, SDK events → UI events, rewind, cost
- `src/mcp.js` – myclaude's MCP server files and the `myclaude mcp` command
- `src/extras.js` – plugin/skills setup, auto-allow rules, system prompt additions
- `src/ui/app.jsx` – the app: state, SDK event handling, turns, input, layout
- `src/ui/commands.js` – local slash commands (`/agents`, `/skills`, `/mcp`, `/rewind`, …)
- `src/ui/transcript.jsx` – transcript items, subagent progress, task list, resume history
- `src/ui/dialogs.jsx`, `src/ui/components.jsx` – dialogs; input box, select list, spinner, diffs
- `src/ui/complete.js`, `src/ui/keymap.js` – `/` and `@` completion; keybindings (keybindings.json)
- `src/ui/format.js`, `src/ui/theme.js` – formatting, colours
- `src/statusline.js` – runs the Claude Code `statusLine` command
- `src/markdown.js`, `src/clipboard.js` – Markdown rendering, image paste
- `skills/android/` – built-in Android skill and helper script
- `src/settings.js`, `src/doctor.js` – Claude Code settings files (permissions, hooks); health check
- `test/ui-smoke.jsx` – `npm test`: renders the UI against a fake session (no API calls)
- `test/pty.mjs` – `npm run test:pty`: drives the real build in a pseudo-terminal with a temp home and a dummy key
  (real keystrokes, no API calls)
#   m y c l a u d e  
 