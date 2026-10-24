# myclaude

A Claude Code-style terminal agent built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview).
It runs on your Claude Console API key, so usage is billed to your Console organization (for example, the monthly
API credits included with a Max plan) instead of an interactive Claude Code subscription.

It loads the same things Claude Code does: `CLAUDE.md`, `.claude/settings.json`, permission rules, hooks, MCP
servers, plugins, skills and subagents.

## Install

Requires Node.js 20+.

```sh
npm install -g @tanishq03/myclaude
myclaude login     # paste your Claude Console API key (sk-ant-...)
```

The key is checked against the API, then saved to `~/.myclaude/config.json`. `myclaude logout` removes it.
The `MYCLAUDE_API_KEY` environment variable overrides the saved key.

## Usage

```sh
cd your/project
myclaude                             # asks for a permission mode, then starts
myclaude "fix the failing test"      # start with a prompt
myclaude -c                          # continue the last conversation in this folder
myclaude -r                          # pick a conversation to resume
myclaude -m opus                     # sonnet | opus | haiku | full model id (default: sonnet)
myclaude --mode acceptEdits          # skip the startup question
myclaude --add-dir ../other-repo     # let Claude work in another folder too
```

### One-shot (scripting)

```sh
myclaude -p "summarize this repo"                             # print the answer and exit
git diff | myclaude -p "review this"                          # piped input goes before the prompt
myclaude -p "fix lint" --max-budget-usd 0.50 --max-turns 20   # capped run
myclaude -p "list TODOs" --output-format json                 # json | stream-json (exit code 1 on error)
```

### Other commands

```sh
myclaude mcp add playwright -- npx @playwright/mcp@latest   # add an MCP server
myclaude doctor                                             # check the setup (no credits used)
myclaude update --check                                     # check for updates; `myclaude update` installs them
myclaude --help | --version
```

## Interactive features

- **Big pastes** (over 10 lines or 800 characters) show as `[Pasted text #1 +120 lines]` and are sent in full.
- **Images:** `alt+v` pastes an image from the clipboard.
- **Shell:** `!cmd` runs a command; its output goes to Claude with your next message.
- **Files:** `@` completes file paths; `/` completes commands.
- **Subagents** show live progress (current step, tool uses, tokens) and finish with a summary. The task list
  Claude keeps (TodoWrite/TaskCreate) shows under the spinner.
- **Edit permissions** show line numbers, surrounding lines and highlighted changed words.
- **MCP dialogs:** when an MCP server asks for input or needs a link opened (e.g. to sign in), myclaude shows a dialog.
- **Status line:** a `statusLine` command in your Claude Code settings is shown under the prompt, with the same JSON input.
- **Bell:** rings when Claude needs your answer or finishes a turn that took over 15 seconds (`"notify": false` turns it off).

### Keyboard shortcuts

| Key | Action |
|---|---|
| `shift+tab` | cycle permission mode |
| `esc` / `esc esc` | interrupt / rewind |
| `ctrl+b` | send running work to the background |
| `ctrl+o` | expand tool calls, thinking and subagent details |
| `ctrl+r` | search earlier prompts |
| `ctrl+t` | show/hide the task list |
| `ctrl+l` | clear input |
| `ctrl+g` | edit the prompt in your editor (`$EDITOR`, Notepad on Windows) |
| `alt+p` | model picker |
| `ctrl+x ctrl+k` | stop background tasks |
| `↑` / `↓` | prompt history |
| `PgUp` / `PgDn`, mouse wheel | scroll |
| `shift+enter`, `alt+enter`, `ctrl+j`, `\` + `enter` | new line |
| `ctrl+c` twice, or `ctrl+d` on an empty prompt | exit |

Keys can be remapped in `~/.claude/keybindings.json` (Claude Code's format; myclaude reads the actions it supports).
`/vim` turns on vim editing.

### Slash commands

| Command | Does |
|---|---|
| `/model`, `/effort` | switch model; set thinking effort (low … max) |
| `/mode`, `/plan` | change permission mode; switch to plan mode |
| `/clear` (`/new`), `/resume` | new conversation; resume an earlier one |
| `/rewind` | restore code and/or conversation to before a message |
| `/context`, `/status` | context window breakdown; model, mode, auth, context and cost |
| `/memory` | open a `CLAUDE.md` |
| `/agents` | list subagents, or describe a new one and Claude writes it |
| `/skills` | list skills, create one with Claude, or install a skill folder |
| `/mcp` | server status and tools; reconnect, enable/disable, add or remove servers |
| `/tasks` | background commands and subagents; stop them |
| `/permissions`, `/hooks` | view, add and remove allow/ask/deny rules; list hooks |
| `/allowed` | commands that run without asking |
| `/add-dir <path>` | another working folder for this session |
| `/export [file]` | save the conversation to a file or the clipboard |
| `/doctor` | health check (no credits used) |
| `/emulator` | Android devices, emulators and headless setting |
| `/vim`, `/help`, `/exit` (`/quit`) | |

Any other slash command (`/compact`, `/init`, `/review`, skills, your custom commands) is sent to Claude.

## Extras over Claude Code

myclaude builds a local plugin at `~/.myclaude/plugin` containing:

- **`myclaude:android`**: a built-in skill and helper script for emulators and devices. It can start/stop
  emulators (optionally headless), take screenshots, tap by text or id, type, swipe, scroll, draw strokes,
  launch apps, install APKs, read logcat, and compare screens with Figma designs.
- **Your claude.ai-synced skills** (from `~/.claude/skills/synced`), which Claude Code only loads when signed in
  to claude.ai.

**OAuth MCP servers** (Figma, Vercel, …): sign in once with `claude` → `/mcp` → Authenticate. myclaude reuses
the saved sign-in; run `/mcp` → Reconnect afterwards.

## Configuration

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

| Key | Default | Meaning |
|---|---|---|
| `model`, `effort`, `mode` | `sonnet`, Claude Code's `effortLevel` or `medium`, `default` | startup model, thinking effort, permission mode |
| `autoAllow` | `adb …`, `emulator …` | permission rules for commands that run without asking |
| `autoAllowAndroid` | `true` | also allow a single adb/emulator call by full path, or `node <android helper> …` |
| `emulator.headless` | `false` | start emulators without a window |
| `maxBudgetUsd` | none | default spending cap for `-p` runs |
| `suggestions` | `true` | greyed next-prompt suggestion |
| `agentSummaries` | `true` | short "what the subagent is doing" summaries |
| `showThinking` | `true` | request Claude's thinking text (shown with `ctrl+o`) |
| `notify` | `true` | terminal bell |
| `vim` | `false` | start in vim mode (`/vim` toggles and saves it) |

`suggestions` and `agentSummaries` reuse the prompt cache, so they cost very little.

A command containing `;`, `|`, `&`, `$` or `` ` `` always asks for permission. Don't add leading-wildcard rules
like `Bash(node *android.mjs*)`: they also match `node -e "<any code>" android.mjs`.

Other files:

- `~/.myclaude/history.json`: prompt history (last 200)
- `~/.myclaude/mcp.json` (user) or `./.mcp.json` (project): MCP servers added with myclaude; servers added with
  `claude mcp add` load too

## Development

```sh
git clone https://github.com/Tanishq-0308/myclaude.git
cd myclaude
npm install        # also builds dist/myclaude.js
npm link           # puts `myclaude` on your PATH
npm run build      # after changing anything in src/
npm test           # renders the UI against a fake session (no API calls)
npm run test:pty   # drives the real build in a pseudo-terminal with a dummy key (no API calls)
```

To publish: bump `version` in `package.json` and `VERSION` in `src/config.js`, then `npm publish`.

### Layout

| Path | Contents |
|---|---|
| `src/main.jsx` | CLI entry: args, login, `mcp` subcommand, SDK options, print mode |
| `src/session.js` | Agent SDK session: message queue, SDK events → UI events, rewind, cost |
| `src/config.js` | config, history and JSON file helpers |
| `src/mcp.js` | MCP server files and the `myclaude mcp` command |
| `src/extras.js` | plugin/skills setup, auto-allow rules, system prompt additions |
| `src/settings.js`, `src/doctor.js` | Claude Code settings files (permissions, hooks); health check |
| `src/statusline.js` | runs the Claude Code `statusLine` command |
| `src/markdown.js`, `src/clipboard.js` | Markdown rendering; image paste |
| `src/ui/app.jsx` | the app: state, SDK event handling, turns, input, layout |
| `src/ui/commands.js` | local slash commands |
| `src/ui/transcript.jsx` | transcript items, subagent progress, task list, resume history |
| `src/ui/dialogs.jsx`, `src/ui/components.jsx` | dialogs; input box, select list, spinner, diffs |
| `src/ui/complete.js`, `src/ui/keymap.js` | `/` and `@` completion; keybindings |
| `src/ui/format.js`, `src/ui/theme.js` | formatting; colours |
| `skills/android/` | built-in Android skill and helper script |
| `test/` | UI smoke test and pseudo-terminal test |

## License

MIT
