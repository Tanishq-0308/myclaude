import path from "node:path";

export const trunc = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
};
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const rel = (p) => (p ? (path.isAbsolute(p) ? path.relative(process.cwd(), p) || "." : p) : "");
export const lines = (text) => String(text ?? "").replace(/\s+$/, "").split(/\r?\n/);
export const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n ?? 0)));
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`);

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const prettyCommand = (c) => String(c ?? "").replace(/node\s+"?[^"\s]*android\.mjs"?/g, "android");

// Tools shown elsewhere (task list panel) instead of as transcript entries.
export const HIDDEN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
// Read-only tools that collapse into one "Read 3 files, ran 2 commands" line.
export const GROUPABLE = new Set(["Bash", "PowerShell", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Skill", "ToolSearch", "Monitor", "ListMcpResourcesTool", "ReadMcpResourceTool"]);
export const isAgentTool = (name) => name === "Agent" || name === "Task";

export function mcpName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name ?? "");
  return m ? { server: m[1].replace(/^plugin_[^_]+_/, ""), tool: m[2] } : null;
}

export function toolTitle(name, input = {}) {
  const mcp = mcpName(name);
  if (mcp) return `${mcp.server} - ${mcp.tool} (MCP)`;
  if (isAgentTool(name)) return input.subagent_type ? cap(input.subagent_type) : "Agent";
  return (
    {
      Edit: "Update", MultiEdit: "Update", Write: "Write", WebFetch: "Fetch", WebSearch: "Web Search",
      Glob: "Search", Grep: "Search", ExitPlanMode: "Plan", EnterPlanMode: "Plan mode", AskUserQuestion: "Question",
      TaskStop: "Stop task",
    }[name] ?? name
  );
}

export function toolSummary(name, input = {}) {
  switch (name) {
    case "Read": case "Write": case "Edit": case "MultiEdit": return rel(input.file_path);
    case "NotebookEdit": return rel(input.notebook_path);
    case "Bash": case "PowerShell": return trunc(prettyCommand(input.command), 90);
    case "Skill": return input.skill ?? input.name ?? "";
    case "Glob": return input.pattern;
    case "Grep": return `"${trunc(input.pattern, 50)}"${input.path ? ` in ${rel(input.path)}` : ""}`;
    case "WebFetch": return input.url;
    case "WebSearch": return input.query;
    case "Agent": case "Task": return input.description ?? "";
    case "ExitPlanMode": case "EnterPlanMode": case "AskUserQuestion": return "";
    default: return trunc(JSON.stringify(input), 70);
  }
}

export function resultSummary(name, text, isError, input = {}) {
  const all = lines(text);
  const clip = (n) => (all.length > n ? [...all.slice(0, n), `… +${all.length - n} lines`] : all);
  if (isError) return clip(3);
  const count = text.trim() ? all.length : 0;
  switch (name) {
    case "Read": return [IMAGE_RE.test(input.file_path ?? "") ? "Viewed image" : `Read ${count} lines`];
    case "Skill": return ["Loaded skill"];
    case "Bash": case "PowerShell": return text.trim() ? clip(5) : ["(No output)"];
    case "Glob": return [`Found ${count} files`];
    case "Grep": return clip(1);
    case "Write": return ["File written"];
    case "Edit": case "MultiEdit": case "NotebookEdit": return ["File updated"];
    case "Agent": case "Task": return input.run_in_background ? ["Running in the background · /tasks to see it"] : clip(3);
    case "ExitPlanMode": return ["Plan approved"];
    case "EnterPlanMode": return ["Entered plan mode"];
    case "AskUserQuestion": return clip(3);
    default: return clip(2);
  }
}

export function groupSummary(tools) {
  const n = { cmd: 0, shot: 0, read: 0, search: 0, fetch: 0, skill: 0, other: 0 };
  for (const t of tools) {
    if (t.name === "Bash" || t.name === "PowerShell") n.cmd++;
    else if (t.name === "Read") IMAGE_RE.test(t.input.file_path ?? "") ? n.shot++ : n.read++;
    else if (t.name === "Glob" || t.name === "Grep" || t.name === "WebSearch") n.search++;
    else if (t.name === "WebFetch") n.fetch++;
    else if (t.name === "Skill") n.skill++;
    else n.other++;
  }
  const s = [
    n.cmd && `ran ${plural(n.cmd, "command")}`,
    n.shot && `viewed ${plural(n.shot, "image")}`,
    n.read && `read ${plural(n.read, "file")}`,
    n.search && `searched ${plural(n.search, "time")}`,
    n.fetch && `fetched ${plural(n.fetch, "page")}`,
    n.skill && `loaded ${plural(n.skill, "skill")}`,
    n.other && `used ${plural(n.other, "tool")}`,
  ]
    .filter(Boolean)
    .join(", ");
  return cap(s);
}
