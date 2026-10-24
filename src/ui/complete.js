import fs from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "__pycache__", ".venv", "venv", "target", ".gradle", ".idea", "Pods"]);
const KEEP_DOT = new Set([".claude", ".github", ".mcp.json", ".env.example"]);
let index = { root: null, at: 0, files: [] };

// ponytail: synchronous walk capped at 20k entries, refreshed every 30s; use `git ls-files` or a
// background walker if huge folders make the first @ feel slow.
function listFiles(root, limit = 20000) {
  if (index.root === root && Date.now() - index.at < 30000) return index.files;
  const files = [];
  const stack = [""];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || (e.name.startsWith(".") && !KEEP_DOT.has(e.name))) continue;
      const p = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        files.push(p + "/");
        stack.push(p);
      } else files.push(p);
    }
  }
  index = { root, at: Date.now(), files };
  return files;
}

function findFiles(query, max = 8) {
  const q = query.toLowerCase().replace(/\\/g, "/");
  const hits = [];
  for (const f of listFiles(process.cwd())) {
    const l = f.toLowerCase();
    if (q && !l.includes(q)) continue;
    const base = l.replace(/\/$/, "").split("/").pop();
    hits.push([(base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2) * 1e4 + f.length, f]);
    if (hits.length > 5000) break;
  }
  return hits.sort((a, b) => a[0] - b[0]).slice(0, max).map(([, f]) => f);
}

// `/command` and `@path` completion for the prompt (see TextInput's `complete`).
export function makeCompleter(getCommands) {
  return (value, cursor) => {
    if (value.startsWith("/") && !/\s/.test(value)) {
      const q = value.slice(1).toLowerCase();
      const items = getCommands()
        .filter((c) => c.name.toLowerCase().startsWith(q) || c.aliases?.some((a) => a.startsWith(q)))
        .slice(0, 10)
        .map((c) => ({ text: `/${c.name} `, label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`, desc: c.desc }));
      return items.length ? { start: 0, end: value.length, items, submit: true } : null;
    }
    const m = /(^|\s)@("?[^\s"]*)$/.exec(value.slice(0, cursor));
    if (!m) return null;
    const items = findFiles(m[2].replace(/^"/, "")).map((f) => ({
      text: `@${/\s/.test(f) ? `"${f}"` : f}${f.endsWith("/") ? "" : " "}`,
      label: f,
      desc: "",
    }));
    return items.length ? { start: cursor - m[2].length - 1, end: cursor, items, submit: false } : null;
  };
}
