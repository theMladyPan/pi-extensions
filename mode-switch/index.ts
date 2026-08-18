import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const MODES = ["plan", "agent", "boss"] as const;
type Mode = (typeof MODES)[number];

const STATUS_KEY = "mode-switch";
const QUOTA = 3;
const READ_MAX = 4096;
const BASH_MAX = 2048;
const OVER_QUOTA_MAX = 512;
const PLAN_SAFE_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "fetch_content",
  "exa_search",
  "web_search",
  "ask_user_question",
  "questionnaire",
]);

const MODE_PROMPTS: Record<Mode, string> = {
  plan: [
    "## Active mode: PLAN",
    "You are in PLAN mode. Active tools are restricted to read-only discovery.",
    "Gather context, reason through the problem, and propose a concrete step-by-step plan.",
    "Stop after the plan and ask the user to switch to AGENT or BOSS before execution.",
  ].join("\n"),
  agent: [
    "## Active mode: AGENT",
    "You are in AGENT mode. Act autonomously: implement, run, and verify.",
    "Use the full native toolset. Keep edits minimal and correct.",
  ].join("\n"),
  boss: [
    "## Active mode: BOSS",
    "Own the goal, decisions, decomposition, and synthesis. Use the `delegate` tool for bounded repository work instead of broad direct exploration.",
    "Give delegates the relevant goal, evidence and paths, bounded scope, acceptance criteria, constraints, checks, and desired output; do not make them rediscover context you already hold.",
    "Prefer cheap scouts for unknown files and relationships, then delegate one coherent implementation slice. Review and non-conflicting chore work may run in parallel; skip, reorder, or stop stages when evidence warrants it, and avoid ritual loops.",
    `A soft budget of ${QUOTA} direct read/bash calls applies per user request. Use direct tools only for small facts needed to orchestrate or verify delegated work.`,
  ].join("\n"),
};

function modeLabel(mode: Mode): string {
  return mode.toUpperCase();
}

export default function (pi: ExtensionAPI): void {
  let mode: Mode = "agent";
  let toolsBeforePlan: string[] | undefined;
  // Per-request count of qualifying (read/bash) direct calls in BOSS mode.
  let bossCount = 0;
  // Map toolCallId -> call index, assigned when the call fires. Lets a batched
  // result know which quota slot it belongs to even if siblings fired first.
  const callIndex = new Map<string, number>();

  function footer(ctx: ExtensionContext): void {
    if (mode === "boss") {
      ctx.ui.setStatus(STATUS_KEY, `BOSS ${bossCount}/${QUOTA} direct`);
    } else {
      ctx.ui.setStatus(STATUS_KEY, `mode: ${modeLabel(mode)}`);
    }
  }

  function setMode(ctx: ExtensionContext, next: Mode): void {
    if (next === mode) {
      ctx.ui.notify(`Already in ${modeLabel(mode)} mode`, "info");
      return;
    }

    if (next === "plan") {
      toolsBeforePlan = pi.getActiveTools();
      pi.setActiveTools(toolsBeforePlan.filter((name) => PLAN_SAFE_TOOLS.has(name)));
    } else if (mode === "plan" && toolsBeforePlan !== undefined) {
      pi.setActiveTools(toolsBeforePlan);
      toolsBeforePlan = undefined;
    }

    if (next === "boss") {
      bossCount = 0;
      callIndex.clear();
    }

    mode = next;
    ctx.ui.notify(`Mode: ${modeLabel(mode)}`, "info");
    footer(ctx);
  }

  function cycle(ctx: ExtensionContext): void {
    const i = MODES.indexOf(mode);
    setMode(ctx, MODES[(i + 1) % MODES.length]!);
  }

  // Alt+M: cycle plan -> agent -> boss -> plan
  pi.registerShortcut(Key.alt("m"), {
    description: "Cycle agent mode (Plan -> Agent -> Boss)",
    handler: cycle,
  });

  // /mode [plan|agent|boss]
  pi.registerCommand("mode", {
    description: "Switch agent mode (plan | agent | boss). No arg shows the current mode.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) {
        ctx.ui.notify(`Current mode: ${modeLabel(mode)}`, "info");
        return;
      }
      if (!(MODES as readonly string[]).includes(arg)) {
        ctx.ui.notify(`Unknown mode "${arg}". Use: ${MODES.join(", ")}`, "warning");
        return;
      }
      setMode(ctx, arg as Mode);
    },
  });

  // Refresh footer on (re)load and new sessions.
  pi.on("session_start", (_event, ctx) => {
    bossCount = 0;
    callIndex.clear();
    footer(ctx);
  });

  // Inject concise mode instructions and reset the per-request BOSS counter.
  pi.on("before_agent_start", (event, ctx) => {
    if (mode === "boss") {
      bossCount = 0;
      callIndex.clear();
      footer(ctx);
    }
    const prompt = event.systemPrompt;
    const instruction = MODE_PROMPTS[mode];
    return { systemPrompt: `${prompt}\n\n${instruction}` };
  });

  // Count qualifying direct calls (read/bash) in BOSS mode. Never block.
  pi.on("tool_call", (event, ctx) => {
    if (mode !== "boss") return;
    if (event.toolName !== "read" && event.toolName !== "bash") return;
    bossCount += 1;
    callIndex.set(event.toolCallId, bossCount);
    footer(ctx);
  });

  // Limit successful direct read/bash results. Bash keeps the useful tail; reads keep the head.
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "read" && event.toolName !== "bash") return;

    const idx = callIndex.get(event.toolCallId);
    callIndex.delete(event.toolCallId);
    if (mode !== "boss" || idx === undefined || event.isError) return;
    footer(ctx);

    const exceeded = idx > QUOTA;
    const max = exceeded ? OVER_QUOTA_MAX : event.toolName === "read" ? READ_MAX : BASH_MAX;
    const keepTail = event.toolName === "bash";
    const indexes = event.content.map((_, index) => index);
    if (keepTail) indexes.reverse();

    let remaining = max;
    let textParts = 0;
    let truncated = false;
    const replacements = new Map<number, string>();
    for (const index of indexes) {
      const part = event.content[index];
      if (!part || part.type !== "text") continue;
      textParts += 1;
      const text = part.text;
      const trimmed = keepTail ? truncateTailBytes(text, remaining) : truncateHeadBytes(text, remaining);
      remaining -= Buffer.byteLength(trimmed);
      if (trimmed !== text) {
        truncated = true;
        replacements.set(index, trimmed);
      }
    }

    if (!exceeded && (!textParts || !truncated)) return;
    const updated = event.content.map((part, index) => {
      const text = replacements.get(index);
      return text === undefined ? part : { ...part, text };
    });
    const note = exceeded
      ? `[mode-switch BOSS: direct ${event.toolName} budget exceeded (${idx}/${QUOTA}); text output limit ${max} bytes. Delegate further exploration or use a targeted grep/find/ls call.]`
      : `[mode-switch BOSS: direct ${event.toolName} output truncated to ${max} bytes with ${keepTail ? "tail" : "head"} preserved — budget ${idx}/${QUOTA}.]`;

    return { content: [...updated, { type: "text" as const, text: `\n\n${note}` }] };
  });
}

/** Keep at most `max` leading UTF-8 bytes without splitting a character. */
function truncateHeadBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  let cut = max;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8");
}

/** Keep at most `max` trailing UTF-8 bytes without splitting a character. */
function truncateTailBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  let start = buf.length - max;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}
