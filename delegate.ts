import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  ModelSelectorComponent,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL = "z-ai/glm-5.2";
const CONFIG_PATH = join(getAgentDir(), "delegate.json");

type DelegateConfigKey = "scoutChore" | "review" | "implement";
interface DelegateRoleModelSetting {
  provider: string;
  model: string;
}
interface DelegateConfig {
  scoutChore?: string | DelegateRoleModelSetting;
  review?: string | DelegateRoleModelSetting;
  implement?: string | DelegateRoleModelSetting;
}

function parseRoleSetting(v: unknown): DelegateRoleModelSetting | undefined {
  if (typeof v === "string" && v.trim()) {
    return { provider: DEFAULT_PROVIDER, model: v.trim() };
  }
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.provider === "string" && obj.provider.trim() && typeof obj.model === "string" && obj.model.trim()) {
      return { provider: obj.provider.trim(), model: obj.model.trim() };
    }
  }
  return undefined;
}

/** Missing or malformed config silently falls back to no saved defaults. */
async function loadDelegateConfig(): Promise<DelegateConfig> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out: DelegateConfig = {};
    for (const key of ["scoutChore", "review", "implement"] as const) {
      const setting = parseRoleSetting((parsed as Record<string, unknown>)[key]);
      if (setting) out[key] = setting;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist config; caller surfaces errors as a short UI notification. */
async function saveDelegateConfig(config: DelegateConfig): Promise<void> {
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function roleConfigKey(role: Role): DelegateConfigKey {
  return role === "scout" || role === "chore" ? "scoutChore" : role;
}

const FETCH_CONTENT_EXTENSION = join(getAgentDir(), "extensions/fetch-content/index.ts");
const PONYTAIL_EXTENSION = join(
  getAgentDir(),
  "npm/node_modules/@dietrichgebert/ponytail/pi-extension/index.js",
);
const WEB_TOOLS = ["fetch_content"];
const READ_TOOLS = ["read", "bash", "grep", "find", "ls", ...WEB_TOOLS];
const WRITE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", ...WEB_TOOLS];
const STDERR_LIMIT = 32 * 1024;

type Role = "scout" | "implement" | "review" | "chore";
type Limit = "timeout" | "turns" | "cost";
type Status = "running" | "completed" | "limited" | "cancelled" | "failed";

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface DelegateDetails {
  status: Status;
  limit?: Limit;
  role: Role;
  task: string;
  cwd: string;
  provider?: string;
  model?: string;
  thinking: string;
  turns: number;
  usage: Usage;
  exitCode: number | null;
  changedFiles: string[];
  completedTools: string[];
  stderr?: string;
  advisory?: string;
}

const ROLE_CONFIG: Record<Role, { tools: string[]; thinking: string; prompt: string }> = {
  scout: {
    tools: READ_TOOLS,
    thinking: "medium",
    prompt: [
      "Primary job: reduce later agents' context cost by answering the assigned discovery question without modifying files.",
      "Suggested approach, adapt as needed: locate narrowly -> trace relevant entry points, callers, data/control flow, tests, configuration, and repository instructions -> verify -> compress.",
      "Return a dense handoff: direct answer, observed evidence with exact paths and symbols or lines, important relationships and constraints, uncertainties, and the smallest sensible next task when useful.",
      "Separate evidence from inference; never invent details. Challenge a requested plan when repository evidence shows it is incomplete, unsafe, or aimed at the wrong place.",
    ].join("\n"),
  },
  implement: {
    tools: WRITE_TOOLS,
    thinking: "high",
    prompt: [
      "Primary job: complete one coherent, bounded change that advances the stated goal.",
      "Suggested approach, adapt as needed: verify scope against repository evidence -> inspect the relevant flow, callers, tests, and conventions -> make the smallest root-cause change -> run focused checks.",
      "Reuse existing patterns and preserve unrelated work. Essential adjacent edits are allowed when correctness or validation requires them; explain material scope changes.",
      "If the requested approach conflicts with the goal or repository evidence, stop before consequential edits, show why, and recommend a corrected bounded assignment rather than forcing the implementation.",
    ].join("\n"),
  },
  review: {
    tools: READ_TOOLS,
    thinking: "high",
    prompt: [
      "Primary job: independently judge the requested artifact or diff against the stated goal, acceptance criteria, repository behavior, and expected quality without modifying files.",
      "Suggested approach, adapt as needed: recover the intended contract -> inspect the artifact plus relevant callers and tests -> test important claims -> report only evidence-backed results.",
      "Check correctness, regressions, security or data-loss risks, missing validation, and avoidable complexity. Report actionable findings by severity with path and line, impact, and the smallest credible fix; distinguish blockers from suggestions.",
      "Challenge a flawed assignment or goal mismatch even when the code follows its literal wording. If there are no findings, say so and mention only material unverified or residual risks.",
    ].join("\n"),
  },
  chore: {
    tools: WRITE_TOOLS,
    thinking: "medium",
    prompt: [
      "Primary job: execute bounded supporting repository work such as tests, checks, formatting, documentation, configuration, or maintenance.",
      "Suggested approach, adapt as needed: inspect the target and relevant behavior -> perform the smallest useful support task -> run focused checks -> report exact results.",
      "For tests, assert externally observable behavior and the relevant failure mode rather than implementation details. Do not mask a production defect or rewrite behavior merely to make a check pass.",
      "A small adjacent correction is allowed when safe and essential to the chore; explain it. Otherwise report the defect and propose a targeted implement fix.",
    ].join("\n"),
  },
};

const DelegateParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description:
      "A self-contained task packet with the relevant goal, bounded scope or question, known context, acceptance criteria, constraints, checks, and desired output",
  }),
  role: StringEnum(["scout", "implement", "review", "chore"] as const, {
    description: "Dominant role controlling available tools and guidance; workflows may skip or reorder roles",
  }),
  cwd: Type.Optional(Type.String({ description: "Child working directory; defaults to the current directory" })),
  provider: Type.Optional(
    Type.String({ description: `Pi provider override; default with no model override: ${DEFAULT_PROVIDER}` }),
  ),
  model: Type.Optional(
    Type.String({ description: `Pi model override; default with no provider override: ${DEFAULT_MODEL}` }),
  ),
  thinking: Type.Optional(
    StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
      description: "Thinking override; otherwise uses the selected role default",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 86400, description: "Wall-clock limit; preserves completed filesystem work" }),
  ),
  maxTurns: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 1000, description: "Stop before starting work beyond this many turns" }),
  ),
  maxCostUsd: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, description: "Best-effort cost cap based on provider-reported usage" }),
  ),
});

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, usage: Partial<Usage> | undefined): void {
  if (!usage) return;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
  total.cost.input += usage.cost?.input ?? 0;
  total.cost.output += usage.cost?.output ?? 0;
  total.cost.cacheRead += usage.cost?.cacheRead ?? 0;
  total.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
  total.cost.total += usage.cost?.total ?? 0;
}

function getText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function appendTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return Buffer.byteLength(combined) <= STDERR_LIMIT ? combined : combined.slice(-STDERR_LIMIT);
}

function describeTool(name: string, args: Record<string, unknown>): string {
  if (name === "read" || name === "edit" || name === "write") {
    return `${name} ${String(args.path ?? args.file_path ?? "")}`.trim();
  }
  if (name === "bash") {
    const command = String(args.command ?? "").replace(/\s+/g, " ");
    return `$ ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`;
  }
  if (name === "grep") return `grep ${String(args.pattern ?? "")}`;
  if (name === "find") return `find ${String(args.pattern ?? "*")}`;
  return name;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function usageLine(u: Usage, turns: number): string {
  const parts: string[] = [`${turns} turn${turns === 1 ? "" : "s"}`];
  if (u.input) parts.push(`↑${formatTokens(u.input)}`);
  if (u.output) parts.push(`↓${formatTokens(u.output)}`);
  if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
  if (u.cost.total) parts.push(`$${u.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}

function statusIcon(theme: any, status: Status): string {
  switch (status) {
    case "running":
      return theme.fg("warning", "⏳");
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "limited":
      return theme.fg("warning", "◐");
    case "cancelled":
      return theme.fg("muted", "⏸");
  }
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

async function truncateOutput(output: string): Promise<string> {
  const truncated = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncated.truncated) return output;
  const directory = await mkdtemp(join(tmpdir(), "pi-delegate-"));
  const outputPath = join(directory, "output.txt");
  await writeFile(outputPath, output, { encoding: "utf8", mode: 0o600 });
  return `${truncated.content}\n\n[Output truncated to ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}. Full output: ${outputPath}]`;
}

function buildPrompt(role: Role): string {
  return [
    `You are a delegated ${role} agent running non-interactively.`,
    "Your role is a center of gravity, not a rigid script. Stay focused and use only available tools. Do adjacent analysis or work that your role permits when necessary for a correct result, and explain material deviations.",
    ROLE_CONFIG[role].prompt,
    "First test the assignment against its stated goal and repository evidence. If it is contradictory, unsafe, wrongly scoped, or based on a false premise, do not blindly execute it: explain why with evidence and propose a better bounded assignment. Complete a clearly safe portion only when it will not hide the blocker.",
    "Do not ask the user questions; you cannot interact. Resolve minor reversible ambiguity with the safest reasonable assumption and state it. For consequential ambiguity or a product or architecture decision, stop and return the blocker, evidence, options, and your recommendation to the parent agent.",
    "Follow repository instructions and preserve unrelated work. Use web tools only when repository evidence is insufficient. Follow Ponytail: understand first, then use the smallest solution that works.",
    "Follow any output form requested by the task. Otherwise answer free-form and concise, including only relevant results, evidence, changed files, checks, assumptions, or blockers. Do not add empty headings or speculative follow-up.",
  ].join("\n");
}

export default function delegateExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Run one bounded repository task in an isolated non-interactive Pi subprocess. Roles are centers of gravity: scout, implement, review, chore. Supports provider/model/thinking overrides and optional timeout, turn, and best-effort cost limits. Limit events preserve completed filesystem changes and return partial progress for reassignment.",
    promptSnippet:
      "Delegate context-dense, bounded work to cheaper isolated Pi agents; orchestrate flexibly and avoid ritual loops",
    promptGuidelines: [
      "The master owns the end goal, product and architecture decisions, decomposition, and synthesis. Delegate work, not accountability, to the cheapest role and model likely to succeed.",
      "Make each task a self-contained, context-dense packet using the relevant goal and why, exact question or one coherent work slice, known evidence and paths, acceptance criteria, constraints and non-goals, checks, and desired output. Pass context you already know instead of making the child rediscover it.",
      "Treat roles as centers of gravity, not rigid stages: scout maps unknown files and relationships; implement changes one coherent slice; review checks an artifact against the goal and expected quality; chore handles separable tests, checks, docs, and maintenance. A child may challenge a bad assignment; inspect its evidence and reframe instead of forcing compliance.",
      "Suggested coding flow, not a required loop: scout when locations or relationships are unclear -> implement a bounded slice -> run review and, when useful, a non-conflicting chore for tests or checks in parallel -> request one targeted implement fix for concrete findings. Skip, reorder, or stop when the task or evidence warrants it; avoid ritual agent rotation and repeated review/fix loops.",
      "Prefer cheap scouts for distinct discovery questions and consolidate their findings before expensive implementation. Examples: investigation -> scout only; known small edit -> implement plus focused check; existing diff -> review plus optional parallel chore; test-only work -> chore. Keep consequential product or architecture choices with the master, though scouts and reviewers can gather evidence or compare options.",
      "When a delegate stops on consequential ambiguity, returns limited partial work, or shows that the assignment conflicts with repository evidence, inspect its evidence and preserved work, then decide directly or issue a narrower corrected task.",
    ],
    parameters: DelegateParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const role = params.role as Role;
      const config = ROLE_CONFIG[role];
      const fetchContentPresent = existsSync(FETCH_CONTENT_EXTENSION);
      const ponytailPresent = existsSync(PONYTAIL_EXTENSION);
      const missing: string[] = [];
      if (!fetchContentPresent) missing.push("fetch_content (fetch-content/index.ts not found)");
      if (!ponytailPresent) missing.push("ponytail (@dietrichgebert/ponytail not found; install with `pi install npm:@dietrichgebert/ponytail`)");
      const advisory = missing.length ? `Running without ${missing.join("; ")}.` : undefined;

      const rawCwd = params.cwd?.replace(/^@/, "") ?? ctx.cwd;
      const cwd = isAbsolute(rawCwd) ? resolve(rawCwd) : resolve(ctx.cwd, rawCwd);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Delegate cwd is not a directory: ${cwd}`);

      const tools = fetchContentPresent ? config.tools : config.tools.filter((t) => !WEB_TOOLS.includes(t));
      const thinking = params.thinking ?? config.thinking;
      const savedSetting = parseRoleSetting((await loadDelegateConfig())[roleConfigKey(role)]);
      const args = [
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-extensions",
        "--tools",
        tools.join(","),
        "--thinking",
        thinking,
        ctx.isProjectTrusted() && (cwd.startsWith(`${resolve(ctx.cwd)}/`) || cwd === resolve(ctx.cwd))
          ? "--approve"
          : "--no-approve",
      ];
      if (fetchContentPresent) args.push("--extension", FETCH_CONTENT_EXTENSION);
      if (ponytailPresent) args.push("--extension", PONYTAIL_EXTENSION);

      // Saved model names are provider-specific: never pair an explicit provider
      // with a saved role model. Explicit model wins; saved model applies only
      // when neither explicit model nor provider is given; defaults fill the rest.
      let effectiveProvider = params.provider;
      let effectiveModel = params.model;
      if (!params.provider && !params.model) {
        if (savedSetting) {
          effectiveProvider = savedSetting.provider;
          effectiveModel = savedSetting.model;
        }
      }
      if (!effectiveProvider && !effectiveModel) {
        effectiveProvider = DEFAULT_PROVIDER;
        effectiveModel = DEFAULT_MODEL;
      }
      if (effectiveProvider) args.push("--provider", effectiveProvider);
      if (effectiveModel) args.push("--model", effectiveModel);
      args.push("--append-system-prompt", buildPrompt(role), params.task);

      const usage = emptyUsage();
      const changedFiles = new Set<string>();
      const completedTools: string[] = [];
      const pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>();
      let turns = 0;
      let latestText = "";
      let stderr = "";
      let model: string | undefined;
      let provider: string | undefined;
      let lastStopReason: string | undefined;
      let limit: Limit | undefined;
      let cancelled = false;
      let spawnError: Error | undefined;
      let proc: ChildProcess | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let emitTimer: NodeJS.Timeout | undefined;

      const makeDetails = (status: Status, exitCode: number | null): DelegateDetails => ({
        status,
        limit,
        role,
        task: params.task,
        cwd,
        provider,
        model,
        thinking,
        turns,
        usage,
        exitCode,
        changedFiles: [...changedFiles],
        completedTools: [...completedTools],
        ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
        ...(advisory ? { advisory } : {}),
      });

      const flushUpdate = () => {
        if (emitTimer) {
          clearTimeout(emitTimer);
          emitTimer = undefined;
        }
        onUpdate?.({
          content: [{ type: "text", text: latestText || "(running...)" }],
          details: makeDetails("running", null),
        });
      };
      const scheduleUpdate = () => {
        if (emitTimer) return;
        emitTimer = setTimeout(() => {
          emitTimer = undefined;
          flushUpdate();
        }, 60);
        emitTimer.unref();
      };

      const stop = (reason: Limit | "cancelled") => {
        if (limit || cancelled) return;
        if (reason === "cancelled") cancelled = true;
        else limit = reason;

        const status = reason === "cancelled" ? "cancelled" : "limited";
        const message =
          reason === "cancelled"
            ? "Delegate cancelled; completed filesystem work was preserved."
            : `Delegate ${reason} limit reached; stopping child and preserving completed filesystem work.`;
        const details = makeDetails(status, null);
        onUpdate?.({ content: [{ type: "text", text: message }], details });
        if (reason !== "cancelled") pi.events.emit("delegate:limit", { toolCallId, ...details });
        proc?.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (proc?.exitCode === null) proc.kill("SIGKILL");
        }, 5000);
        forceKillTimer.unref();
      };

      const invocation = getPiInvocation(args);
      let stdoutBuffer = "";
      let timeout: NodeJS.Timeout | undefined;
      const abort = () => stop("cancelled");

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message?.role === "assistant") {
          addUsage(usage, event.message.usage);
          latestText = getText(event.message) || latestText;
          model = event.message.model ?? model;
          provider = event.message.provider ?? provider;
          lastStopReason = event.message.stopReason ?? lastStopReason;
          if (event.message.errorMessage) stderr = appendTail(stderr, `${event.message.errorMessage}\n`);
          if (params.maxCostUsd && usage.cost.total >= params.maxCostUsd) stop("cost");
          scheduleUpdate();
        } else if (event.type === "message_end" && event.message?.role === "toolResult") {
          addUsage(usage, event.message.usage);
          if (params.maxCostUsd && usage.cost.total >= params.maxCostUsd) stop("cost");
          scheduleUpdate();
        } else if (event.type === "turn_end") {
          turns += 1;
          if (params.maxTurns && turns >= params.maxTurns && event.message?.stopReason === "toolUse") stop("turns");
          flushUpdate();
        } else if (event.type === "tool_execution_start") {
          pendingTools.set(event.toolCallId, { name: event.toolName, args: event.args ?? {} });
        } else if (event.type === "tool_execution_end") {
          const tool = pendingTools.get(event.toolCallId);
          pendingTools.delete(event.toolCallId);
          if (!tool || event.isError) return;
          completedTools.push(describeTool(tool.name, tool.args));
          if (tool.name === "edit" || tool.name === "write") {
            const file = String(tool.args.path ?? tool.args.file_path ?? "");
            if (file) changedFiles.add(file);
          }
          scheduleUpdate();
        }
      };

      const exitCode = await new Promise<number | null>((done) => {
        proc = spawn(invocation.command, invocation.args, {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

        proc.stdout?.on("data", (chunk) => {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) processLine(line);
        });
        proc.stderr?.on("data", (chunk) => {
          stderr = appendTail(stderr, chunk.toString());
        });
        proc.on("error", (error) => {
          spawnError = error;
        });
        proc.on("close", (code) => {
          if (stdoutBuffer.trim()) processLine(stdoutBuffer);
          done(code);
        });

        if (params.timeoutSeconds) {
          timeout = setTimeout(() => stop("timeout"), params.timeoutSeconds * 1000);
          timeout.unref();
        }
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });

      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (emitTimer) clearTimeout(emitTimer);
      signal?.removeEventListener("abort", abort);

      let status: Status;
      if (cancelled) status = "cancelled";
      else if (limit) status = "limited";
      else if (spawnError || exitCode !== 0 || lastStopReason === "error" || lastStopReason === "aborted") status = "failed";
      else status = "completed";

      const details = makeDetails(status, exitCode);
      const progress = [
        changedFiles.size ? `Files changed: ${[...changedFiles].join(", ")}` : "Files changed: none recorded",
        completedTools.length ? `Completed tools: ${completedTools.slice(-12).join("; ")}` : "Completed tools: none recorded",
      ].join("\n");
      const prefix =
        status === "limited"
          ? `Delegate paused: ${limit} limit reached. Completed filesystem work is preserved.`
          : status === "cancelled"
            ? "Delegate cancelled. Completed filesystem work is preserved."
            : status === "failed"
              ? `Delegate failed${spawnError ? `: ${spawnError.message}` : ""}. Partial filesystem work may exist.`
              : "Delegate completed.";
      const output = await truncateOutput(
        [prefix, latestText, status === "completed" ? "" : progress, advisory, stderr.trim() ? `stderr:\n${stderr.trim()}` : ""]
          .filter(Boolean)
          .join("\n\n"),
      );

      return {
        content: [{ type: "text", text: output }],
        details,
        usage,
      };
    },

    renderCall(args, theme, context) {
      const text = (args as { task?: string })?.task ?? "";
      const expanded = (context as { expanded?: boolean } | undefined)?.expanded ?? false;
      // Collapsed: 72-char preview. Expanded (Ctrl+O): full task assignment.
      const preview = expanded ? text : text.length > 72 ? `${text.slice(0, 72)}...` : text;
      let content = theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("accent", String(args.role ?? "chore"));
      const limits: string[] = [];
      if (args.timeoutSeconds) limits.push(`${args.timeoutSeconds}s`);
      if (args.maxTurns) limits.push(`${args.maxTurns}t`);
      if (args.maxCostUsd) limits.push(`$${args.maxCostUsd}`);
      if (limits.length) content += theme.fg("muted", ` [${limits.join(", ")}]`);
      if (preview) content += `\n  ${theme.fg("dim", preview)}`;
      return new Text(content, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const details = result.details as DelegateDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const header = `${statusIcon(theme, details.status)} ${theme.fg("toolTitle", theme.bold("Delegate"))} ${theme.fg("accent", details.role)}`;
      const usage = usageLine(details.usage, details.turns);
      const toolLines = details.completedTools.slice(-3).map((t) => theme.fg("muted", "→ ") + theme.fg("toolOutput", t));
      const advisoryLine = details.advisory ? theme.fg("warning", `⚠ ${details.advisory}`) : "";

      if (isPartial || details.status === "running") {
        let text = header;
        if (details.provider || details.model)
          text += `\n${theme.fg("muted", `${details.provider ?? ""}${details.model ? ` / ${details.model}` : ""}`.trim())}`;
        if (usage) text += `\n${theme.fg("dim", usage)}`;
        if (toolLines.length) text += `\n${toolLines.join("\n")}`;
        if (advisoryLine) text += `\n${advisoryLine}`;
        return new Text(text, 0, 0);
      }

      if (!expanded) {
        let text = header;
        if (details.limit) text += ` ${theme.fg("warning", `[${details.limit} limit]`)}`;
        if (details.provider || details.model)
          text += `\n${theme.fg("muted", `${details.provider ?? ""}${details.model ? ` / ${details.model}` : ""}`.trim())}`;
        if (usage) text += `\n${theme.fg("dim", usage)}`;
        if (toolLines.length) text += `\n${toolLines.join("\n")}`;
        if (advisoryLine) text += `\n${advisoryLine}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header + (details.limit ? ` ${theme.fg("warning", `[${details.limit} limit]`)}` : ""), 0, 0));
      if (details.provider || details.model)
        container.addChild(
          new Text(theme.fg("muted", `${details.provider ?? ""}${details.model ? ` / ${details.model}` : ""}`.trim()), 0, 0),
        );
      container.addChild(new Text(theme.fg("dim", usage), 0, 0));
      if (details.changedFiles.length) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "Files changed:"), 0, 0));
        for (const f of details.changedFiles) container.addChild(new Text(theme.fg("accent", f), 0, 0));
      }
      if (details.completedTools.length) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "Tools:"), 0, 0));
        for (const t of details.completedTools) container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("toolOutput", t), 0, 0));
      }
      const text = result.content[0]?.type === "text" ? result.content[0].text.trim() : "";
      if (text) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
      }
      if (advisoryLine) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(advisoryLine, 0, 0));
      }
      if (details.stderr) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("error", `stderr:\n${details.stderr}`), 0, 0));
      }
      return container;
    },
  });

  pi.registerCommand("delegate", {
    description: "Edit persisted delegate model defaults (scout/chore, review, implement)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/delegate requires interactive UI", "error");
        return;
      }

      const roleGroups: { label: string; key: DelegateConfigKey }[] = [
        { label: "Scout / Chore", key: "scoutChore" },
        { label: "Review", key: "review" },
        { label: "Implement", key: "implement" },
      ];

      const selectedRoleLabel = await ctx.ui.select(
        "Select role group to configure",
        roleGroups.map((g) => g.label),
      );
      if (!selectedRoleLabel) return;

      const roleGroup = roleGroups.find((g) => g.label === selectedRoleLabel);
      if (!roleGroup) return;

      let availableModels: { provider: string; id: string }[];
      try {
        availableModels = (await ctx.modelRegistry.getAvailable()) ?? [];
      } catch (err) {
        ctx.ui.notify(`Failed to fetch available models: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      if (!availableModels.length) {
        ctx.ui.notify("No available models found", "warning");
        return;
      }

      const chosen = await ctx.ui.custom<{ provider: string; model: string } | undefined>((tui, _theme, _kb, done) => {
        const modelRuntimeAdapter = {
          getAvailableSnapshot: () => availableModels,
          getModel: (provider: string, id: string) => availableModels.find((m) => m.provider === provider && m.id === id),
          getError: () => undefined,
          refresh: async () => ({ models: availableModels, errors: new Map() }),
        };
        const settingsManagerAdapter = {
          setDefaultModelAndProvider: () => { },
        };
        return new ModelSelectorComponent(
          tui,
          ctx.model as any,
          settingsManagerAdapter as any,
          modelRuntimeAdapter as any,
          (ctx.scopedModels ?? []) as any,
          (model) => done({ provider: model.provider, model: model.id }),
          () => done(undefined),
        );
      });
      if (!chosen) return;

      const current = await loadDelegateConfig();
      const next: DelegateConfig = { ...current, [roleGroup.key]: { provider: chosen.provider, model: chosen.model } };

      try {
        await saveDelegateConfig(next);
        ctx.ui.notify(`Delegate default for ${roleGroup.label} saved → ${chosen.provider}/${chosen.model}`, "info");
      } catch (err) {
        ctx.ui.notify(`Failed to save delegate default: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
