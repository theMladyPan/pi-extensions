import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";

const MODES = ["plan", "agent", "boss"] as const;
type Mode = (typeof MODES)[number];

const STATUS_KEY = "mode-switch";
const QUOTA = 3;
const READ_MAX = 4096;
const BASH_MAX = 2048;

const MODE_PROMPTS: Record<Mode, string> = {
  plan: [
    "## Active mode: PLAN",
    "You are in PLAN mode. Do not modify files or run side-effecting commands yet.",
    "Gather context with read/grep/find/ls, reason through the problem, and propose a concrete step-by-step plan.",
    "Ask for confirmation before executing changes.",
  ].join("\n"),
  agent: [
    "## Active mode: AGENT",
    "You are in AGENT mode. Act autonomously: implement, run, and verify.",
    "Use the full native toolset. Keep edits minimal and correct.",
  ].join("\n"),
  boss: [
    "## Active mode: BOSS",
    "You are in BOSS mode. Reason and delegate rather than exploring everything yourself.",
    "A soft quota of 3 direct read/bash calls per turn applies. Results beyond the third direct call are discouraged.",
    "Prefer grep/ls/find over read, and avoid exploratory bash. Do not block or refuse tools — stay within the soft quota by planning ahead.",
  ].join("\n"),
};

function modeLabel(mode: Mode): string {
  return mode.toUpperCase();
}

export default function (pi: ExtensionAPI): void {
  let mode: Mode = "agent";
  // Per-turn count of qualifying (read/bash) direct calls in BOSS mode.
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

  // Inject concise mode instructions and reset the per-turn BOSS counter.
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

  // In BOSS mode, truncate successful read/bash text results within the soft quota,
  // and append an avoidance instruction once the quota is exceeded.
  pi.on("tool_result", (event, ctx) => {
    if (mode !== "boss") return;
    if (event.toolName !== "read" && event.toolName !== "bash") return;
    if (event.isError) return;

    const idx = callIndex.get(event.toolCallId) ?? bossCount;
    footer(ctx);

    const max = event.toolName === "read" ? READ_MAX : BASH_MAX;
    const content = event.content;
    let changed = false;
    const updated = content.map((part) => {
      if (part.type !== "text") return part;
      const text = (part as TextContent).text;
      if (idx <= QUOTA) {
        const trimmed = truncateBytes(text, max);
        if (trimmed === text) return part;
        changed = true;
        return {
          ...part,
          text:
            trimmed +
            `\n\n[mode-switch BOSS: direct ${event.toolName} output truncated to ${max} bytes — quota ${idx}/${QUOTA} used.]`,
        };
      }
      // Beyond the soft quota: leave content unmodified, but prompt to avoid it.
      changed = true;
      return {
        ...part,
        text:
          text +
          `\n\n[mode-switch BOSS: direct read/bash quota exceeded (3/3). Do not rely on this output; reason from prior context or use grep/ls/find instead.]`,
      };
    });

    if (!changed) return;
    return { content: updated };
  });
}

/** Truncate a string to at most `max` UTF-8 bytes on a character boundary. */
function truncateBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  let cut = max;
  // Walk back over any UTF-8 continuation bytes so we don't split a character.
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8");
}
