import React, { useState, useRef, useEffect } from "react";
import fs from "node:fs";
import { Box, Text, useInput } from "ink";
import { renderMarkdown } from "../markdown.js";
import { openExternal } from "../extras.js";
import { Panel, Select, TextInput, ToolPreview } from "./components.jsx";
import { ORANGE, PERI, EFFORTS, EFFORT_ICON } from "./theme.js";
import { trunc, cap, prettyCommand, mcpName } from "./format.js";

const HINT = "↑/↓ to move · Enter to select · Esc to cancel";

function permissionTitle(name, input) {
  const mcp = mcpName(name);
  if (mcp) return `Use ${mcp.tool} from ${mcp.server} (MCP)`;
  if (name === "Bash") return "Bash command";
  if (name === "PowerShell") return "PowerShell command";
  if (name === "Edit" || name === "MultiEdit") return "Edit file";
  if (name === "Write") return input.file_path && fs.existsSync(input.file_path) ? "Overwrite file" : "Create file";
  if (name === "WebFetch") return "Fetch web page";
  return `Use ${name}`;
}

function alwaysLabel(suggestions, max = 80) {
  const rules = suggestions.find((s) => s.type === "addRules");
  const parts = [];
  if (rules) {
    const r = rules.rules[0] ?? {};
    parts.push(r.ruleContent ? `don't ask again for: ${trunc(prettyCommand(r.ruleContent).replace(/:\*$/, "").replace(/\s\*$/, ""), 36)}` : `don't ask again for ${r.toolName}`);
  }
  if (suggestions.some((s) => s.type === "setMode" && s.mode === "acceptEdits")) parts.push("allow edits this session");
  if (!parts.length && suggestions.some((s) => s.type === "addDirectories")) parts.push("allow access to this folder");
  return trunc(`Yes, and ${parts.join(", ") || "don't ask again"}`, max);
}

function FeedbackInput({ prompt, hint, placeholder, onBack, onSubmit }) {
  return (
    <>
      <Text>
        {prompt} <Text dimColor>{hint}</Text>
      </Text>
      <Box marginTop={1}>
        <Text>{"❯ "}</Text>
        <TextInput allowEmpty placeholder={placeholder} onEscape={onBack} onSubmit={onSubmit} />
      </Box>
    </>
  );
}

function PermissionDialog({ d, width, onModeChange }) {
  const [stage, setStage] = useState("choose");
  const suggestions = d.opts?.suppressAlwaysAllowRule ? [] : (d.opts?.suggestions ?? []);
  const options = [{ label: "Yes", value: "yes" }];
  if (suggestions.length) options.push({ label: alwaysLabel(suggestions, Math.max(30, width - 30)), value: "always" });
  options.push({ label: "No, and tell Claude what to do differently", hint: "(esc)", value: "no" });
  const stop = () => d.resolve({ behavior: "deny", message: "The user declined this action. Stop and wait for their instructions.", interrupt: true });
  const agent = d.opts?.agentID ? " (from a subagent)" : "";

  return (
    <Panel color="yellow" title={permissionTitle(d.toolName, d.input) + agent} subtitle={d.opts?.decisionReason} width={width}>
      <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
        <ToolPreview name={d.toolName} input={d.input} />
      </Box>
      {stage === "choose" ? (
        <>
          <Text>Do you want to proceed?</Text>
          <Select
            options={options}
            initial={d.opts?.defaultToNo ? options.length - 1 : 0}
            onCancel={stop}
            onSelect={(o) => {
              if (o.value === "yes") d.resolve({ behavior: "allow", updatedInput: d.input });
              else if (o.value === "always") {
                for (const s of suggestions) if (s.type === "setMode") onModeChange(s.mode);
                d.resolve({ behavior: "allow", updatedInput: d.input, updatedPermissions: suggestions });
              } else setStage("feedback");
            }}
          />
          <Box marginTop={1}>
            <Text dimColor>{HINT}</Text>
          </Box>
        </>
      ) : (
        <FeedbackInput
          prompt="What should Claude do instead?"
          hint="(Enter to just stop · Esc to go back)"
          placeholder="Type your instructions…"
          onBack={() => setStage("choose")}
          onSubmit={(t) => (t.trim() ? d.resolve({ behavior: "deny", message: `The user declined this action and said: ${t.trim()}` }) : stop())}
        />
      )}
    </Panel>
  );
}

function QuestionDialog({ d, width }) {
  const questions = d.input.questions ?? [];
  const [qi, setQi] = useState(0);
  const [typing, setTyping] = useState(false);
  const answers = useRef({});
  const q = questions[qi];
  const cancel = () => d.resolve({ behavior: "deny", message: "The user dismissed the question.", interrupt: true });
  useEffect(() => {
    if (!q) cancel();
  }, [q]);
  if (!q) return null;
  const answer = (value) => {
    answers.current[q.question] = value;
    setTyping(false);
    if (qi + 1 < questions.length) setQi(qi + 1);
    else d.resolve({ behavior: "allow", updatedInput: { questions, answers: answers.current } });
  };
  const options = [
    ...q.options.map((o) => ({ label: o.label, hint: o.description, value: o.label })),
    ...(q.multiSelect ? [] : [{ label: "Type something else…", value: "__other" }]),
  ];
  const header = q.header ? `${q.header}${questions.length > 1 ? ` (${qi + 1}/${questions.length})` : ""}` : undefined;
  return (
    <Panel color="magenta" title={q.question} subtitle={header} width={width}>
      {typing ? (
        <Box>
          <Text>{"❯ "}</Text>
          <TextInput placeholder="Type your answer…" onEscape={() => setTyping(false)} onSubmit={(t) => answer(t.trim())} />
        </Box>
      ) : (
        <Select
          key={qi}
          multi={!!q.multiSelect}
          options={options}
          onCancel={cancel}
          onSelect={(o) => {
            if (Array.isArray(o)) return answer(o.map((x) => x.value).join(", "));
            if (o.value === "__other") return setTyping(true);
            answer(o.value);
          }}
        />
      )}
      <Box marginTop={1}>
        <Text dimColor>{HINT}</Text>
      </Box>
    </Panel>
  );
}

function PlanDialog({ d, width, onModeChange }) {
  const [stage, setStage] = useState("choose");
  const options = [
    { label: "Yes, and auto-accept edits", value: "acceptEdits" },
    { label: "Yes, and manually approve edits", value: "default" },
    { label: "No, keep planning", hint: "(esc)", value: "no" },
  ];
  const keep = (msg) => d.resolve({ behavior: "deny", message: msg || "The user wants you to keep planning." });
  return (
    <Panel color="cyan" title="Ready to code?" subtitle="Here is Claude's plan:" width={width}>
      <Box borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
        <Text>{renderMarkdown(d.input.plan ?? "", width - 10)}</Text>
      </Box>
      {stage === "choose" ? (
        <>
          <Text>Would you like to proceed?</Text>
          <Select
            options={options}
            onCancel={() => setStage("feedback")}
            onSelect={(o) => {
              if (o.value === "no") return setStage("feedback");
              onModeChange(o.value);
              d.resolve({ behavior: "allow", updatedInput: d.input, updatedPermissions: [{ type: "setMode", mode: o.value, destination: "session" }] });
            }}
          />
        </>
      ) : (
        <FeedbackInput
          prompt="What should Claude change in the plan?"
          hint="(Enter to just keep planning)"
          placeholder="Type your feedback…"
          onBack={() => setStage("choose")}
          onSubmit={(t) => keep(t.trim() ? `The user wants changes to the plan: ${t.trim()}` : "")}
        />
      )}
    </Panel>
  );
}

function SelectDialog({ d, width }) {
  return (
    <Panel color={d.color ?? PERI} title={d.title} subtitle={d.subtitle} width={width}>
      <Select options={d.options} initial={d.initial ?? 0} current={d.current} onCancel={() => d.resolve(null)} onSelect={(o) => d.resolve(o.value)} />
      <Box marginTop={1}>
        <Text dimColor>{d.footer ?? "Enter to select · Esc to cancel"}</Text>
      </Box>
    </Panel>
  );
}

function InputDialog({ d, width }) {
  return (
    <Panel color={d.color ?? PERI} title={d.title} subtitle={d.subtitle} width={width}>
      <Box>
        <Text>{"❯ "}</Text>
        <TextInput placeholder={d.placeholder ?? ""} onEscape={() => d.resolve(null)} onSubmit={(t) => d.resolve(t.trim() || null)} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter to confirm · Esc to cancel</Text>
      </Box>
    </Panel>
  );
}

function ModelDialog({ d, width }) {
  const models = d.models;
  const [idx, setIdx] = useState(Math.max(0, models.findIndex((m) => m.value === d.current)));
  const [effort, setEffort] = useState(d.effort);
  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + models.length) % models.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % models.length);
    else if (key.leftArrow) setEffort((e) => EFFORTS[Math.max(0, EFFORTS.indexOf(e) - 1)]);
    else if (key.rightArrow) setEffort((e) => EFFORTS[Math.min(EFFORTS.length - 1, EFFORTS.indexOf(e) + 1)]);
    else if (key.escape || (key.ctrl && input === "c")) d.resolve(null);
    else if (key.return) d.resolve({ model: models[idx].value, effort, save: true });
    else if (input === "s") d.resolve({ model: models[idx].value, effort, save: false });
    else if (/^[1-9]$/.test(input) && models[Number(input) - 1]) setIdx(Number(input) - 1);
  });
  const labelWidth = Math.max(...models.map((m) => m.displayName.length)) + 6;
  const currentResolved = models.find((m) => m.value === d.current)?.resolvedModel;
  return (
    <Panel
      color={PERI}
      title="Select model"
      subtitle="Switch between Claude models. Your pick becomes the default for new sessions. For other model names, use /model <name>."
      width={width}
    >
      {models.map((m, i) => {
        const [name, ...rest] = (m.description ?? "").split(" · ");
        const current = m.value === d.current;
        const selected = i === idx;
        return (
          <Box key={m.value}>
            <Box width={2} flexShrink={0}>
              <Text color={PERI}>{selected ? "❯" : " "}</Text>
            </Box>
            <Box width={labelWidth} flexShrink={0}>
              <Text color={current ? "green" : selected ? PERI : undefined}>{`${i + 1}. ${m.displayName}`}</Text>
            </Box>
            <Box width={2} flexShrink={0}>
              <Text color="green">{current ? "✔" : " "}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text>
                <Text color={m.resolvedModel === currentResolved ? ORANGE : undefined}>{name}</Text>
                {rest.length ? ` · ${rest.join(" · ")}` : ""}
              </Text>
            </Box>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text>
          <Text color={ORANGE}>{`${EFFORT_ICON[effort]} `}</Text>
          {`${cap(effort)} effort${effort === d.defaultEffort ? " (default)" : ""} `}
          <Text dimColor>←/→ to adjust</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter to set as default · s to use this session only · Esc to cancel</Text>
      </Box>
    </Panel>
  );
}

// ---------- MCP elicitation: a server asks for a link to be opened or for form input ----------

function choicesOf(p) {
  const src = p.type === "array" ? (p.items ?? {}) : p;
  if (Array.isArray(src.enum)) return src.enum.map((v, i) => ({ value: v, label: String(src.enumNames?.[i] ?? v) }));
  const one = src.oneOf ?? src.anyOf;
  if (Array.isArray(one)) return one.map((o) => ({ value: o.const, label: String(o.title ?? o.const) }));
  return null;
}

function ElicitDialog({ d, width }) {
  const r = d.req;
  const req = new Set(r.requestedSchema?.required ?? []);
  const fields = Object.entries(r.requestedSchema?.properties ?? {}).map(([key, p]) => ({ key, p, required: req.has(key) }));
  const [fi, setFi] = useState(0);
  const [err, setErr] = useState(null);
  const values = useRef({});
  const who = `${r.displayName ?? r.serverName} (MCP)`;
  const decline = () => d.resolve({ action: "decline" });

  if (r.mode === "url") {
    return (
      <Panel color="cyan" title={r.title ?? `${who} wants you to open a link`} subtitle={r.message} width={width}>
        <Text color="cyan">{r.url}</Text>
        <Box marginTop={1}>
          <Select
            options={[
              { value: "open", label: "Open in browser" },
              { value: "accept", label: "Continue without opening", hint: "if you opened it yourself" },
              { value: "decline", label: "Decline", hint: "(esc)" },
            ]}
            onCancel={decline}
            onSelect={(o) => {
              if (o.value === "decline") return decline();
              if (o.value === "open") openExternal(r.url);
              d.resolve({ action: "accept" });
            }}
          />
        </Box>
      </Panel>
    );
  }

  const f = fields[fi];
  const next = (v) => {
    if (v !== undefined) values.current[f.key] = v;
    setErr(null);
    if (fi + 1 < fields.length) setFi(fi + 1);
    else d.resolve({ action: "accept", content: values.current });
  };
  let body;
  if (!f) {
    body = (
      <Select
        options={[{ value: "accept", label: "Accept" }, { value: "decline", label: "Decline", hint: "(esc)" }]}
        onCancel={decline}
        onSelect={(o) => (o.value === "accept" ? d.resolve({ action: "accept", content: {} }) : decline())}
      />
    );
  } else {
    const choices = f.p.type === "boolean" ? [{ value: true, label: "Yes" }, { value: false, label: "No" }] : choicesOf(f.p);
    const skip = f.required ? [] : [{ value: "__skip", label: "Skip", hint: "optional" }];
    body = choices ? (
      <Select
        key={fi}
        multi={f.p.type === "array"}
        initial={Math.max(0, choices.findIndex((c) => c.value === f.p.default))}
        options={[...choices, ...(f.p.type === "array" ? [] : skip)]}
        onCancel={decline}
        onSelect={(o) => (Array.isArray(o) ? next(o.map((x) => x.value)) : next(o.value === "__skip" ? undefined : o.value))}
      />
    ) : (
      <Box>
        <Text>{"❯ "}</Text>
        <TextInput
          key={fi}
          allowEmpty
          placeholder={f.p.default != null ? String(f.p.default) : f.p.format ?? f.p.type ?? ""}
          onEscape={decline}
          onSubmit={(t) => {
            t = t.trim() || (f.p.default != null ? String(f.p.default) : "");
            if (!t) return f.required ? setErr("This field is required") : next(undefined);
            if (f.p.type === "number" || f.p.type === "integer") {
              const n = Number(t);
              if (Number.isNaN(n) || (f.p.type === "integer" && !Number.isInteger(n))) return setErr(`Enter ${f.p.type === "integer" ? "a whole number" : "a number"}`);
              return next(n);
            }
            next(t);
          }}
        />
      </Box>
    );
  }
  return (
    <Panel color="cyan" title={r.title ?? `${who} needs some information`} subtitle={r.message} width={width}>
      {f ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{`${f.p.title ?? f.key}${f.required ? "" : " (optional)"}${fields.length > 1 ? `  ${fi + 1}/${fields.length}` : ""}`}</Text>
          {f.p.description ? <Text dimColor>{f.p.description}</Text> : null}
        </Box>
      ) : null}
      {body}
      {err ? <Text color="red">{err}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>Enter to confirm · Esc to decline</Text>
      </Box>
    </Panel>
  );
}

export function Dialog({ d, width, onModeChange }) {
  switch (d.kind) {
    case "permission":
      return <PermissionDialog key={d.opts?.toolUseID ?? "p"} d={d} width={width} onModeChange={onModeChange} />;
    case "question":
      return <QuestionDialog d={d} width={width} />;
    case "plan":
      return <PlanDialog d={d} width={width} onModeChange={onModeChange} />;
    case "select":
      return <SelectDialog key={d.title} d={d} width={width} />;
    case "input":
      return <InputDialog key={d.title} d={d} width={width} />;
    case "model":
      return <ModelDialog d={d} width={width} />;
    case "elicit":
      return <ElicitDialog d={d} width={width} />;
    default:
      return null;
  }
}
