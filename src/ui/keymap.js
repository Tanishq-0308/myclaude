import os from "node:os";
import path from "node:path";
import { readJson } from "../config.js";

// Claude Code's ~/.claude/keybindings.json format, for the actions myclaude implements:
// { "bindings": [ { "context": "Chat", "bindings": { "ctrl+e": "chat:externalEditor", "ctrl+l": null } } ] }
// Keys: modifiers ctrl/alt(=meta)/shift + key, chords separated by spaces ("ctrl+x ctrl+k", 3s apart).
const DEFAULTS = {
  Global: {
    "ctrl+o": "app:toggleTranscript",
    "ctrl+t": "app:toggleTodos",
    "ctrl+r": "history:search",
    "ctrl+d": "app:exit",
  },
  Chat: {
    escape: "chat:cancel",
    "shift+tab": "chat:cycleMode",
    "meta+p": "chat:modelPicker",
    enter: "chat:submit",
    "ctrl+j": "chat:newline",
    "shift+enter": "chat:newline",
    "meta+enter": "chat:newline",
    "meta+v": "chat:imagePaste",
    "ctrl+v": "chat:imagePaste",
    "ctrl+l": "chat:clearInput",
    up: "history:previous",
    down: "history:next",
    "ctrl+x ctrl+k": "chat:killAgents",
    "ctrl+g": "chat:externalEditor",
    "ctrl+x ctrl+e": "chat:externalEditor",
  },
  Task: { "ctrl+b": "task:background", "ctrl+x ctrl+b": "task:background" },
  HistorySearch: {
    "ctrl+r": "historySearch:next",
    escape: "historySearch:accept",
    tab: "historySearch:accept",
    enter: "historySearch:execute",
    "ctrl+c": "historySearch:cancel",
  },
};

const MOD = { ctrl: "ctrl", control: "ctrl", alt: "meta", opt: "meta", option: "meta", meta: "meta", shift: "shift" };
const KEY = { esc: "escape", return: "enter" };

// "Ctrl+Alt+K" -> "ctrl+meta+k" (fixed modifier order so lookups match).
function normalize(stroke) {
  const parts = stroke.toLowerCase().split("+");
  const key = parts.pop();
  const mods = new Set(parts.map((p) => MOD[p]).filter(Boolean));
  return [...["ctrl", "meta", "shift"].filter((m) => mods.has(m)), KEY[key] ?? key].join("+");
}

// Ink's (input, key) -> "ctrl+r", "shift+tab", "enter", "a"... (null for plain text input).
export function strokeOf(input, key) {
  const name = key.return ? "enter" : key.escape ? "escape" : key.tab ? "tab" : key.backspace ? "backspace" : key.delete ? "delete"
    : key.upArrow ? "up" : key.downArrow ? "down" : key.leftArrow ? "left" : key.rightArrow ? "right"
    : key.pageUp ? "pageup" : key.pageDown ? "pagedown" : key.home ? "home" : key.end ? "end"
    : input === " " ? "space" : input?.length === 1 ? input.toLowerCase() : null;
  if (!name) return null;
  const shift = key.shift || (input?.length === 1 && input !== input.toLowerCase());
  return [key.ctrl && "ctrl", key.meta && "meta", shift && "shift", name].filter(Boolean).join("+");
}

export function loadKeymap(file = path.join(os.homedir(), ".claude", "keybindings.json")) {
  const ctx = Object.fromEntries(Object.entries(DEFAULTS).map(([c, b]) => [c, new Map(Object.entries(b).map(([k, a]) => [k.split(" ").map(normalize).join(" "), a]))]));
  const user = readJson(file, null);
  for (const block of Array.isArray(user?.bindings) ? user.bindings : []) {
    const map = (ctx[block.context] ??= new Map());
    for (const [keys, action] of Object.entries(block.bindings ?? {})) {
      const k = keys.trim().split(/\s+/).map(normalize).join(" ");
      if (action === null) map.delete(k);
      else if (typeof action === "string") map.set(k, action);
    }
  }
  let pending = null; // first stroke(s) of a chord, with the time it was pressed

  return {
    // Action bound to this stroke in the first matching context (single keys only).
    action(contexts, stroke) {
      if (!stroke) return null;
      for (const c of contexts) {
        const a = ctx[c]?.get(stroke);
        if (a) return a;
      }
      return null;
    },
    // Like action(), but also completes chords. Returns { action } or { pending: true } or null.
    chord(contexts, stroke) {
      if (!stroke) return null;
      const seq = pending && Date.now() - pending.at < 3000 ? `${pending.keys} ${stroke}` : stroke;
      pending = null;
      for (const c of contexts) {
        const map = ctx[c];
        if (!map) continue;
        if (map.has(seq) && seq.includes(" ")) return { action: map.get(seq) };
        if ([...map.keys()].some((k) => k.startsWith(`${seq} `))) {
          pending = { keys: seq, at: Date.now() };
          return { pending: true };
        }
      }
      return null;
    },
    keysFor(action) {
      for (const map of Object.values(ctx)) for (const [k, a] of map) if (a === action) return k;
      return null;
    },
  };
}
