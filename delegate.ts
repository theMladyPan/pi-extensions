import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isRetryableAssistantError, StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const FETCH_CONTENT_EXTENSION = join(getAgentDir(), "extensions/fetch-content/index.ts");
const PONYTAIL_EXTENSION = join(
  getAgentDir(),
  "npm/node_modules/@dietrichgebert/ponytail/pi-extension/index.js",
);
const WEB_TOOLS = ["fetch_content"];
const READ_TOOLS = ["read", "bash", "grep", "find", "ls", ...WEB_TOOLS];
const WRITE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", ...WEB_TOOLS];
const STDERR_LIMIT = 32 * 1024;

type Role = "scout" | "implement" | "review" | "chore" | "architect";
type Limit = "timeout";
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
  retries: number;
  softLimitBreached?: { turns?: boolean; cost?: boolean };
  stderr?: string;
  advisory?: string;
}

/** Role prompts live in ./delegate/ for easy editing; loaded per call, so edits apply without restart. */
const DELEGATE_DIR = new URL("./delegate/", import.meta.url);

async function loadRoleFile(name: string): Promise<string> {
  return readFile(new URL(name, DELEGATE_DIR), "utf8");
}

async function loadRolePrompt(role: Role): Promise<string> {
  const prompt = (await loadRoleFile(`${role}.md`)).trim();
  if (!prompt) throw new Error(`Delegate prompt file is empty: delegate/${role}.md`);
  return prompt;
}

const ROLE_CONFIG: Record<Role, { tools: string[]; thinking: string }> = {
  scout: {
    tools: READ_TOOLS,
    thinking: "medium",
  },
  implement: {
    tools: WRITE_TOOLS,
    thinking: "high",
  },
  review: {
    tools: READ_TOOLS,
    thinking: "high",
  },
  chore: {
    tools: WRITE_TOOLS,
    thinking: "medium",
  },
  architect: {
    tools: ["read", "grep", "find", "ls"],
    thinking: "high",
  },
};

const DelegateParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description:
      "A self-contained task packet with the relevant goal, bounded scope or question, known context, acceptance criteria, constraints, checks, and desired output",
  }),
  role: StringEnum(["scout", "implement", "review", "chore", "architect"] as const, {
    description: "Dominant role controlling available tools and guidance; workflows may skip or reorder roles",
  }),
  cwd: Type.Optional(Type.String({ description: "Child working directory; defaults to the current directory" })),
  provider: Type.Optional(Type.String({ description: "Pi provider override (required together with model; routing per delegate/orchestrator.md)" })),
  model: Type.Optional(Type.String({ description: "Pi model override (required together with provider; routing per delegate/orchestrator.md)" })),
  thinking: Type.Optional(
    StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
      description: "Thinking override; otherwise uses the selected role default",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 86400, description: "Wall-clock limit; preserves completed filesystem work" }),
  ),
  maxTurns: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 1000, description: "Soft limit: report when turns exceed this count; the run finishes naturally" }),
  ),
  maxCostUsd: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, description: "Soft cost cap based on provider-reported usage; breach is reported, not enforced" }),
  ),
  scoutTask: Type.Optional(Type.String({ description: "Optional pre-pass scout task. If provided, runs scout first (or in parallel with review) and feeds findings directly into the main task without returning them to parent context." })),
  reviewTask: Type.Optional(Type.String({ description: "Optional pre-pass review task. If provided, runs review first (or in parallel with scout) and feeds findings directly into the main task without returning them to parent context." })),
  scoutProvider: Type.Optional(Type.String({ description: "Provider override for pre-pass scout" })),
  scoutModel: Type.Optional(Type.String({ description: "Model override for pre-pass scout" })),
  reviewProvider: Type.Optional(Type.String({ description: "Provider override for pre-pass review" })),
  reviewModel: Type.Optional(Type.String({ description: "Model override for pre-pass review" })),
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

function buildPrompt(role: Role, rolePrompt: string): string {
  return [
    `You are a delegated ${role} agent running non-interactively.`,
    "Your role is a center of gravity, not a rigid script. Stay focused and use only available tools. Do adjacent analysis or work that your role permits when necessary for a correct result, and explain material deviations.",
    rolePrompt,
    "First test the assignment against its stated goal and repository evidence. If it is contradictory, unsafe, wrongly scoped, or based on a false premise, do not blindly execute it: explain why with evidence and propose a better bounded assignment. Complete a clearly safe portion only when it will not hide the blocker.",
    "Do not ask the user questions; you cannot interact. Resolve minor reversible ambiguity with the safest reasonable assumption and state it. For consequential ambiguity or a product or architecture decision, stop and return the blocker, evidence, options, and your recommendation to the parent agent.",
    "Follow repository instructions and preserve unrelated work. Use web tools only when repository evidence is insufficient. Follow Ponytail: understand first, then use the smallest solution that works.",
    "Output style: concise caveman talk. Bullet points, direct answers, zero prose fluff.",
    "Follow any output form requested by the task. Otherwise answer free-form and concise, including only relevant results, evidence, changed files, checks, assumptions, or blockers. Do not add empty headings or speculative follow-up.",
  ].join("\n");
}

interface PrePassResult {
  ok: boolean;
  output: string;
}

// ponytail: single-shot runner without the main runner's resume-retry; re-delegate manually if a pre-pass flakes.
async function runPrePass(opts: {
  role: Role;
  task: string;
  provider: string;
  model: string;
  cwd: string;
  approve: boolean;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<PrePassResult> {
  const config = ROLE_CONFIG[opts.role];
  // Pre-passes always run with --no-extensions, so web tools are never mountable; strip them unconditionally.
  const tools = config.tools.filter((t) => !WEB_TOOLS.includes(t));
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-extensions",
    "--tools",
    tools.join(","),
    "--thinking",
    config.thinking,
    opts.approve ? "--approve" : "--no-approve",
    "--provider",
    opts.provider,
    "--model",
    opts.model,
    "--append-system-prompt",
    buildPrompt(opts.role, await loadRolePrompt(opts.role)),
    opts.task,
  ];
  const invocation = getPiInvocation(args);
  return new Promise<PrePassResult>((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let text = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const output = ok
        ? text.trim()
        : [text.trim(), stderr.trim() ? `stderr:\n${stderr.trim()}` : ""].filter(Boolean).join("\n\n") || `pre-pass ${opts.role} produced no output`;
      resolve({ ok, output });
    };
    const onAbort = () => {
      proc.kill("SIGKILL");
      finish(false);
    };
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutSeconds) {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        finish(false);
      }, opts.timeoutSeconds * 1000);
      timer.unref();
    }
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const assistantText = getText(event.message);
            if (assistantText) text = assistantText;
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      const decoded = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
      stderr = appendTail(stderr, decoded);
    });
    proc.on("error", () => finish(false));
    proc.on("close", (code) => finish(code === 0 && text.trim() !== ""));
  });
}

export function decideRetry(opts: {
  status: "completed" | "failed" | "limited" | "cancelled";
  limit?: string;
  sessionId?: string;
  lastErrorMessage: string;
  latestText: string;
  hasWork: boolean;
  continueRetriesUsed: number;
  summaryRetriesUsed: number;
}): { kind: "continue" | "summary" } | null {
  if (opts.status === "cancelled" || opts.limit || !opts.sessionId) return null;
  if (
    opts.status === "failed" &&
    opts.continueRetriesUsed < 2 &&
    isRetryableAssistantError({ stopReason: "error", errorMessage: opts.lastErrorMessage } as any)
  ) {
    return { kind: "continue" };
  }
  if (opts.status === "completed" && opts.latestText === "" && opts.hasWork && opts.summaryRetriesUsed < 1) {
    return { kind: "summary" };
  }
  return null;
}

export default function delegateExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Run one bounded repository task in an isolated non-interactive Pi subprocess. Roles are centers of gravity: scout, implement, review, chore, architect. Supports provider/model/thinking overrides, a hard timeout, and soft turn/cost limits that are reported rather than enforced. Stopped runs preserve completed filesystem changes and return partial progress for reassignment. Optional scoutTask/reviewTask pre-passes run read-only scout/review subprocesses in parallel and fold their findings into the main agent's task packet without returning them to parent context.",
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
      if (!params.provider || !params.model) {
        throw new Error("provider and model are required: specify them explicitly (model routing lives in delegate/orchestrator.md)");
      }
      const approve = ctx.isProjectTrusted() && (cwd.startsWith(`${resolve(ctx.cwd)}/`) || cwd === resolve(ctx.cwd));

      let mainTask = params.task;
      if (params.scoutTask || params.reviewTask) {
        // allSettled: if one pre-pass rejects during setup (e.g. role file loading), the other child still gets awaited, not orphaned.
        const prePasses: { kind: string; run: Promise<PrePassResult> }[] = [];
        if (params.scoutTask) {
          prePasses.push({
            kind: "scout",
            run: runPrePass({
              role: "scout",
              task: params.scoutTask,
              provider: params.scoutProvider ?? "swan",
              model: params.scoutModel ?? "deepseek-ai/DeepSeek-V4-Flash-0731",
              cwd,
              approve,
              timeoutSeconds: params.timeoutSeconds,
              signal,
            }),
          });
        }
        if (params.reviewTask) {
          prePasses.push({
            kind: "review",
            run: runPrePass({
              role: "review",
              task: params.reviewTask,
              provider: params.reviewProvider ?? "swan",
              model: params.reviewModel ?? "Qwen/Qwen3.8-27B-FP8",
              cwd,
              approve,
              timeoutSeconds: params.timeoutSeconds,
              signal,
            }),
          });
        }
        const sections: string[] = [`## Primary Task & Context\n${params.task}`];
        const settled = await Promise.allSettled(prePasses.map((p) => p.run));
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Delegate aborted before main task execution." }],
            details: {
              role,
              task: mainTask,
              cwd,
              provider: params.provider,
              model: params.model,
              status: "cancelled",
              turns: 0,
              usage: emptyUsage(),
              changedFiles: [],
              completedTools: [],
              durationMs: 0,
            },
          };
        }
        for (let i = 0; i < prePasses.length; i++) {
          const { kind } = prePasses[i];
          const result = settled[i];
          const title = kind === "scout" ? "Pre-pass Scout Findings" : "Pre-pass Review Audit";
          const body =
            result.status === "fulfilled"
              ? await truncateOutput(result.value.output)
              : `pre-pass ${kind} failed during setup: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
          const ok = result.status === "fulfilled" && result.value.ok;
          sections.push(ok ? `## ${title}\n${body}` : `## ${title}\n(pre-pass ${kind} failed; findings unavailable)\n\n${body}`);
        }
        mainTask = await truncateOutput(sections.join("\n\n"));
      }

      const tools = fetchContentPresent ? config.tools : config.tools.filter((t) => !WEB_TOOLS.includes(t));
      const thinking = params.thinking ?? config.thinking;
      const rolePrompt = await loadRolePrompt(role);
      const args = [
        "--mode",
        "json",
        "-p",
        "--no-extensions",
        "--tools",
        tools.join(","),
        "--thinking",
        thinking,
        approve
          ? "--approve"
          : "--no-approve",
      ];
      if (fetchContentPresent) args.push("--extension", FETCH_CONTENT_EXTENSION);
      if (ponytailPresent) args.push("--extension", PONYTAIL_EXTENSION);

      args.push("--provider", params.provider);
      args.push("--model", params.model);
      args.push("--append-system-prompt", buildPrompt(role, rolePrompt), mainTask);

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
      let lastErrorMessage = "";
      let sessionId: string | undefined;
      let limit: Limit | undefined;
      let cancelled = false;
      let spawnError: Error | undefined;
      let proc: ChildProcess | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let emitTimer: NodeJS.Timeout | undefined;
      let continueRetriesUsed = 0;
      let summaryRetriesUsed = 0;
      let nextRetryKind: "continue" | "summary" | null = null;
      let sawCompleted = false;
      let status: Status = "running";
      let exitCode: number | null = null;
      let closed = false;
      let spawnSettleTimer: NodeJS.Timeout | undefined;
      const softLimits: { turns?: boolean; cost?: boolean } = {};
      let lastAssistantHadText = false;

      const totalRetries = () => continueRetriesUsed + summaryRetriesUsed;

      const makeDetails = (currentStatus: Status, currentExitCode: number | null): DelegateDetails => ({
        status: currentStatus,
        limit,
        role,
        task: mainTask,
        cwd,
        provider,
        model,
        thinking,
        turns,
        usage,
        exitCode: currentExitCode,
        changedFiles: [...changedFiles],
        completedTools: [...completedTools],
        retries: totalRetries(),
        ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
        ...(Object.keys(softLimits).length ? { softLimitBreached: { ...softLimits } } : {}),
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
        if (closed || limit || cancelled) return;
        if (reason === "cancelled") cancelled = true;
        else limit = reason;

        const stoppedStatus = reason === "cancelled" ? "cancelled" : "limited";
        const message =
          reason === "cancelled"
            ? "Delegate cancelled; completed filesystem work was preserved."
            : `Delegate ${reason} limit reached; stopping child and preserving completed filesystem work.`;
        const details = makeDetails(stoppedStatus, null);
        onUpdate?.({ content: [{ type: "text", text: message }], details });
        if (reason !== "cancelled") pi.events.emit("delegate:limit", { toolCallId, ...details });
        proc?.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (proc?.exitCode === null) proc.kill("SIGKILL");
        }, 5000);
        forceKillTimer.unref();
      };

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

        if (event.type === "session" && typeof event.id === "string" && !sessionId) {
          sessionId = event.id;
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
          addUsage(usage, event.message.usage);
          const assistantText = getText(event.message);
          latestText = assistantText || latestText;
          lastAssistantHadText = assistantText !== "";
          model = event.message.model ?? model;
          provider = event.message.provider ?? provider;
          lastStopReason = event.message.stopReason ?? lastStopReason;
          if (event.message.errorMessage) {
            lastErrorMessage = event.message.errorMessage;
            stderr = appendTail(stderr, `${event.message.errorMessage}\n`);
          }
          if (params.maxCostUsd && usage.cost.total >= params.maxCostUsd) softLimits.cost = true;
          scheduleUpdate();
        } else if (event.type === "message_end" && event.message?.role === "toolResult") {
          addUsage(usage, event.message.usage);
          if (params.maxCostUsd && usage.cost.total >= params.maxCostUsd) softLimits.cost = true;
          scheduleUpdate();
        } else if (event.type === "turn_end") {
          turns += 1;
          if (params.maxTurns && turns >= params.maxTurns) softLimits.turns = true;
          flushUpdate();
        } else if (event.type === "tool_execution_start") {
          pendingTools.set(event.toolCallId, { name: event.toolName, args: event.args ?? {} });
        } else if (event.type === "tool_execution_end") {
          const tool = pendingTools.get(event.toolCallId);
          pendingTools.delete(event.toolCallId);
          if (!tool || event.isError) return;
          const described = describeTool(tool.name, tool.args);
          if (!completedTools.includes(described)) completedTools.push(described);
          if (tool.name === "edit" || tool.name === "write") {
            const file = String(tool.args.path ?? tool.args.file_path ?? "");
            if (file) changedFiles.add(file);
          }
          scheduleUpdate();
        }
      };

      const sleepWithAbort = (ms: number) =>
        new Promise<boolean>((resolve) => {
          if (signal?.aborted || cancelled) return resolve(false);
          const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(!cancelled && !signal?.aborted);
          }, ms);
          const onAbort = () => {
            clearTimeout(t);
            signal?.removeEventListener("abort", onAbort);
            resolve(false);
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });

      for (let attempt = 0; ; attempt++) {
        let stdoutBuffer = "";
        spawnError = undefined;
        lastStopReason = undefined;
        lastErrorMessage = "";

        let currentArgs = args;
        if (attempt > 0 && sessionId) {
          const resumeArgs = [...args];
          resumeArgs.splice(3, 0, "--session", sessionId);
          const promptIdx = resumeArgs.indexOf("--append-system-prompt");
          if (promptIdx !== -1) resumeArgs.splice(promptIdx, 2);
          const continuationText =
            nextRetryKind === "continue"
              ? "Your previous turn failed with an upstream API error. Continue the task from where you left off — prior work is preserved in this session and on disk. Finish the task and end with a concise final text summary."
              : "Your previous run finished the work but ended without a final text summary. Do not redo any work. Reply with a concise summary of what you did and the results.";
          resumeArgs[resumeArgs.length - 1] = continuationText;
          currentArgs = resumeArgs;
        }

        const invocation = getPiInvocation(currentArgs);

        exitCode = await new Promise<number | null>((done) => {
          proc = spawn(invocation.command, invocation.args, {
            cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          });

          const stdoutDecoder = new StringDecoder("utf8");
          const stderrDecoder = new StringDecoder("utf8");

          proc.stdout?.on("data", (chunk: Buffer | string) => {
            stdoutBuffer += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) processLine(line);
          });
          proc.stderr?.on("data", (chunk: Buffer | string) => {
            const decoded = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
            stderr = appendTail(stderr, decoded);
          });
          proc.on("error", (error) => {
            spawnError = error;
            // Some spawn failures never emit `close`; force-settle as failed.
            proc?.kill();
            spawnSettleTimer = setTimeout(() => done(-1), 5000);
            spawnSettleTimer.unref();
          });
          proc.on("close", (code) => {
            closed = true;
            if (spawnSettleTimer) {
              clearTimeout(spawnSettleTimer);
              spawnSettleTimer = undefined;
            }
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

        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
        if (spawnSettleTimer) {
          clearTimeout(spawnSettleTimer);
          spawnSettleTimer = undefined;
        }
        signal?.removeEventListener("abort", abort);

        if (cancelled) status = "cancelled";
        else if (limit) status = "limited";
        else if (spawnError || exitCode !== 0 || lastStopReason === "error" || lastStopReason === "aborted") status = "failed";
        else {
          status = "completed";
          sawCompleted = true;
        }

        if (cancelled || limit) break;

        const hasWork = completedTools.length > 0 || changedFiles.size > 0;
        const retryDecision = decideRetry({
          status,
          limit,
          sessionId,
          lastErrorMessage,
          latestText,
          hasWork,
          continueRetriesUsed,
          summaryRetriesUsed,
        });

        if (!retryDecision) {
          if (status === "failed" && sawCompleted) {
            status = "completed";
          }
          break;
        }

        nextRetryKind = retryDecision.kind;
        if (retryDecision.kind === "continue") {
          const delay = continueRetriesUsed === 0 ? 3000 : 8000;
          continueRetriesUsed++;
          const ok = await sleepWithAbort(delay);
          if (!ok) {
            stop("cancelled");
            status = "cancelled";
            break;
          }
        } else {
          summaryRetriesUsed++;
          const ok = await sleepWithAbort(3000);
          if (!ok) {
            stop("cancelled");
            status = "cancelled";
            break;
          }
        }
      }

      if (emitTimer) clearTimeout(emitTimer);

      const details = makeDetails(status, exitCode);
      const progress = [
        changedFiles.size ? `Files changed: ${[...changedFiles].join(", ")}` : "Files changed: none recorded",
        completedTools.length ? `Completed tools: ${completedTools.slice(-12).join("; ")}` : "Completed tools: none recorded",
      ].join("\n");
      const retries = totalRetries();
      const prefix =
        status === "limited"
          ? `Delegate paused: ${limit} limit reached. Completed filesystem work is preserved.`
          : status === "cancelled"
            ? "Delegate cancelled. Completed filesystem work is preserved."
            : status === "failed"
              ? retries > 0
                ? `Delegate failed after ${retries} resume-retry(ies). Partial filesystem work may exist.`
                : `Delegate failed${spawnError ? `: ${spawnError.message}` : ""}. Partial filesystem work may exist.`
              : retries > 0
                ? `Delegate completed. Delegate recovered after ${retries} resume-retry(ies).`
                : "Delegate completed.";
      const softBreaches = [softLimits.turns ? "turns" : "", softLimits.cost ? "cost" : ""].filter(Boolean);
      const softNote = softBreaches.length
        ? `Soft limit exceeded (${softBreaches.join(", ")}); run finished naturally.`
        : "";
      const staleTextNote =
        status !== "completed" && latestText && !lastAssistantHadText
          ? "(note: no final assistant text captured; shown text may be from an earlier message)"
          : "";
      const output = await truncateOutput(
        [prefix, latestText, staleTextNote, status === "completed" ? "" : progress, softNote, advisory, stderr.trim() ? `stderr:\n${stderr.trim()}` : ""]
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
      const retrySuffix = details.retries > 0 ? ` (retried ${details.retries})` : "";
      container.addChild(
        new Text(header + retrySuffix + (details.limit ? ` ${theme.fg("warning", `[${details.limit} limit]`)}` : ""), 0, 0),
      );
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
}
