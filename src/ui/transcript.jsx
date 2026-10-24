import React, { memo } from "react";
import { Box, Text } from "ink";
import { renderMarkdown } from "../markdown.js";
import { DiffLines, Rule, editContext } from "./components.jsx";
import { ORANGE, PINK, CONTEXT_COLORS } from "./theme.js";
import {
  trunc, lines, kTokens, plural, secs, prettyCommand, toolTitle, toolSummary, resultSummary, groupSummary,
  GROUPABLE, HIDDEN_TOOLS, isAgentTool,
} from "./format.js";

export function Header({ modelName, cwd, version }) {
  return (
    <Box marginBottom={1} flexShrink={0}>
      <Box flexDirection="column" marginRight={2}>
        <Text color={ORANGE}>{" ▐▛███▜▌"}</Text>
        <Text color={ORANGE}>{"▝▜█████▛▘"}</Text>
        <Text color={ORANGE}>{"  ▘▘ ▝▝"}</Text>
      </Box>
      <Box flexDirection="column">
        <Text>
          <Text bold>myclaude</Text>
          <Text dimColor>{` v${version}`}</Text>
        </Text>
        <Text dimColor>{`${modelName} · API Usage Billing`}</Text>
        <Text dimColor>{cwd}</Text>
      </Box>
    </Box>
  );
}

const agentStats = (a) =>
  [a.count ? plural(a.count, "tool use") : null, a.tokens ? `${kTokens(a.tokens)} tokens` : null, a.ms ? secs(a.ms) : null].filter(Boolean).join(" · ");

function ToolHead({ name, input, color }) {
  const summary = toolSummary(name, input);
  return (
    <Text>
      <Text color={color}>{"● "}</Text>
      <Text bold>{toolTitle(name, input)}</Text>
      {summary ? <Text dimColor>{`(${summary})`}</Text> : null}
    </Text>
  );
}

function Nested({ width, children }) {
  return (
    <Box>
      <Text dimColor>{"  ⎿  "}</Text>
      <Box flexDirection="column" width={width - 5}>
        {children}
      </Box>
    </Box>
  );
}

// "3 Explore agents" / "2 agents" (mixed types).
function agentsLabel(list) {
  const types = new Set(list.map((a) => a.input.subagent_type ?? "general-purpose"));
  const type = types.size === 1 ? `${[...types][0]} ` : "";
  return `${list.length} ${type}agent${list.length === 1 ? "" : "s"}`;
}

// One row per agent, Claude Code style: ├─ description · stats, then what it is doing (or its result).
function AgentTree({ list, width, verbose, line }) {
  return list.map((a, i) => {
    const last = i === list.length - 1;
    const stats = line(a);
    return (
      <Box key={a.id ?? i} flexDirection="column">
        <Text>
          <Text dimColor>{`  ${last ? "└─" : "├─"} `}</Text>
          <Text bold>{trunc(a.input.description ?? "", Math.max(20, width - 50))}</Text>
          {stats.head ? <Text dimColor>{` · ${stats.head}`}</Text> : null}
        </Text>
        {stats.sub ? <Text dimColor color={stats.color}>{`  ${last ? " " : "│"}  ⎿  ${trunc(stats.sub, width - 10)}`}</Text> : null}
        {verbose ? a.tools.slice(-8).map((t, k) => <Text key={k} dimColor>{`  ${last ? " " : "│"}     ↳ ${trunc(t, width - 12)}`}</Text>) : null}
      </Box>
    );
  });
}

// Subagents that are still running: how many, and what each is doing now.
export function AgentsRunning({ agents, width, verbose }) {
  if (!agents.length) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={ORANGE}>{"● "}</Text>
        <Text bold>{`Running ${agentsLabel(agents)}…`}</Text>
        {!verbose ? <Text dimColor> (ctrl+o to see their steps)</Text> : null}
      </Text>
      <AgentTree
        list={agents}
        width={width}
        verbose={verbose}
        line={(a) => ({ head: agentStats({ ...a, ms: Date.now() - a.start }), sub: a.summary || a.last || "Initializing…" })}
      />
    </Box>
  );
}

// Finished subagents from one batch.
function AgentsDone({ item, width, verbose }) {
  const list = item.tools.map((t) => ({ ...t.agent, id: t.id, input: t.input, isError: t.isError, result: t.result, tools: t.agent?.tools ?? [] }));
  const failed = list.filter((a) => a.isError).length;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={failed ? "red" : "green"}>{"● "}</Text>
        <Text bold>{`${agentsLabel(list)} finished${failed ? ` (${failed} failed)` : ""}`}</Text>
        {!verbose ? <Text dimColor> (ctrl+o to expand)</Text> : null}
      </Text>
      <AgentTree
        list={list}
        width={width}
        verbose={verbose}
        line={(a) =>
          a.isError
            ? { sub: lines(a.result)[0], color: "red" }
            : a.input.run_in_background
              ? { head: "running in the background · /tasks" }
              : { head: `Done (${agentStats(a) || "no tools used"})`, sub: verbose ? lines(a.result).slice(0, 3).join(" ") : null }
        }
      />
    </Box>
  );
}

function AgentItem({ item, width, verbose }) {
  const a = item.agent ?? {};
  const bg = item.input.run_in_background;
  const head = item.isError ? lines(item.result).slice(0, 3).join("\n") : bg ? "Running in the background · /tasks to see it" : `Done (${agentStats(a) || "no tools used"})`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <ToolHead name={item.name} input={item.input} color={item.isError ? "red" : "green"} />
      <Nested width={width}>
        <Text color={item.isError ? "red" : "gray"}>{head}</Text>
        {verbose && a.tools?.length ? <Text dimColor>{a.tools.map((t) => `↳ ${t}`).join("\n")}</Text> : null}
        {verbose && !bg && item.result ? <Text>{renderMarkdown(item.result, width - 8)}</Text> : null}
      </Nested>
    </Box>
  );
}

function ContextItem({ u, width }) {
  const barWidth = Math.max(20, Math.min(60, width - 20));
  const cats = u.categories.filter((c) => c.tokens > 0);
  const colorOf = (c, i) => (c.kind === "free" ? "gray" : c.kind === "buffer" ? "#555555" : CONTEXT_COLORS[i % CONTEXT_COLORS.length]);
  const max = u.rawMaxTokens || u.maxTokens || 1;
  let used = 0;
  const segs = cats.map((c, i) => {
    const n = Math.max(c.tokens > 0 ? 1 : 0, Math.round((c.tokens / max) * barWidth));
    used += n;
    return { n, color: colorOf(c, i), ch: c.kind === "free" ? "░" : "█" };
  });
  if (used > barWidth) segs[segs.length - 1].n = Math.max(0, segs[segs.length - 1].n - (used - barWidth));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{`Context usage · ${u.model} · ${kTokens(u.totalTokens)}/${kTokens(u.maxTokens)} tokens (${Math.round(u.percentage)}%)`}</Text>
      <Text>
        {segs.map((s, i) => (
          <Text key={i} color={s.color}>{s.ch.repeat(s.n)}</Text>
        ))}
      </Text>
      {cats.map((c, i) => (
        <Text key={c.name}>
          <Text color={colorOf(c, i)}>{"■ "}</Text>
          {`${c.name.padEnd(24)} ${kTokens(c.tokens).padStart(7)}  ${((c.tokens / max) * 100).toFixed(1)}%`}
          {c.isDeferred ? <Text dimColor> (loaded on demand)</Text> : null}
        </Text>
      ))}
      {u.memoryFiles?.length ? (
        <Text dimColor>{["Memory files:", ...u.memoryFiles.map((f) => `  ${f.path} · ${kTokens(f.tokens)}`)].join("\n")}</Text>
      ) : null}
      {u.mcpTools?.length ? (
        <Text dimColor>
          {`MCP tools: ${u.mcpTools.length} (${kTokens(u.mcpTools.reduce((s, t) => s + (t.isLoaded === false ? 0 : t.tokens), 0))} tokens loaded)`}
        </Text>
      ) : null}
    </Box>
  );
}

export const Item = memo(function Item({ item, width, verbose }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text dimColor>{"❯ "}</Text>
          <Box width={width - 2}>
            <Text dimColor>{item.text}</Text>
          </Box>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Text>{"● "}</Text>
          <Box width={width - 2}>
            <Text>{renderMarkdown(item.text, width - 4)}</Text>
          </Box>
        </Box>
      );
    case "tool": {
      if (isAgentTool(item.name) && item.result !== undefined) return <AgentItem item={item} width={width} verbose={verbose} />;
      const out = resultSummary(item.name, item.result ?? "", item.isError, item.input);
      const edits = item.isError || item.result === undefined ? [] : item.name === "Edit" ? [item.input] : item.name === "MultiEdit" ? (item.input.edits ?? []).slice(0, 3) : [];
      return (
        <Box flexDirection="column" marginTop={1}>
          <ToolHead name={item.name} input={item.input} color={item.isError ? "red" : "green"} />
          {item.result !== undefined ? (
            <Nested width={width}>
              <Text color={item.isError ? "red" : "gray"}>{(verbose && !item.isError ? lines(item.result).slice(0, 40) : out).join("\n")}</Text>
              {edits.map((e, i) => (
                <DiffLines key={i} oldText={e.old_string} newText={e.new_string} max={verbose ? 40 : 10} ctx={editContext(item.input.file_path, e.old_string, e.new_string)} />
              ))}
              {!item.isError && item.name === "Write" ? <DiffLines newText={item.input.content} max={8} /> : null}
            </Nested>
          ) : null}
        </Box>
      );
    }
    case "agents":
      return <AgentsDone item={item} width={width} verbose={verbose} />;
    case "group": {
      const last = item.tools[item.tools.length - 1];
      const lastText =
        last.name === "Bash" || last.name === "PowerShell"
          ? `$ ${trunc(prettyCommand(last.input.command), width - 12)}`
          : `${toolTitle(last.name, last.input)}(${trunc(toolSummary(last.name, last.input), width - 20)})`;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color="green">{"● "}</Text>
            <Text bold>{groupSummary(item.tools)}</Text>
            <Text dimColor> (ctrl+o to expand)</Text>
          </Text>
          <Text dimColor>{`  ⎿  ${lastText}`}</Text>
        </Box>
      );
    }
    case "bash": {
      const out = lines(item.output || "(No output)");
      const shown = verbose ? out.slice(0, 200) : out.slice(0, 8);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={PINK}>{"! "}</Text>
            <Text>{item.command}</Text>
          </Text>
          <Nested width={width}>
            <Text color={item.code ? "red" : "gray"}>{shown.join("\n") + (out.length > shown.length ? `\n… +${out.length - shown.length} lines (ctrl+o)` : "")}</Text>
          </Nested>
        </Box>
      );
    }
    case "todos":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color="green">{"● "}</Text>
            <Text bold>Update Todos</Text>
          </Text>
          <TodoLines todos={item.todos ?? []} />
        </Box>
      );
    case "context":
      return <ContextItem u={item.usage} width={width} />;
    case "thinking":
      return verbose ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor italic>{"∴ Thinking…"}</Text>
          <Box paddingLeft={2} width={width - 2}>
            <Text dimColor italic>{item.text}</Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor italic>{`∴ Thought${item.ms ? ` for ${secs(item.ms)}` : ""} (ctrl+o to show)`}</Text>
        </Box>
      );
    case "info":
      return (
        <Box marginTop={1}>
          <Text dimColor>{item.text}</Text>
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">{`● ${item.text}`}</Text>
        </Box>
      );
    case "done":
      return (
        <Box marginTop={1}>
          <Text dimColor>{`✻ Done in ${item.secs.toFixed(1)}s · $${item.cost.toFixed(4)} this session`}</Text>
        </Box>
      );
    case "divider":
      return (
        <Box marginTop={1}>
          <Rule width={width} />
        </Box>
      );
    default:
      return null;
  }
});

function TodoLines({ todos, max = 10 }) {
  const shown = todos.slice(0, max);
  return (
    <>
      {shown.map((t, i) => (
        <Text key={i} dimColor={t.status === "completed"} bold={t.status === "in_progress"} strikethrough={t.status === "completed"}>
          {`  ${i === 0 ? "⎿" : " "}  ${t.status === "completed" ? "☒" : t.status === "in_progress" ? "◼" : "☐"} ${t.content ?? t.subject ?? ""}`}
        </Text>
      ))}
      {todos.length > max ? <Text dimColor>{`     … +${todos.length - max} more`}</Text> : null}
    </>
  );
}

// The live task list under the spinner (TodoWrite / TaskCreate / TaskUpdate).
export function TaskPanel({ todos }) {
  if (!todos.length || todos.every((t) => t.status === "completed")) return null;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <TodoLines todos={todos} />
    </Box>
  );
}

export function groupItems(items) {
  const out = [];
  let cur = null;
  let agents = null;
  for (const it of items) {
    // Subagents that finished one after another (usually one parallel batch) show as one block.
    if (it.kind === "tool" && isAgentTool(it.name) && it.result !== undefined && it.agent) {
      cur = null;
      if (!agents) {
        agents = { kind: "agents", id: `a${it.id}`, tools: [] };
        out.push(agents);
      }
      agents.tools.push(it);
      continue;
    }
    agents = null;
    if (it.kind === "tool" && GROUPABLE.has(it.name) && !it.isError && it.result !== undefined) {
      if (!cur) {
        cur = { kind: "group", id: `g${it.id}`, tools: [] };
        out.push(cur);
      }
      cur.tools.push(it);
    } else {
      cur = null;
      out.push(it);
    }
  }
  return out.map((g) => (g.kind === "group" && g.tools.length === 1 ? g.tools[0] : g));
}

// ---------- conversation history (for resume) ----------

function blockText(b) {
  return Array.isArray(b.content) ? b.content.filter((x) => x.type === "text").map((x) => x.text).join("\n") : String(b.content ?? "");
}

function cleanUserText(text) {
  let t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
    return `${cmd[1].trim()}${args ? ` ${args}` : ""}`;
  }
  if (/<local-command-(stdout|stderr)>/.test(t) || /^Caveat: The messages below were generated/.test(t.trim())) return "";
  t = t.replace(/<bash-input>([\s\S]*?)<\/bash-input>[\s\S]*?(<\/bash-stderr>|<\/bash-stdout>)\s*/g, "! $1\n");
  return t.trim();
}

// Turns a saved transcript (Claude Code or myclaude) into transcript items.
export function historyItems(msgs, limit = 300) {
  const items = [];
  const tools = new Map();
  for (const m of msgs) {
    if (m.parent_tool_use_id) continue;
    const c = m.message?.content;
    if (m.type === "user") {
      const blocks = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
      const texts = [];
      let images = 0;
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const t = tools.get(b.tool_use_id);
          tools.delete(b.tool_use_id);
          if (t) items.push({ kind: "tool", name: t.name, input: t.input, result: blockText(b), isError: !!b.is_error });
        } else if (b.type === "text") texts.push(b.text);
        else if (b.type === "image") images++;
      }
      let text = cleanUserText(texts.join("\n"));
      if (/^This session is being continued from a previous conversation/.test(text)) {
        items.push({ kind: "info", text: "✻ Earlier messages were compacted into a summary" });
        continue;
      }
      if (/^\[Request interrupted by user/.test(text)) {
        items.push({ kind: "error", text: "Interrupted by user" });
        continue;
      }
      if (images) text = `${Array.from({ length: images }, (_, i) => `[Image #${i + 1}]`).join(" ")} ${text}`.trim();
      if (text) items.push({ kind: "user", text });
    } else if (m.type === "assistant") {
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type === "text" && b.text.trim()) items.push({ kind: "assistant", text: b.text });
        else if (b.type === "thinking" && b.thinking?.trim()) items.push({ kind: "thinking", text: b.thinking });
        else if (b.type === "tool_use") {
          if (b.name === "TodoWrite") items.push({ kind: "todos", todos: b.input?.todos });
          else if (!HIDDEN_TOOLS.has(b.name)) tools.set(b.id, { name: b.name, input: b.input ?? {} });
        }
      }
    }
  }
  if (items.length > limit) {
    const hidden = items.length - limit;
    return [{ kind: "info", text: `… ${hidden} earlier item${hidden === 1 ? "" : "s"} not shown` }, ...items.slice(-limit)];
  }
  return items;
}
