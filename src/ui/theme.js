export const ORANGE = "#D77757";
export const PERI = "#B1B9F9";
export const PINK = "#FD5DB1";

export const MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
export const CYCLE = ["default", "acceptEdits", "plan", "auto"];
export const MODE_INFO = {
  default: { label: "Manual", desc: "Ask before editing files or running commands" },
  acceptEdits: { label: "Accept edits", desc: "Edit files without asking, still ask before commands", footer: "⏵⏵ accept edits on", color: "magenta" },
  plan: { label: "Plan mode", desc: "Read-only: explore first, then show a plan to approve", footer: "⏸ plan mode on", color: "cyan" },
  auto: { label: "Auto mode", desc: "Claude decides; a safety check reviews risky actions", footer: "⏵⏵ auto mode on", color: "yellow" },
  dontAsk: { label: "Don't ask", desc: "Never prompt: anything not already allowed is denied", footer: "⏵⏵ don't ask on", color: "gray" },
  bypassPermissions: { label: "Bypass permissions", desc: "Never ask: everything runs without approval (risky)", footer: "⏵⏵ bypass permissions on", color: "red" },
};

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const EFFORT_ICON = { low: "○", medium: "◐", high: "●", xhigh: "◉", max: "◉" };

// Colours for the /context breakdown, in category order.
export const CONTEXT_COLORS = ["#9CA3AF", "#60A5FA", "#A78BFA", "#F472B6", "#FBBF24", "#34D399", ORANGE, "#22D3EE", "#F87171"];
