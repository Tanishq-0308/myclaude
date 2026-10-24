import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

const parsers = new Map();
const cache = new Map();
const BOLD = (s) => `\x1b[1m${s}\x1b[22m`;
const DIM = (s) => `\x1b[90m${s}\x1b[39m`;

function getMarked(width) {
  let m = parsers.get(width);
  if (!m) {
    m = new Marked(markedTerminal({ width: Math.max(40, width), reflowText: true, tab: 2, emoji: false }));
    parsers.set(width, m);
  }
  return m;
}

// ---------- tables (marked-terminal draws them at full width, which breaks narrow terminals) ----------

const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

function splitCells(line) {
  const cells = [];
  let cur = "";
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function plainInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ");
}

function wrap(text, width) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

function renderTable(rows, width) {
  const cols = Math.max(...rows.map((r) => r.length));
  const data = rows.map((r) => Array.from({ length: cols }, (_, i) => plainInline(r[i] ?? "")));
  const natural = Array.from({ length: cols }, (_, c) => Math.max(1, ...data.map((r) => Math.max(...r[c].split("\n").map((l) => l.length)))));
  const available = Math.max(cols * 4, width - (cols * 3 + 1));
  let widths = natural.slice();
  if (natural.reduce((a, b) => a + b, 0) > available) {
    const min = natural.map((n) => Math.min(n, Math.max(6, Math.floor(available / cols / 2))));
    let rest = available - min.reduce((a, b) => a + b, 0);
    const extra = natural.map((n, i) => n - min[i]);
    const totalExtra = extra.reduce((a, b) => a + b, 0) || 1;
    widths = min.map((m, i) => m + Math.floor((extra[i] / totalExtra) * rest));
  }
  const line = (l, m, r) => DIM(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const out = [line("┌", "┬", "┐")];
  data.forEach((row, ri) => {
    const wrapped = row.map((cell, c) => wrap(cell, widths[c]));
    const height = Math.max(...wrapped.map((w) => w.length));
    for (let k = 0; k < height; k++) {
      const parts = wrapped.map((w, c) => {
        const text = (w[k] ?? "").padEnd(widths[c]);
        return ` ${ri === 0 ? BOLD(text) : text} `;
      });
      out.push(DIM("│") + parts.join(DIM("│")) + DIM("│"));
    }
    if (ri < data.length - 1) out.push(line("├", "┼", "┤"));
  });
  out.push(line("└", "┴", "┘"));
  return out.join("\n");
}

function splitTables(md) {
  const lines = md.split("\n");
  const parts = [];
  let buf = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (!inFence && isRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      if (buf.length) parts.push({ md: buf.join("\n") });
      buf = [];
      const rows = [splitCells(lines[i])];
      i += 2;
      while (i < lines.length && isRow(lines[i])) rows.push(splitCells(lines[i++]));
      i--;
      parts.push({ rows });
    } else buf.push(lines[i]);
  }
  if (buf.length) parts.push({ md: buf.join("\n") });
  return parts;
}

export function renderMarkdown(text, width) {
  const key = `${width}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out;
  try {
    out = splitTables(text)
      .map((p) => (p.rows ? renderTable(p.rows, width) : getMarked(width).parse(p.md).replace(/\n+$/, "")))
      .filter((s) => s.length)
      .join("\n\n");
  } catch {
    out = text;
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}
