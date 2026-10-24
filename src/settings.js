import os from "node:os";
import path from "node:path";
import { readJson, writeJson } from "./config.js";

// Claude Code's settings files, which myclaude shares (permissions, hooks, statusLine, ...).
export const SETTINGS = {
  local: { file: () => path.join(process.cwd(), ".claude", "settings.local.json"), label: "This project, just you (.claude/settings.local.json)" },
  project: { file: () => path.join(process.cwd(), ".claude", "settings.json"), label: "This project, shared (.claude/settings.json)" },
  user: { file: () => path.join(os.homedir(), ".claude", "settings.json"), label: "All your projects (~/.claude/settings.json)" },
};

export const readSettings = (scope) => readJson(SETTINGS[scope].file(), {});
export const writeSettings = (scope, data) => writeJson(SETTINGS[scope].file(), data);

export const RULE_KINDS = ["allow", "ask", "deny"];

// Every permission rule with where it comes from.
export function listRules() {
  const out = [];
  for (const scope of Object.keys(SETTINGS)) {
    const p = readSettings(scope).permissions ?? {};
    for (const kind of RULE_KINDS) for (const rule of p[kind] ?? []) out.push({ scope, kind, rule });
  }
  return out;
}

export function addRule(scope, kind, rule) {
  const s = readSettings(scope);
  s.permissions ??= {};
  s.permissions[kind] = [...new Set([...(s.permissions[kind] ?? []), rule])];
  writeSettings(scope, s);
}

export function removeRule(scope, kind, rule) {
  const s = readSettings(scope);
  const list = s.permissions?.[kind] ?? [];
  if (!list.includes(rule)) return false;
  s.permissions[kind] = list.filter((r) => r !== rule);
  writeSettings(scope, s);
  return true;
}

// Hooks from all settings files: [{ scope, event, matcher, command }].
export function listHooks() {
  const out = [];
  for (const scope of Object.keys(SETTINGS)) {
    const s = readSettings(scope);
    if (s.disableAllHooks) out.push({ scope, disabled: true });
    for (const [event, groups] of Object.entries(s.hooks ?? {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of g.hooks ?? []) out.push({ scope, event, matcher: g.matcher || "*", command: h.command ?? h.prompt ?? h.url ?? h.type });
      }
    }
  }
  return out;
}
