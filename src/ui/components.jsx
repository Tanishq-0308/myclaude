import React, { useState, useEffect, useRef } from "react";
import fs from "node:fs";
import { Box, Text, useInput, usePaste } from "ink";
import { imagePathFromPaste } from "../clipboard.js";
import { ORANGE, PERI } from "./theme.js";
import { lines, rel, kTokens } from "./format.js";
import { loadKeymap, strokeOf } from "./keymap.js";

export const MOUSE_RE = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;
const isMouse = (input) => {
  const hit = MOUSE_RE.test(input);
  MOUSE_RE.lastIndex = 0;
  return hit;
};
const DEFAULT_KEYMAP = loadKeymap("");

export function Rule({ width, color = "gray" }) {
  return <Text color={color}>{"─".repeat(Math.max(1, width))}</Text>;
}

export function Panel({ color = PERI, title, subtitle, width, children }) {
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Rule width={width} color={color} />
      <Box flexDirection="column" paddingX={2} paddingTop={1}>
        {title ? <Text bold color={color}>{title}</Text> : null}
        {subtitle ? <Text dimColor>{subtitle}</Text> : null}
        <Box flexDirection="column" marginTop={title || subtitle ? 1 : 0}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}

function OptionRow({ index, selected, current, label, labelWidth, desc, multi, checked }) {
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text color={PERI}>{selected ? "❯" : " "}</Text>
      </Box>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={current ? "green" : selected ? PERI : undefined}>
          {`${multi ? (checked ? "[x] " : "[ ] ") : `${index + 1}. `}${label}`}
        </Text>
      </Box>
      <Box width={2} flexShrink={0}>
        <Text color="green">{current ? "✔" : " "}</Text>
      </Box>
      {desc ? (
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor={!selected}>{desc}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// Arrow-key list. Long lists scroll in a window of `limit` rows.
export function Select({ options, onSelect, onCancel, initial = 0, active = true, multi = false, current, limit = 12 }) {
  const [idx, setIdx] = useState(Math.max(0, Math.min(initial, options.length - 1)));
  const [checked, setChecked] = useState(() => new Set());
  useInput(
    (input, key) => {
      if (isMouse(input)) return;
      if (key.upArrow || (key.ctrl && input === "p")) setIdx((i) => (i - 1 + options.length) % options.length);
      else if (key.downArrow || (key.ctrl && input === "n") || (key.tab && !key.shift)) setIdx((i) => (i + 1) % options.length);
      else if (key.escape || (key.ctrl && input === "c")) onCancel?.();
      else if (multi && input === " ") {
        setChecked((c) => {
          const n = new Set(c);
          n.has(idx) ? n.delete(idx) : n.add(idx);
          return n;
        });
      } else if (key.return) {
        if (multi) onSelect([...(checked.size ? checked : new Set([idx]))].sort((a, b) => a - b).map((i) => options[i]));
        else onSelect(options[idx], idx);
      } else if (!multi && options.length <= 9 && /^[1-9]$/.test(input) && Number(input) <= options.length) {
        onSelect(options[Number(input) - 1], Number(input) - 1);
      }
    },
    { isActive: active },
  );
  const labelWidth = Math.min(48, Math.max(...options.map((o) => o.label.length)) + 6);
  const start = Math.max(0, Math.min(idx - Math.floor(limit / 2), options.length - limit));
  const shown = options.slice(start, start + limit);
  return (
    <Box flexDirection="column">
      {start > 0 ? <Text dimColor>{`   ↑ ${start} more`}</Text> : null}
      {shown.map((o, k) => {
        const i = start + k;
        return (
          <OptionRow
            key={i}
            index={i}
            selected={i === idx}
            current={current !== undefined && o.value === current}
            label={o.label}
            labelWidth={labelWidth}
            desc={o.hint}
            multi={multi}
            checked={checked.has(i)}
          />
        );
      })}
      {start + limit < options.length ? <Text dimColor>{`   ↓ ${options.length - start - limit} more`}</Text> : null}
      {multi ? <Text dimColor>Space to select, Enter to confirm</Text> : null}
    </Box>
  );
}

const nextWord = (v, i) => {
  while (i < v.length && !/\s/.test(v[i])) i++;
  while (i < v.length && /\s/.test(v[i])) i++;
  return i;
};
const prevWord = (v, i) => {
  while (i > 0 && /\s/.test(v[i - 1])) i--;
  while (i > 0 && !/\s/.test(v[i - 1])) i--;
  return i;
};

/**
 * Prompt input.
 * - `complete(value, cursor)` may return { start, end, items: [{ text, label, desc }], submit }: Tab (or Enter)
 *   puts the item in place of value[start, end); with `submit`, Enter also sends it.
 * - `api` (a ref) gets { set, get, startSearch, consumed }. `consumed` is set when this input used a key the
 *   app also listens to (esc, ctrl+c), so the app can skip it.
 * - `keymap` (from keymap.js) maps keys to actions; `vim` turns on vim normal/insert modes.
 */
export function TextInput({
  active = true, onSubmit, onEscape, onShiftTab, onChange, placeholder = "", history, complete, allowEmpty = false,
  onSuggestions, onPasteImage, onImagePath, onPasteText, api, ghost, keymap = DEFAULT_KEYMAP, vim = false, onVimMode,
}) {
  const st = useRef({ value: "", cursor: 0, hist: -1, sel: 0, search: null, vim: "insert", op: null, dismissed: null });
  const [, force] = useState(0);
  const s0 = st.current;
  const update = (patch) => {
    const before = st.current.value;
    Object.assign(st.current, patch);
    if (patch.value !== undefined && patch.sel === undefined) st.current.sel = 0;
    if (st.current.value !== before) onChange?.(st.current.value);
    force((x) => x + 1);
  };
  const setVim = (mode) => {
    st.current.vim = mode;
    st.current.op = null;
    onVimMode?.(mode);
    force((x) => x + 1);
  };
  useEffect(() => {
    if (vim) onVimMode?.(st.current.vim);
  }, [vim]);
  const consume = () => {
    if (api?.current) api.current.consumed = true;
  };
  const searchMatches = (q) => {
    const seen = new Set();
    const out = [];
    for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
      const h = history[i];
      if (!seen.has(h) && h.toLowerCase().includes(q.toLowerCase())) {
        seen.add(h);
        out.push(h);
      }
    }
    return out;
  };
  if (api) {
    api.current = {
      ...api.current,
      set: (v) => update({ value: v, cursor: v.length, hist: -1 }),
      get: () => st.current.value,
      startSearch: () => update({ search: { query: "", skip: 0 } }),
    };
  }

  const insert = (s) => {
    const { value, cursor } = st.current;
    update({ value: value.slice(0, cursor) + s + value.slice(cursor), cursor: cursor + s.length });
  };
  const submit = (v) => {
    if (v.trim() && history && history[history.length - 1] !== v) history.push(v);
    update({ value: "", cursor: 0, hist: -1, dismissed: null });
    if (vim) setVim("insert");
    onSubmit(v);
  };
  const accept = (c, item) => {
    const { value } = st.current;
    update({ value: value.slice(0, c.start) + item.text + value.slice(c.end), cursor: c.start + item.text.length });
  };
  const moveHistory = (dir) => {
    const { hist } = st.current;
    if (!history?.length) return;
    let h = (hist === -1 ? history.length : hist) + dir;
    if (h < 0) h = 0;
    if (h >= history.length) return update({ hist: -1, value: "", cursor: 0 });
    update({ hist: h, value: history[h], cursor: history[h].length });
  };
  const attach = async (fn) => {
    const token = await fn();
    if (token) {
      const { value, cursor } = st.current;
      const pad = cursor > 0 && !/\s$/.test(value.slice(0, cursor)) ? " " : "";
      insert(`${pad}${token} `);
    }
  };
  const completion = () => (st.current.dismissed === st.current.value ? null : complete?.(st.current.value, st.current.cursor));

  usePaste(
    (t) => {
      // A terminal can't paste an image, so an image-only clipboard arrives as an empty paste.
      if (!t.trim() && onPasteImage) return void attach(onPasteImage);
      const imgPath = onImagePath ? imagePathFromPaste(t) : null;
      if (imgPath) return void attach(() => onImagePath(imgPath));
      const text = t.replace(/\r\n?/g, "\n");
      const token = onPasteText?.(text);
      if (vim && st.current.vim === "normal") setVim("insert");
      insert(token ? `${token} ` : text);
    },
    { isActive: active },
  );

  const searchKey = (input, key, stroke) => {
    consume();
    const s = st.current.search;
    const matches = searchMatches(s.query);
    const match = matches[Math.min(s.skip, matches.length - 1)];
    const a = keymap.action(["HistorySearch"], stroke);
    if (a === "historySearch:next") return update({ search: { ...s, skip: Math.min(s.skip + 1, Math.max(0, matches.length - 1)) } });
    if (a === "historySearch:accept") return update({ search: null, ...(match ? { value: match, cursor: match.length } : {}) });
    if (a === "historySearch:execute") {
      update({ search: null });
      return match ? submit(match) : undefined;
    }
    if (a === "historySearch:cancel") return update({ search: null });
    if (key.backspace || key.delete) return update({ search: { query: s.query.slice(0, -1), skip: 0 } });
    if (input && !key.ctrl && !key.meta) update({ search: { query: s.query + input, skip: 0 } });
  };

  // Vim normal mode. Returns true when the key was handled.
  const vimNormal = (input, key) => {
    const { value: v, cursor: c, op } = st.current;
    const last = Math.max(0, v.length - 1);
    const del = (from, to, thenInsert) => {
      update({ value: v.slice(0, from) + v.slice(to), cursor: Math.min(from, Math.max(0, v.length - (to - from) - (thenInsert ? 0 : 1))) });
      if (thenInsert) setVim("insert");
    };
    if (op) {
      st.current.op = null;
      if (input === op) return del(0, v.length, op === "c"), true;
      const to = input === "w" ? nextWord(v, c) : input === "$" ? v.length : input === "b" ? prevWord(v, c) : input === "0" ? 0 : null;
      if (to != null) del(Math.min(c, to), Math.max(c, to), op === "c");
      return true;
    }
    if (key.ctrl || key.meta || key.return || key.backspace || key.delete || key.tab || key.upArrow || key.downArrow) return false;
    switch (input) {
      case "h": update({ cursor: Math.max(0, c - 1) }); break;
      case "l": update({ cursor: Math.min(last, c + 1) }); break;
      case "0": case "^": update({ cursor: 0 }); break;
      case "$": update({ cursor: last }); break;
      case "w": update({ cursor: Math.min(last, nextWord(v, c)) }); break;
      case "b": update({ cursor: prevWord(v, c) }); break;
      case "x": if (v) del(c, c + 1); break;
      case "D": del(c, v.length); break;
      case "C": del(c, v.length, true); break;
      case "S": del(0, v.length, true); break;
      case "d": case "c": st.current.op = input; break;
      case "i": setVim("insert"); break;
      case "a": update({ cursor: Math.min(v.length, c + 1) }); setVim("insert"); break;
      case "I": update({ cursor: 0 }); setVim("insert"); break;
      case "A": update({ cursor: v.length }); setVim("insert"); break;
      case "o": update({ value: v + "\n", cursor: v.length + 1 }); setVim("insert"); break;
      case "k": moveHistory(-1); break;
      case "j": moveHistory(1); break;
      default: if (key.leftArrow || key.rightArrow) return false;
    }
    return true;
  };

  const onKey = (input, key) => {
      if (isMouse(input)) return;
      // Text and Enter can arrive from the terminal as one chunk ("/doctor\r"); treat each \r as Enter.
      if (!key.return && input.length > 1 && input.includes("\r")) {
        for (const part of input.split(/(\r)/)) {
          if (part === "\r") onKey("\r", { return: true });
          else if (part) onKey(part, {});
        }
        return;
      }
      const stroke = strokeOf(input, key);
      if (st.current.search) return searchKey(input, key, stroke);
      if (input === "\x1b[Z") return onShiftTab?.();
      if (vim && st.current.vim === "normal" && !key.escape && vimNormal(input, key)) return;
      const { value, cursor, sel } = st.current;
      const c = completion();
      const item = c?.items[Math.min(sel, c.items.length - 1)];
      const a = keymap.action(["Chat"], stroke);

      if (c) {
        if (a === "chat:submit") return c.submit ? submit(item.text.trim()) : accept(c, item);
        if (key.tab && !key.shift) return accept(c, item);
        if (key.upArrow || key.downArrow) return update({ sel: (sel + (key.upArrow ? -1 : 1) + c.items.length) % c.items.length });
        if (key.escape) return consume(), update({ dismissed: value });
      }
      switch (a) {
        case "chat:cycleMode":
          return onShiftTab?.();
        case "chat:imagePaste":
          if (onPasteImage) return void attach(onPasteImage);
          break;
        case "chat:newline":
          return insert("\n");
        case "chat:clearInput":
          return update({ value: "", cursor: 0 });
        case "chat:submit":
          if (value.endsWith("\\") && cursor === value.length) return update({ value: value.slice(0, -1) + "\n", cursor: value.length });
          if (!value.trim() && !allowEmpty) return;
          return submit(value);
        case "chat:cancel":
          if (vim && st.current.vim === "insert") {
            consume();
            update({ cursor: Math.max(0, cursor - 1) });
            return setVim("normal");
          }
          return onEscape?.();
        case "history:previous":
        case "history:next": {
          // In multi-line input, up/down move between lines first.
          const row = value.slice(0, cursor).split("\n").length - 1;
          const rows = value.split("\n");
          const up = a === "history:previous";
          if ((up && row > 0) || (!up && row < rows.length - 1)) {
            const col = cursor - value.lastIndexOf("\n", cursor - 1) - 1;
            const target = up ? row - 1 : row + 1;
            const startOf = rows.slice(0, target).reduce((n, r) => n + r.length + 1, 0);
            return update({ cursor: startOf + Math.min(col, rows[target].length) });
          }
          return moveHistory(up ? -1 : 1);
        }
      }
      if (key.ctrl && input === "c") return;
      if (key.pageUp || key.pageDown) return;
      if (key.tab) {
        if (!value && ghost) update({ value: ghost, cursor: ghost.length });
        return;
      }
      if (key.backspace || key.delete) {
        const token = /\[(?:Image #\d+|Pasted text #\d+ \+\d+ lines)\] ?$/.exec(value.slice(0, cursor));
        if (token) return update({ value: value.slice(0, cursor - token[0].length) + value.slice(cursor), cursor: cursor - token[0].length });
        if (cursor > 0) update({ value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 });
        return;
      }
      if (key.leftArrow) return update({ cursor: Math.max(0, cursor - 1) });
      if (key.rightArrow) {
        if (!value && ghost) return update({ value: ghost, cursor: ghost.length });
        return update({ cursor: Math.min(value.length, cursor + 1) });
      }
      if (key.home || (key.ctrl && input === "a")) return update({ cursor: 0 });
      if (key.end || (key.ctrl && input === "e")) return update({ cursor: value.length });
      if (key.ctrl && input === "u") return update({ value: value.slice(cursor), cursor: 0 });
      if (key.ctrl && input === "k") return update({ value: value.slice(0, cursor) });
      if (key.ctrl && input === "w") {
        const start = prevWord(value, cursor);
        return update({ value: value.slice(0, start) + value.slice(cursor), cursor: start });
      }
      if (key.ctrl || key.meta || key.escape || key.upArrow || key.downArrow) return;
      // Typed text only: drop stray control characters that arrived in the same chunk.
      const text = input.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      if (text) insert(text);
  };
  useInput(onKey, { isActive: active });

  const { value, cursor, sel, search } = s0;
  const c = completion();
  useEffect(() => onSuggestions?.(c ? { items: c.items, sel: Math.min(sel, c.items.length - 1) } : null));

  if (search) {
    const matches = searchMatches(search.query);
    const match = matches[Math.min(search.skip, matches.length - 1)];
    const at = match ? match.toLowerCase().indexOf(search.query.toLowerCase()) : -1;
    return (
      <Text>
        <Text dimColor>{`search prompts: ${search.query}`}</Text>
        <Text inverse> </Text>
        <Text dimColor>{"  "}</Text>
        {match ? (
          <>
            {match.slice(0, at).replace(/\n/g, " ")}
            <Text bold color={ORANGE}>{match.slice(at, at + search.query.length)}</Text>
            {match.slice(at + search.query.length).replace(/\n/g, " ")}
          </>
        ) : (
          <Text dimColor>{search.query ? "no match" : "type to search · ctrl+r older · enter run · esc edit"}</Text>
        )}
      </Text>
    );
  }
  if (value === "") {
    const ph = ghost || placeholder;
    return (
      <Text>
        <Text inverse>{ph ? ph[0] : " "}</Text>
        <Text dimColor>{ph.slice(1)}</Text>
        {ghost ? <Text dimColor>{"  (tab to use)"}</Text> : null}
      </Text>
    );
  }
  const rows = value.split("\n");
  let cl = 0;
  let cc = cursor;
  while (cl < rows.length - 1 && cc > rows[cl].length) {
    cc -= rows[cl].length + 1;
    cl++;
  }
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Text key={i}>
          {i === cl ? (
            <>
              {row.slice(0, cc)}
              <Text inverse>{row[cc] ?? " "}</Text>
              {row.slice(cc + 1)}
            </>
          ) : (
            row || " "
          )}
        </Text>
      ))}
    </Box>
  );
}

const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

export function Spinner({ label, since, tokens }) {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((x) => x + 1), 120);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((Date.now() - since) / 1000);
  const parts = [`${s}s`, tokens ? `↓ ${kTokens(tokens)} tokens` : null, "esc to interrupt"].filter(Boolean);
  return (
    <Box paddingLeft={1}>
      <Text color={ORANGE}>{`${FRAMES[f % FRAMES.length]} ${label}… `}</Text>
      <Text dimColor>{`(${parts.join(" · ")})`}</Text>
    </Box>
  );
}

// ---------- diffs ----------

// Where an edit sits in its file: the line it starts on and up to 2 lines around it. Works before the
// edit (finds old text) and after it (finds new text).
export function editContext(file, oldText, newText) {
  try {
    if (!file || fs.statSync(file).size > 2_000_000) return null;
    const text = fs.readFileSync(file, "utf8");
    for (const s of [oldText, newText]) {
      const i = s ? text.indexOf(s) : -1;
      if (i < 0) continue;
      const all = text.split("\n");
      const startLine = text.slice(0, i).split("\n").length;
      const end = startLine + s.split("\n").length - 1;
      return { startLine, before: all.slice(Math.max(0, startLine - 3), startLine - 1), after: all.slice(end, end + 2) };
    }
  } catch {}
  return null;
}

const DEL_BG = "#5f2a2a";
const ADD_BG = "#2a5f33";

// The changed middle of a line, highlighted (word-level diff against its counterpart).
function DiffText({ text, other, color, bg }) {
  if (other == null) return <Text color={color}>{text}</Text>;
  let p = 0;
  while (p < text.length && p < other.length && text[p] === other[p]) p++;
  let s = 0;
  while (s < text.length - p && s < other.length - p && text[text.length - 1 - s] === other[other.length - 1 - s]) s++;
  const mid = text.slice(p, text.length - s);
  if (!mid || mid.length > text.length * 0.7) return <Text color={color}>{text}</Text>;
  return (
    <Text color={color}>
      {text.slice(0, p)}
      <Text backgroundColor={bg} color="white">{mid}</Text>
      {text.slice(text.length - s)}
    </Text>
  );
}

export function DiffLines({ oldText, newText, max = 12, ctx }) {
  let o = oldText == null ? [] : lines(oldText);
  let n = lines(newText);
  let start = 0;
  while (start < o.length && start < n.length && o[start] === n[start]) start++;
  let end = 0;
  while (end < o.length - start && end < n.length - start && o[o.length - 1 - end] === n[n.length - 1 - end]) end++;
  const common = { head: o.slice(0, start), tail: o.slice(o.length - end) };
  o = o.slice(start, o.length - end);
  n = n.slice(start, n.length - end);
  const pair = o.length === n.length;
  const first = (ctx?.startLine ?? 1) + start;
  const before = [...(ctx?.before ?? []), ...common.head].slice(-2);
  const after = [...common.tail, ...(ctx?.after ?? [])].slice(0, 2);
  const rows = [
    ...before.map((l, i) => [" ", l, first - before.length + i]),
    ...o.map((l, i) => ["-", l, first + i, pair ? n[i] : null]),
    ...n.map((l, i) => ["+", l, first + i, pair ? o[i] : null]),
    ...after.map((l, i) => [" ", l, first + n.length + i]),
  ];
  const width = String(first + Math.max(o.length, n.length) + 2).length;
  const showNumbers = !!ctx || oldText == null;
  return (
    <Box flexDirection="column">
      {rows.slice(0, max).map(([sign, l, num, other], i) => (
        <Text key={i}>
          {showNumbers ? <Text dimColor>{`${String(num).padStart(width)} `}</Text> : null}
          {sign === " " ? (
            <Text dimColor>{`  ${l}`}</Text>
          ) : (
            <>
              <Text color={sign === "-" ? "red" : "green"}>{`${sign} `}</Text>
              <DiffText text={l} other={other} color={sign === "-" ? "red" : "green"} bg={sign === "-" ? DEL_BG : ADD_BG} />
            </>
          )}
        </Text>
      ))}
      {rows.length > max ? <Text dimColor>{`… +${rows.length - max} more lines`}</Text> : null}
    </Box>
  );
}

export function ToolPreview({ name, input }) {
  switch (name) {
    case "Bash":
    case "PowerShell":
      return (
        <Box flexDirection="column">
          <Text>{input.command}</Text>
          {input.description ? <Text dimColor>{input.description}</Text> : null}
        </Box>
      );
    case "Edit":
      return (
        <Box flexDirection="column">
          <Text bold>{rel(input.file_path)}</Text>
          <DiffLines oldText={input.old_string} newText={input.new_string} max={24} ctx={editContext(input.file_path, input.old_string, input.new_string)} />
        </Box>
      );
    case "MultiEdit":
      return (
        <Box flexDirection="column">
          <Text bold>{rel(input.file_path)}</Text>
          {(input.edits ?? []).map((e, i) => (
            <DiffLines key={i} oldText={e.old_string} newText={e.new_string} max={12} ctx={editContext(input.file_path, e.old_string, e.new_string)} />
          ))}
        </Box>
      );
    case "Write":
      return (
        <Box flexDirection="column">
          <Text bold>{rel(input.file_path)}</Text>
          <DiffLines newText={input.content} max={20} />
        </Box>
      );
    case "WebFetch":
      return <Text>{input.url}</Text>;
    default: {
      const json = JSON.stringify(input, null, 2).split("\n");
      return <Text dimColor>{json.slice(0, 15).join("\n") + (json.length > 15 ? `\n… +${json.length - 15} lines` : "")}</Text>;
    }
  }
}
