import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.7.0";
export const CONFIG_DIR = path.join(os.homedir(), ".myclaude");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const HISTORY_FILE = path.join(CONFIG_DIR, "history.json");

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export const CONFIG_PATH = CONFIG_FILE;
export const loadConfig = () => readJson(CONFIG_FILE, {});
export const saveConfig = (cfg) => writeJson(CONFIG_FILE, cfg);
export const updateConfig = (patch) => saveConfig({ ...loadConfig(), ...patch });

export function loadHistory() {
  const h = readJson(HISTORY_FILE, []);
  return Array.isArray(h) ? h.filter((x) => typeof x === "string") : [];
}

export function saveHistory(list) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(-200)));
  } catch {}
}

export const claudeSettingsEffort = () => readJson(path.join(os.homedir(), ".claude", "settings.json"), {}).effortLevel;
