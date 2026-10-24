import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";

class MessageQueue {
  items = [];
  waiters = [];
  done = false;
  push(item) {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  end() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function resultText(block) {
  return Array.isArray(block.content)
    ? block.content.filter((x) => x.type === "text").map((x) => x.text).join("\n")
    : String(block.content ?? "");
}

const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));

// Wraps the Agent SDK query loop and turns SDK messages into simple UI events.
export class AgentSession {
  constructor(base, emit) {
    this.base = base;
    this.emit = emit;
    this.model = base.model;
    this.mode = base.permissionMode;
    this.effort = base.effort;
    this.sessionId = null;
    this.info = null;
    this.cost = 0;
    this.dead = true;
    // One entry per prompt sent: its uuid (file checkpoint id) and the last conversation message before it
    // (where the conversation is cut when rewinding to it).
    this.turns = [];
    this.lastChainUuid = null;
  }

  start(extra = {}) {
    this.queue = new MessageQueue();
    this.toolNames = new Map();
    this.streamedIds = new Set();
    this.dead = false;
    this.initResult = null;
    // total_cost_usd counts from this CLI process's start; keep a running total across restarts.
    this.costBase = this.cost;
    this.q = query({
      prompt: this.queue,
      options: { ...this.base, model: this.model, permissionMode: this.mode, effort: this.effort, ...extra },
    });
    this.consume(this.q);
  }

  async consume(q) {
    try {
      for await (const m of q) this.handle(m);
    } catch (e) {
      if (q !== this.q) return;
      this.emit({ type: "error", text: e?.message ?? String(e) });
    }
    if (q !== this.q) return;
    this.dead = true;
    this.finishTurn();
  }

  // content: a string, or an array of content blocks (text + images). text: what the user typed.
  send(content, text = typeof content === "string" ? content : "") {
    if (this.dead) this.start(this.sessionId ? { resume: this.sessionId } : {});
    const uuid = randomUUID();
    this.turns.push({ uuid, before: this.lastChainUuid, text, at: Date.now() });
    this.printedText = false;
    this.turnTokens = 0;
    return new Promise((resolve) => {
      this.turnDone = resolve;
      this.queue.push({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null });
    });
  }

  finishTurn() {
    const done = this.turnDone;
    this.turnDone = null;
    done?.();
  }

  // Commands, agents and models without waiting for the first message.
  async init() {
    if (!this.q) return null;
    this.initResult ??= await this.q.initializationResult().catch(() => null);
    return this.initResult;
  }

  async interrupt() {
    try {
      await this.q?.interrupt();
    } catch {}
  }

  async setModel(model) {
    this.model = model;
    if (!this.dead) await this.q.setModel(model);
  }

  async setMode(mode) {
    this.mode = mode;
    if (!this.dead) await this.q.setPermissionMode(mode);
  }

  async setEffort(effort) {
    this.effort = effort;
    if (!this.dead) await this.q.applyFlagSettings({ effortLevel: effort });
  }

  async models() {
    if (this.modelList?.length) return this.modelList;
    if (this.dead || !this.q) return [];
    this.modelList = (await this.init())?.models ?? (await this.q.supportedModels());
    return this.modelList;
  }

  // Restarts the CLI process on the same conversation, e.g. to pick up new agents or settings.
  reload() {
    this.restart(this.sessionId ? { resume: this.sessionId } : {});
  }

  restart(extra = {}) {
    this.close();
    this.start(extra);
  }

  close() {
    const q = this.q;
    this.q = null;
    this.queue?.end();
    try {
      q?.close();
    } catch {}
    this.dead = true;
    // The old consume() loop exits without finishing the turn once this.q changes, so finish it here
    // or a /clear or /resume during a turn leaves the UI busy forever.
    this.finishTurn();
  }

  // Dry run: which files would change if the code went back to before this turn.
  async previewRewind(turn) {
    try {
      return await this.q?.rewindFiles(turn.uuid, { dryRun: true });
    } catch (e) {
      return { canRewind: false, error: e?.message ?? String(e) };
    }
  }

  async rewind(turn, { code, conversation }) {
    let files = null;
    if (code) {
      files = await this.q.rewindFiles(turn.uuid);
      if (!files.canRewind) throw new Error(files.error ?? "No file changes to restore");
    }
    if (conversation) {
      this.turns = this.turns.slice(0, this.turns.indexOf(turn));
      this.lastChainUuid = turn.before;
      // Fork so the original conversation stays intact on disk (and in /resume).
      if (turn.before && this.sessionId) this.restart({ resume: this.sessionId, resumeSessionAt: turn.before, forkSession: true });
      else {
        this.close();
        this.sessionId = null;
        this.start();
      }
    }
    return files;
  }

  handle(m) {
    this.onRaw?.(m);
    switch (m.type) {
      case "system":
        this.handleSystem(m);
        break;
      case "stream_event":
        this.handleStream(m);
        break;
      case "assistant":
        if (!m.parent_tool_use_id && m.uuid) this.lastChainUuid = m.uuid;
        this.handleAssistant(m);
        break;
      case "user":
        if (!m.parent_tool_use_id && m.uuid && !m.isReplay) this.lastChainUuid = m.uuid;
        this.handleToolResults(m);
        break;
      case "result":
        this.handleResult(m);
        break;
      case "tool_progress":
        this.emit({ type: "tool_progress", id: m.tool_use_id, parent: m.parent_tool_use_id, secs: m.elapsed_time_seconds });
        break;
      case "prompt_suggestion":
        this.emit({ type: "suggestion", text: m.suggestion });
        break;
    }
  }

  handleSystem(m) {
    switch (m.subtype) {
      case "init":
        this.sessionId = m.session_id;
        this.info = m;
        this.emit({ type: "init", info: m });
        break;
      case "compact_boundary": {
        const c = m.compact_metadata ?? {};
        const sizes = c.pre_tokens ? ` (${kTokens(c.pre_tokens)}${c.post_tokens ? ` → ${kTokens(c.post_tokens)}` : ""} tokens)` : "";
        this.emit({ type: "info", text: `✻ Conversation compacted${sizes}` });
        break;
      }
      case "status":
        if (m.permissionMode) {
          this.mode = m.permissionMode;
          this.emit({ type: "mode", mode: m.permissionMode });
        }
        if (m.status === "compacting") this.emit({ type: "status", label: "Compacting conversation" });
        if (m.compact_result === "failed") this.emit({ type: "error", text: `Compaction failed${m.compact_error ? `: ${m.compact_error}` : ""}` });
        break;
      case "api_retry":
        this.emit({
          type: "status",
          label: `Retrying in ${Math.round((m.retry_delay_ms ?? 0) / 1000)}s (attempt ${m.attempt}/${m.max_retries}${m.error_status ? ` · ${m.error_status}` : ""})`,
        });
        break;
      case "task_started":
      case "task_progress":
      case "task_updated":
      case "task_notification":
        this.emit({ type: "task", m });
        break;
      case "background_tasks_changed":
        this.emit({ type: "bg_tasks", tasks: m.tasks ?? [] });
        break;
      case "session_state_changed":
        this.emit({ type: "state", state: m.state });
        break;
      case "commands_changed":
        this.emit({ type: "commands", commands: m.commands ?? [] });
        break;
      case "local_command_output":
        this.emit({ type: "info", text: m.content });
        break;
      case "notification":
        this.emit({ type: "info", text: m.text });
        break;
      case "informational":
        this.emit({ type: m.level === "warning" ? "error" : "info", text: m.content });
        break;
      case "permission_denied":
        this.emit({ type: "info", text: `✗ ${m.tool_name} was blocked${m.decision_reason ? `: ${m.decision_reason}` : ""}` });
        break;
    }
  }

  handleStream(m) {
    if (m.parent_tool_use_id) return;
    const e = m.event;
    if (e.type === "message_start") {
      this.streamedIds.add(e.message?.id);
      this.msgTokens = 0;
    } else if (e.type === "message_delta" && e.usage?.output_tokens) {
      this.turnTokens = (this.turnTokens ?? 0) + e.usage.output_tokens - (this.msgTokens ?? 0);
      this.msgTokens = e.usage.output_tokens;
      this.emit({ type: "tokens", tokens: this.turnTokens });
    } else if (e.type === "content_block_start") {
      if (e.content_block?.type === "thinking") {
        this.emit({ type: "status", label: "Thinking" });
        this.thinking = { text: "", at: Date.now() };
      }
      if (e.content_block?.type === "text") this.textOpen = true;
    } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
      this.printedText = true;
      this.emit({ type: "text_delta", text: e.delta.text });
    } else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta" && this.thinking) {
      this.thinking.text += e.delta.thinking ?? "";
    } else if (e.type === "content_block_stop") {
      if (this.textOpen) this.emit({ type: "text_done" });
      if (this.thinking) this.emit({ type: "thinking", text: this.thinking.text, ms: Date.now() - this.thinking.at });
      this.thinking = null;
      this.textOpen = false;
      this.emit({ type: "status", label: "Working" });
    }
  }

  handleAssistant(m) {
    const parent = m.parent_tool_use_id ?? null;
    const blocks = m.message?.content ?? [];
    if (m.error) {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      this.printedText = true;
      this.emit({ type: "error", text: text || m.error });
      return;
    }
    for (const b of blocks) {
      if (b.type === "thinking" && !parent && !this.streamedIds.has(m.message?.id)) {
        this.emit({ type: "thinking", text: b.thinking ?? "" });
      } else if (b.type === "text" && !parent && !this.streamedIds.has(m.message?.id) && b.text.trim()) {
        this.printedText = true;
        this.emit({ type: "text", text: b.text });
      } else if (b.type === "tool_use") {
        this.toolNames.set(b.id, b.name);
        this.emit({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {}, parent });
      }
    }
  }

  handleToolResults(m) {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type !== "tool_result") continue;
      this.emit({
        type: "tool_result",
        id: b.tool_use_id,
        name: this.toolNames.get(b.tool_use_id),
        text: resultText(b),
        isError: !!b.is_error,
        parent: m.parent_tool_use_id ?? null,
      });
    }
  }

  handleResult(m) {
    this.sessionId = m.session_id;
    if (m.subtype === "success") {
      if (!this.printedText && m.result?.trim()) {
        this.emit({ type: m.is_error ? "error" : "text", text: m.result });
      }
    } else if (m.subtype !== "error_during_execution" || m.errors?.length) {
      const errs = Array.isArray(m.errors) && m.errors.length ? `: ${m.errors.join("; ")}` : "";
      this.emit({ type: "error", text: `${m.subtype}${errs}` });
    }
    if (typeof m.total_cost_usd === "number") this.cost = (this.costBase ?? 0) + m.total_cost_usd;
    this.emit({ type: "result", durationMs: m.duration_ms ?? 0, turns: m.num_turns ?? 0, cost: this.cost });
    this.finishTurn();
  }
}
