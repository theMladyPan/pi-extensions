/**
 * Dashboard extension: a local visual board the agent can draw on.
 *
 * Independent of voice mode. This extension serves a small page on loopback and
 * registers tools, so the agent can put material in front of the user instead of
 * writing everything into the terminal:
 *
 *   board_note    markdown note; fenced ```svg draws a picture, ``` shows mono text
 *   board_source  open a file at a line, full content, scrollable
 *   board_ask     blocking question answered by clicking on the board
 *   board_clear   empty the board
 *
 * Notes and source cards take an optional `key`. The same key updates the card in
 * place, which is how a todo list grows or a source card refreshes after an edit.
 * Without a key every call creates a new card; source cards default their key to
 * the file path so re-opening a file refreshes it.
 *
 * Security: the page is loopback only, the event stream and the answer endpoint
 * need the random token printed at session start, and file reads are confined to
 * the session working directory.
 *
 * Voice mode is a separate extension. When both are loaded, the `board:note`
 * event lets voice read board notes aloud; neither depends on the other.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const PREFERRED_PORT = Number(process.env.PI_BOARD_PORT ?? 7374);

/**
 * A board keeps its port and token across restarts, so a tab left open keeps working after
 * pi is restarted in the same folder instead of failing every request it makes.
 */
const STATE_FILE = join(homedir(), ".pi", "agent", "state", "dashboard.json");

function readRemembered(cwd: string): { port?: number; token?: string } {
	try {
		const all = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, { port?: number; token?: string }>;
		return all[cwd] ?? {};
	} catch {
		return {};
	}
}

function rememberBoard(cwd: string, port: number, token: string): void {
	try {
		let all: Record<string, { port?: number; token?: string }> = {};
		try {
			all = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, { port: number; token: string }>;
		} catch {
			all = {};
		}
		all[cwd] = { port, token };
		mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
		// Two sessions start at once often enough that a half-written state file would lose
		// both URLs, so the new version replaces the old one in a single step.
		const temp = `${STATE_FILE}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, STATE_FILE);
	} catch {
		// A board that cannot remember itself is still a working board.
	}
}
const MAX_SOURCE_BYTES = 2_000_000;
/** Pasted screenshots travel as base64 inside a message, so the body limit has to be generous. */
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

/** Where a card sits on the canvas. The server keeps it so a refresh and other tabs agree. */
interface CardRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface CardBase {
	id: string;
	key?: string;
	title?: string;
	at: number;
	rect?: CardRect;
	/** Folded down to its header. The rect keeps the real size, so restoring is exact. */
	mini?: boolean;
	/** Follow-up questions and their answers, oldest first. */
	turns?: Turn[];
}

/**
 * One follow-up exchange about a card. The question lives in the card it belongs to, so the
 * thread travels with whatever it is about instead of filling the canvas with reply cards.
 */
interface Turn {
	text: string;
	status: "queued" | "sent" | "answered" | "stopped";
	mode: "queue" | "steer";
	images?: number;
	reply?: string;
	at: number;
}

interface NoteCard extends CardBase {
	type: "note";
	markdown: string;
}

interface SourceCard extends CardBase {
	type: "source";
	path: string;
	content: string;
	line?: number;
}

interface QuestionCard extends CardBase {
	type: "question";
	question: string;
	options: string[];
	allowFreeText: boolean;
	status: "open" | "answered";
	answer?: string;
}

/** A message the user typed on the board; the agent's answer lands on the same card. */
interface StickyCard extends CardBase {
	type: "sticky";
	text: string;
	status: "queued" | "sent" | "answered" | "stopped";
	/** How many images the message carried. */
	images?: number;
	mode: "queue" | "steer";
	reply?: string;
}

type Card = NoteCard | SourceCard | QuestionCard | StickyCard;

/** One row of the activity rail: a tool call, or the answer that closed a turn. */
interface ActivityRow {
	id: string;
	kind: "tool" | "reply";
	tool?: string;
	/** Two or three words saying what the call does, shown instead of the tool name. */
	label?: string;
	target?: string;
	status: "running" | "ok" | "error";
	startedAt: number;
	durationMs?: number;
	summary?: string;
	text?: string;
}

/** What the header shows: which session this board belongs to and what it has spent. */
interface BoardMeta {
	folder: string;
	cwd: string;
	port: number;
	model: string;
	tokensIn: number;
	tokensOut: number;
	cost: number;
	contextPercent: number | null;
	/** True while the agent is working, so the board can offer a stop button. */
	running: boolean;
}

interface Board {
	server: Server;
	token: string;
	port: number;
	clients: Set<ServerResponse>;
	cards: Card[];
	meta: BoardMeta;
	activity: ActivityRow[];
}

const EMPTY_META: BoardMeta = {
	folder: "",
	cwd: "",
	port: 0,
	model: "",
	tokensIn: 0,
	tokensOut: 0,
	cost: 0,
	contextPercent: null,
	running: false,
};

let board: Board | undefined;
let currentCtx: ExtensionContext | undefined;
/** Whether a run is in flight. `agent_end` can be followed by more work, so this clears
 *  only when the whole run settles. */
let running = false;
let emit: (name: string, data: unknown) => void = () => {};
const pendingAnswers = new Map<string, (answer: string) => void>();
/** Set by the extension so the HTTP handler can hand a board message to the session. */
type InboundImage = { data: string; mimeType: string };
let deliver: (text: string, mode: "queue" | "steer", images: InboundImage[], preamble: string) => Promise<void> =
	async () => {};

/**
 * An exchange waiting for its answer. Turn -1 is the sticky's own message; anything else is a
 * follow-up stored in the card's `turns`. Keeping the queue in arrival order is what makes a
 * reply land in the right thread when several are waiting.
 */
type Pending = { cardId: string; turn: number };
const awaitingTurns: Pending[] = [];

/** What the session is sent for one exchange: the words and the context they refer to. */
type Outgoing = Pending & { text: string; images: InboundImage[]; mode: "queue" | "steer"; preamble: string };

/** Messages accepted but not yet handed to the session, oldest first. */
const outbox: Outgoing[] = [];
/** Sends already accepted, so a retried POST does not deliver the same message twice. */
const recentSends = new Map<string, Pending>();
function rememberSend(sendId: string, receipt: Pending): void {
	recentSends.set(sendId, receipt);
	if (recentSends.size > 100) recentSends.delete(recentSends.keys().next().value as string);
}
let pumping = false;

const BOARD_PROMPT = [
	"[DASHBOARD MODE: the user watches a visual board instead of the terminal]",
	"A message from the board arrives as a sticky card and your final answer is attached under it automatically. Never repeat that answer in a note, and never restate it in a second card.",
	"Post a note only for what the sticky cannot carry: a diagram (a fenced ```svg block), a palette, a file tree (a fenced block), a table, or a list you will keep updating.",
	"Open source cards with board_source whenever you point at code or config, one card per spot, so the user reads the real lines instead of a description of them.",
	"Refer to another card with [[key]], using the key you gave board_note or board_source, and optionally [[key|text to show]]. The user clicks it and the board centres on that card, so link instead of describing where something lives.",
	"While you work, short breadcrumb notes are welcome: one line, past tense, no summary of the answer.",
	"A question with a short answer gets no artefacts at all. Answer, and stop.",
	"Keep a card current by passing the same key again: a todo list grows, a source card refreshes after an edit.",
	"When a decision is genuinely the user's, ask with board_ask instead of guessing; it blocks until they click.",
	"Your transcript reply is not where the user reads. Write nothing there beyond the answer itself: no preamble, no plan, no 'let me check', no account of what you changed, no restatement of a card. Everything else belongs on a card.",
	'A card the user closed comes back with the answer on it, so never mention a card being missing.',
].join("\n");

const totals = { tokensIn: 0, tokensOut: 0, cost: 0 };

/** Notes posted during the current turn, so one that repeats the answer can be dropped. */
const turnNotes: { id: string; text: string }[] = [];

const flatText = (value: string) =>
	value
		.toLowerCase()
		.replace(/[`*#>_[\]()]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** True when a note only says what the answer already says. Artefacts never count. */
function repeatsAnswer(note: string, answer: string): boolean {
	if (note.includes("```")) return false;
	const left = flatText(note);
	const right = flatText(answer);
	if (left.length < 40 || right.length < 40) return false;
	const shorter = left.length <= right.length ? left : right;
	const longer = shorter === left ? right : left;
	return longer.includes(shorter.slice(0, Math.min(shorter.length, 160)));
}

/**
 * What a finished call turned out to mean, in a few words, worked out from the output. This
 * lands the instant the tool returns; a cheaper model refines it a moment later.
 */
// Some shell results carry the exit code in the text, and it is machinery, not output.
const EXIT_MARKER = /-{2,}\s*EXIT:?\s*(-?\d+)\s*-{2,}/i;
const stripExitMarker = (value: string) => value.replace(/-{2,}\s*EXIT:?\s*-?\d+\s*-{2,}/gi, " ").trim();

/** Whether a call went wrong, from its flag, its exit code, or plain words in its output. */
function failedCall(isError: boolean, result: string): boolean {
	const exit = result.match(EXIT_MARKER);
	const text = stripExitMarker(result).toLowerCase();
	// A failure can only show in the output: a chain like `ls && cat missing` still exits 0
	// from the last command, while the text says plainly what went wrong.
	const looksFailed = /no such file|enoent|permission denied|eacces|command not found|timed out/.test(text);
	return isError || (exit ? Number(exit[1]) !== 0 : false) || looksFailed;
}

function toolOutcome(isError: boolean, result: string): string {
	const text = stripExitMarker(result).toLowerCase();
	if (failedCall(isError, result)) {
		if (/permission denied|eacces/.test(text)) return "failed: permission denied";
		if (/no such file|enoent/.test(text)) return "failed: missing file";
		if (/command not found/.test(text)) return "failed: command missing";
		if (/timed out|timeout/.test(text)) return "failed: timed out";
		if (/outside the working directory/.test(text)) return "failed: outside the folder";
		if (/not found/.test(text)) return "failed: nothing found";
		return "failed";
	}
	const hits = result.split("\n").filter((line) => /^[^\s:]+:\d+:/.test(line));
	if (hits.length > 0) {
		const files = new Set(hits.map((line) => line.split(":")[0])).size;
		return `found ${hits.length} in ${files} file${files === 1 ? "" : "s"}`;
	}
	const replaced = result.match(/replaced\s+(\d+)\s+block/i);
	if (replaced) return `edited ${replaced[1]} block${replaced[1] === "1" ? "" : "s"}`;
	return "";
}

/** A very small, very fast model turns the outcome into a phrase a person would say. */
const ROW_MODEL = process.env.PI_BOARD_ROW_MODEL ?? "inception/mercury-3";
const ROW_MODEL_ENABLED = process.env.PI_BOARD_ROWS_MODEL !== "0" && Boolean(process.env.OPENROUTER_API_KEY);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const ROW_PROMPT = [
	"You caption one line of a tool activity list. Reply with the caption only.",
	"At most five words, lowercase, no period, no quotes, and never the words successfully or done.",
	'If the call failed, start with "failed:" and name the cause. If it did not fail, never say it did.',
	"",
	"Tool: bash, asked: grep -rn TIMEOUT config",
	"Output: config/settings.py:1:TIMEOUT = 30, config/app.yaml:2:  timeout: 30",
	"Caption: found timeout in 2 files",
	"",
	"Tool: read, asked: reading /home/u/app/main.py",
	"Output: EACCES: permission denied",
	"Caption: failed: permission denied",
	"",
	"Tool: bash, asked: grep -rn TIMEOUT config",
	"Output: config/settings.py:1:TIMEOUT = 30",
	"Caption: The search completed successfully and located the pattern in the configuration file.",
].join("\n");

type RowJob = {
	rowId: string;
	tool: string;
	args: string;
	result: string;
	isError: boolean;
	failed: boolean;
	/** What the call was already captioned as, and what went wrong by the plain rules. */
	start: string;
	hint: string;
};
const rowJobs: RowJob[] = [];
/** Arguments by call id, so the end event can describe what the call was asked to do. */
const callArgs = new Map<string, unknown>();
let rowBusy = false;

const cleanPhrase = (value: string): string =>
	value
		.replace(/[*_`"]/g, "")
		// Small models like to answer "Caption: ..." or ": ...", and the label already has a place.
		.replace(/^\s*(caption|label)\s*:?\s*/i, "")
		.replace(/^[\s:.\-–—]+/, "")
		.replace(/\s+/g, " ")
		.replace(/[.]$/, "")
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.slice(0, 6)
		.join(" ")
		.slice(0, 48);

async function phraseRow(job: RowJob): Promise<string | undefined> {
	// Reasoning is switched off: a caption of five words is not a puzzle, and the reasoning
	// tokens cost more than the answer and arrive slower than the row can wait.
	const body = {
		model: ROW_MODEL,
		messages: [
			{ role: "system", content: ROW_PROMPT },
			{
				role: "user",
				content: `Tool: ${job.tool}, asked: ${job.start}${job.hint ? `\nThe first guess was "${job.hint}". Improve it if you can.` : ""}\nOutput: ${job.result.slice(0, 400)}`,
			},
		],
		max_tokens: 24,
		temperature: 0,
		reasoning: { enabled: false },
	};
	const response = await fetch(OPENROUTER_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(4000),
	});
	if (!response.ok) return undefined;
	const payload = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
	const phrase = cleanPhrase(payload.choices?.[0]?.message?.content ?? "");
	return phrase.length > 2 ? phrase : undefined;
}

/** One request at a time, and only a short backlog, so the rail never waits on the model. */
async function drainRowJobs(): Promise<void> {
	if (rowBusy) return;
	rowBusy = true;
	try {
		while (rowJobs.length > 0) {
			const job = rowJobs.shift();
			if (!job || !board) continue;
			const phrase = await phraseRow(job).catch(() => undefined);
			if (!phrase || !board) continue;
			// A caption that invents a failure is worse than no caption at all.
			if (!job.failed && /^failed\b/i.test(phrase)) continue;
			// A call that failed is captioned as a failure, whatever the model chose to
			// highlight, so the row never reads as a success it did not have.
			const caption = job.failed && !/failed/i.test(phrase) ? `failed: ${phrase}`.slice(0, 56) : phrase;
			patchActivity(board, job.rowId, job.failed ? { label: caption, status: "error" } : { label: caption });
		}
	} finally {
		rowBusy = false;
	}
}

function queueRowLabel(
	rowId: string,
	tool: string,
	args: unknown,
	result: string,
	isError: boolean,
	failed = isError,
	hint = "",
	start = "",
): void {
	if (!ROW_MODEL_ENABLED) return;
	// Nothing to explain in a two-word answer, and a small model asked to caption one will
	// invent context. The plain caption already says it.
	if (!failed && result.trim().length <= 40) return;
	if (rowJobs.length > 8) rowJobs.shift();
	const flatArgs = args && typeof args === "object" ? JSON.stringify(args).slice(0, 400) : String(args ?? "");
	rowJobs.push({ rowId, tool, args: flatArgs, result, isError, failed, start: start || toolLabel(tool, args), hint });
	void drainRowJobs();
}

const MAX_ACTIVITY = 300;
/** Which argument of a tool call names the thing the user cares about. */
const TARGET_KEYS = ["path", "file_path", "filePath", "command", "pattern", "query", "url", "target", "cmd"];

const baseName = (value: string) => value.split("/").filter(Boolean).pop() ?? value;

const words = (value: string, limit = 5) => {
	const parts = value.trim().split(/\s+/).filter(Boolean);
	if (parts.length <= limit) return parts.join(" ");
	return `${parts.slice(0, limit).join(" ")}…`;
};

const unquote = (value: string) => value.replace(/^['"]|['"]$/g, "");

const hostOf = (value: string) => {
	try {
		return new URL(value).host.replace(/^www\./, "");
	} catch {
		return baseName(value);
	}
};

/** The shell command says more about intent than the word "bash" ever will. */
function commandPhrase(command: string): string {
	const cleaned = command
		.replace(/^\s*(cd\s+[^&;]+&&\s*)/, "")
		.replace(/^\s*(sudo\s+|env\s+\S+\s+)*/, "")
		.trim();
	const parts = cleaned.split(/\s+/).filter(Boolean);
	const head = baseName(parts[0] ?? "");
	const rest = parts.slice(1);
	const firstArg = rest.find((part) => !part.startsWith("-")) ?? "";
	const sub = rest[0] ?? "";

	const table: Record<string, () => string> = {
		rg: () => `searching for ${words(unquote(firstArg) || "a pattern", 3)}`,
		grep: () => `searching for ${words(unquote(firstArg) || "a pattern", 3)}`,
		find: () => `finding ${words(firstArg || "files", 3)}`,
		git: () => `git ${sub || "status"}`.trim(),
		npm: () => `npm ${sub || "run"}`.trim(),
		pnpm: () => `pnpm ${sub || "run"}`.trim(),
		yarn: () => `yarn ${sub || "run"}`.trim(),
		pytest: () => "running the tests",
		tsc: () => "type checking",
		ruff: () => "linting",
		eslint: () => "linting",
		sleep: () => "waiting",
		curl: () => `fetching ${hostOf(firstArg || sub)}`,
		wget: () => `fetching ${hostOf(firstArg || sub)}`,
		python: () => "running python",
		python3: () => "running python",
		uv: () => "running uv",
		node: () => "running node",
		make: () => "building",
		sed: () => "editing text",
		awk: () => "editing text",
		tmux: () => "driving the terminal",
		docker: () => "container work",
		podman: () => "container work",
		mkdir: () => "making folders",
		rm: () => "deleting files",
		cp: () => "copying files",
		mv: () => "moving files",
		code: () => "opening the editor",
		ls: () => "listing files",
		cat: () => "reading a file",
		head: () => "peeking at a file",
		tail: () => "peeking at a file",
		wc: () => "counting lines",
		pwd: () => "checking the folder",
		which: () => "locating a program",
	};

	const known = table[head];
	if (known) return known();
	return `running ${words(head || command, 3)}`;
}

/**
 * A rail row reads better as a phrase than as a tool name, so every call gets two or three
 * words saying what it does. Deterministic on purpose: the row appears the moment the tool
 * starts, with no extra model call and no waiting.
 */
function toolLabel(tool: string, args: unknown): string {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string).trim() : "");
	const firstQuery = Array.isArray(record.queries) ? String(record.queries[0] ?? "") : "";
	const name = tool.toLowerCase();

	if (name.includes("board_note") || name === "note") return "writing a note";
	if (name.includes("board_source") || name.includes("source")) return `opening ${baseName(text("path")) || "a file"}`;
	if (name.includes("board_ask") || name === "ask") return "asking you";
	if (name.includes("board_clear")) return "clearing the board";
	if (name === "read" || name.includes("read_file")) return `reading ${baseName(text("path") || text("file_path")) || "a file"}`;
	if (name === "edit" || name === "write" || name.includes("patch") || name.includes("multi_edit"))
		return `editing ${baseName(text("path") || text("file_path")) || "a file"}`;
	if (name.includes("grep") || name === "rg" || name.includes("search_file"))
		return `searching for ${words(text("pattern") || text("query") || "a pattern", 3)}`;
	if (name.includes("glob") || name === "find" || name === "ls") return `finding ${words(text("pattern") || text("path") || "files", 3)}`;
	if (name.includes("_search") || name === "search")
		return `searching the web for ${words(text("query") || text("q") || text("question") || firstQuery || "an answer", 3)}`;
	if (name.includes("fetch") || name === "url") return `reading ${hostOf(text("url") || text("target"))}`;
	if (name === "bash" || name === "shell" || name.includes("exec")) return commandPhrase(text("command") || text("cmd"));
	if (name.includes("todo")) return "updating the plan";
	if (name === "delegate" || name.includes("task")) return `delegating ${words(text("role") || "work", 2)}`;
	if (name.includes("image") || name.includes("vision")) return "looking at an image";
	return `running ${words(tool, 3)}`;
}

function toolTarget(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of TARGET_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
	}
	const first = Object.values(record).find((value) => typeof value === "string" && value.trim());
	return typeof first === "string" ? first.trim().slice(0, 120) : "";
}

/** First line of a tool result, so a row says something without being opened. */
function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => (part as { type?: string }).type === "text")
		.map((part) => String((part as { text?: string }).text ?? ""))
		.join("\n");
}

function resultSummary(result: unknown): string {
	const text = (() => {
		if (typeof result === "string") return result;
		const content = (result as { content?: unknown })?.content;
		if (Array.isArray(content)) {
			const first = content.find((part) => (part as { type?: string })?.type === "text");
			if (first) return String((first as { text?: string }).text ?? "");
		}
		return "";
	})();
	return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 140) ?? "";
}

function textOf(message: { content?: unknown }): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => (part as { type?: string })?.type === "text")
		.map((part) => String((part as { text?: string }).text ?? ""))
		.join("\n")
		.trim();
}

function pushActivity(target: Board, row: ActivityRow): void {
	target.activity.push(row);
	if (target.activity.length > MAX_ACTIVITY) target.activity.splice(0, target.activity.length - MAX_ACTIVITY);
	broadcast(target, { type: "activity", row });
}

function patchActivity(target: Board, id: string, patch: Partial<ActivityRow>): void {
	const row = target.activity.find((candidate) => candidate.id === id);
	if (!row) return;
	Object.assign(row, patch);
	broadcast(target, { type: "activity", row });
}

/** Fold a finished assistant message into the running totals the header reports. */
function addUsage(message: { usage?: { input?: number; output?: number; cost?: { total?: number } } }): boolean {
	const usage = message.usage;
	if (!usage) return false;
	totals.tokensIn += usage.input ?? 0;
	totals.tokensOut += usage.output ?? 0;
	totals.cost += usage.cost?.total ?? 0;
	return true;
}

function currentMeta(target: Board): BoardMeta {
	const cwd = currentCtx?.cwd ?? process.cwd();
	const model = currentCtx?.model;
	return {
		folder: cwd.split("/").filter(Boolean).pop() ?? cwd,
		cwd,
		port: target.port,
		model: model ? `${model.id}` : "",
		tokensIn: totals.tokensIn,
		tokensOut: totals.tokensOut,
		cost: totals.cost,
		contextPercent: currentCtx?.getContextUsage()?.percent ?? null,
		running,
	};
}

function pushMeta(): void {
	if (!board) return;
	board.meta = currentMeta(board);
	broadcast(board, { type: "meta", meta: board.meta });
}

/**
 * A follow-up is a question about one card, so the session is told which card and given a short
 * quote. The quote is capped because the conversation already holds the rest: repeating it would
 * pay twice for the same words and would not survive the cache that a plain append keeps.
 */
function replyContext(card: Card): string {
	// A sticky's title is just "you", so its own words name it instead.
	const title =
		card.type === "sticky"
			? card.text.replace(/\s+/g, " ").trim().slice(0, 60)
			: (card.title ?? (card.type === "source" ? card.path : card.type));
	// A source card points at a place in a file, so the quote is those lines. The first five
	// hundred characters of the file say nothing about the line the user is asking about.
	if (card.type === "source") {
		const lines = card.content.split("\n");
		const focus = Math.max(1, Math.min(card.line ?? 1, lines.length));
		const from = Math.max(1, focus - 8);
		const to = Math.min(lines.length, focus + 12);
		const numbered = lines
			.slice(from - 1, to)
			.map((line, index) => `${from + index}| ${line}`)
			.join("\n")
			.slice(0, 500);
		return `[board reply · card ${card.id} · "${title}"]\nThe card shows ${card.path}, lines ${from}-${to}:\n${numbered || "(empty)"}\n\n`;
	}
	const body = (() => {
		switch (card.type) {
			case "note":
				return card.markdown;
			case "question":
				return [card.question, card.answer ?? ""].join("\n");
			case "sticky":
				return [card.text, card.reply ?? "", ...(card.turns ?? []).flatMap((turn) => [turn.text, turn.reply ?? ""])].join("\n");
		}
	})();
	const quote = body.replace(/\s+/g, " ").trim().slice(0, 500);
	return `[board reply · card ${card.id} · "${title}"]\nThe card says: ${quote || "(empty)"}\n\n`;
}

/** A closed card that still has an answer coming, kept whole so it can come back where it was. */
const closedCards = new Map<string, Card>();

/**
 * Point one exchange at a new state and keep the card the user is watching current. Returns
 * false when the card is gone, which is what lets the caller keep the answer instead of losing it.
 */
function setPending(pending: Pending, status: Turn["status"], reply?: string): boolean {
	const card = board?.cards.find((candidate) => candidate.id === pending.cardId);
	if (!card) return false;
	if (pending.turn < 0) {
		if (card.type !== "sticky") return false;
		card.status = status;
		if (reply !== undefined) card.reply = reply;
	} else {
		const turn = card.turns?.[pending.turn];
		if (!turn) return false;
		turn.status = status;
		if (reply !== undefined) turn.reply = reply;
	}
	if (board) broadcast(board, { type: "update", card });
	return true;
}

/**
 * The card was closed while its answer was being written. The answer belongs on that card, so
 * the card itself is put back: same id, same place, same thread, with the reply on it.
 */
function restoreClosedCard(cardId: string): void {
	const target = board;
	const closed = closedCards.get(cardId);
	if (!target || !closed) return;
	closedCards.delete(cardId);
	if (target.cards.some((card) => card.id === cardId)) return;
	target.cards.push(closed);
	// Quiet: the user has seen this card before, so it comes back without a "new" tag.
	broadcast(target, { type: "card", card: closed, quiet: true });
}

/**
 * Drop a closed card's queued messages, but keep an exchange that already reached the session:
 * its answer is still coming and has nowhere else to land.
 */
function forgetCard(cardId: string): void {
	for (let index = outbox.length - 1; index >= 0; index -= 1) {
		if (outbox[index].cardId === cardId) outbox.splice(index, 1);
	}
}

/** True while some exchange is waiting for the answer being written now. */
function awaitingAnswer(cardId: string): boolean {
	return awaitingTurns.some((pending) => pending.cardId === cardId);
}

/** Hand one exchange to the session and keep its card showing what happened to it. */
async function sendNow(job: Outgoing): Promise<void> {
	const pending: Pending = { cardId: job.cardId, turn: job.turn };
	try {
		await deliver(job.text, job.mode, job.images, job.preamble);
		setPending(pending, "sent");
	} catch {
		setPending(pending, "answered", "could not deliver this message");
	}
}

/** Send the oldest waiting message once the session is free. */
async function pumpOutbox(): Promise<void> {
	if (pumping || running || outbox.length === 0 || !board) return;
	pumping = true;
	try {
		const next = outbox.shift();
		if (!next) return;
		const card = board.cards.find((candidate) => candidate.id === next.cardId);
		if (!card) return; // closed while waiting
		awaitingTurns.push({ cardId: next.cardId, turn: next.turn });
		await sendNow(next);
	} finally {
		pumping = false;
	}
}

function urlFor(target: Board): string {
	return `http://127.0.0.1:${target.port}/?token=${target.token}`;
}

function broadcast(target: Board, message: unknown): void {
	const payload = `data: ${JSON.stringify(message)}\n\n`;
	for (const client of target.clients) {
		// A tab that closed or reloaded is still in the list for a moment. Writing to its dead
		// socket would raise an error nobody is listening for.
		if (client.writableEnded || client.destroyed) {
			target.clients.delete(client);
			continue;
		}
		client.write(payload);
	}
}

/** Insert or replace by key, so a repeated key refreshes the existing card. */
function upsert(target: Board, card: Card): boolean {
	const existing = card.key ? target.cards.findIndex((candidate) => candidate.key === card.key) : -1;
	if (existing >= 0) {
		const previous = target.cards[existing];
		card.id = previous.id; // keep identity stable so the browser updates in place
		card.rect = previous.rect; // and keep the place the user put it
		// The card was refreshed, not replaced: the conversation hanging off it belongs to the
		// user and survives the rewrite.
		card.turns = previous.turns;
		card.mini = previous.mini;
		target.cards[existing] = card;
		broadcast(target, { type: "update", card });
		return false;
	}
	target.cards.push(card);
	if (target.cards.length > 200) target.cards.shift();
	broadcast(target, { type: "card", card });
	return true;
}

function serveStatic(res: ServerResponse, file: string, type: string): void {
	try {
		const body = readFileSync(resolve(PUBLIC_DIR, file));
		res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
		res.end(body);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not found");
	}
}

/**
 * Read a request body up to a limit. The old version destroyed the socket once the body
 * passed 64 KB, which reaches the browser as a connection reset with no explanation, and a
 * pasted screenshot is several times that size. Oversized bodies are refused instead.
 */
function readBody(req: import("node:http").IncomingMessage, limit = MAX_BODY_BYTES): Promise<string | undefined> {
	return new Promise((done) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let oversized = false;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) oversized = true;
			else chunks.push(chunk);
		});
		req.on("end", () => done(oversized ? undefined : Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => done(undefined));
	});
}

/** Read and parse a JSON body, answering 400 or 413 itself and returning nothing. */
async function readJson<T>(req: import("node:http").IncomingMessage, res: ServerResponse): Promise<T | undefined> {
	const body = await readBody(req);
	if (body === undefined) {
		res.writeHead(413, { "Content-Type": "text/plain" });
		res.end("body too large");
		return undefined;
	}
	try {
		return JSON.parse(body) as T;
	} catch {
		res.writeHead(400, { "Content-Type": "text/plain" });
		res.end("bad json");
		return undefined;
	}
}

function startBoard(): Board {
	const remembered = readRemembered(process.cwd());
	const freshToken = () => randomBytes(16).toString("hex");
	let token = remembered.token ?? freshToken();
	const clients = new Set<ServerResponse>();
	const cards: Card[] = [];
	const activity: ActivityRow[] = [];

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			// Static assets carry no session data, so the token only guards data routes.
			if (req.method === "GET" && url.pathname === "/") {
				serveStatic(res, "index.html", "text/html; charset=utf-8");
				return;
			}
			if (req.method === "GET" && url.pathname === "/board.js") {
				serveStatic(res, "board.js", "text/javascript; charset=utf-8");
				return;
			}
			if (url.searchParams.get("token") !== token) {
				// A refused POST has to have its body taken off the wire, otherwise the client's next
				// request rides the same socket into the leftovers and reads as a reset.
				req.resume();
				res.writeHead(403, { "Content-Type": "text/plain", Connection: "close" });
				res.end("forbidden");
				return;
			}
			if (req.method === "GET" && url.pathname === "/events") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-store",
					Connection: "keep-alive",
				});
				res.write(
					`data: ${JSON.stringify({
						type: "snapshot",
						cards,
						activity,
						meta: currentMeta(board ?? ({ port: 0 } as Board)),
					})}\n\n`,
				);
				clients.add(res);
				const keepAlive = setInterval(() => res.write(`: ping\n\n`), 20_000);
				const forget = () => {
					clearInterval(keepAlive);
					clients.delete(res);
				};
				req.on("close", forget);
				res.on("error", forget);
				return;
			}
			if (req.method === "POST" && url.pathname === "/message") {
				const payload = await readJson<{
					id?: string;
					cardId?: string;
					text?: string;
					mode?: string;
					images?: { data?: string; mimeType?: string }[];
				}>(req, res);
				if (!payload) return;
				// A send that lost its answer may be retried, so the browser tags it. The same tag
				// twice means the message already exists and must not be delivered again.
				const sendId = typeof payload.id === "string" ? payload.id.slice(0, 64) : "";
				const accepted = sendId ? recentSends.get(sendId) : undefined;
				if (accepted) {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ...accepted, duplicate: true }));
					return;
				}
				const text = (payload.text ?? "").trim();
				const images = (payload.images ?? [])
					.filter((image) => typeof image.data === "string" && /^image\//.test(image.mimeType ?? ""))
					.slice(0, 4)
					.map((image) => ({ data: image.data as string, mimeType: image.mimeType as string }));
				// A pasted screenshot on its own is a message too, so empty text is allowed when
				// an image carries the question.
				if (!text && images.length === 0) {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("empty message");
					return;
				}
				const mode = payload.mode === "steer" ? "steer" : "queue";

				// A message with a card behind it is a follow-up and lands in that card's thread;
				// one without a card is a new message and becomes a sticky.
				const parent = payload.cardId ? cards.find((candidate) => candidate.id === payload.cardId) : undefined;
				if (payload.cardId && !parent) {
					res.writeHead(409, { "Content-Type": "text/plain" });
					res.end("no such card");
					return;
				}

				let job: Outgoing;
				if (parent) {
					// The preamble describes the card as it was asked, so the new question is not
					// quoted back at the agent along with the rest of the thread.
					const preamble = replyContext(parent);
					const turns = parent.turns ?? [];
					turns.push({
						text: text.slice(0, 4000),
						status: "queued",
						mode,
						at: Date.now(),
						...(images.length ? { images: images.length } : {}),
					});
					parent.turns = turns;
					broadcast(board ?? ({ clients } as Board), { type: "update", card: parent });
					job = {
						cardId: parent.id,
						turn: turns.length - 1,
						text,
						images,
						mode,
						preamble,
					};
				} else {
					const sticky: StickyCard = {
						id: nextId(),
						type: "sticky",
						text: text.slice(0, 4000),
						status: "queued",
						mode,
						images: images.length,
						title: "you",
						at: Date.now(),
					};
					cards.push(sticky);
					broadcast(board ?? ({ clients } as Board), { type: "card", card: sticky });
					job = { cardId: sticky.id, turn: -1, text, images, mode, preamble: "" };
				}

				const receipt = JSON.stringify({ id: job.cardId, turn: job.turn });
				if (sendId) rememberSend(sendId, { id: job.cardId, turn: job.turn });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(receipt);
				if (mode === "steer") {
					awaitingTurns.push({ cardId: job.cardId, turn: job.turn });
					void sendNow(job);
				} else {
					// Queued messages wait here rather than in pi's own queue, so closing the card
					// can take the message back before the agent ever sees it.
					outbox.push(job);
					void pumpOutbox();
				}
				return;
			}
			if (req.method === "POST" && url.pathname === "/stop") {
				// Stop is the same interrupt as Escape, so nothing is left half-run.
				if (!running || !currentCtx) {
					res.writeHead(409, { "Content-Type": "text/plain" });
					res.end("no run in progress");
					return;
				}
				currentCtx.abort();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ stopped: true }));
				return;
			}
			if (req.method === "POST" && url.pathname === "/layout") {
				// The browser owns placement; the server only remembers it. Storing it means a
				// closed card frees its space and a refresh reproduces the board exactly.
				const payload = await readJson<{ cardId?: string; rect?: Partial<CardRect>; mini?: unknown }>(req, res);
				if (!payload) return;
				const card = cards.find((candidate) => candidate.id === payload.cardId);
				const rect = payload.rect;
				if (!card || !rect) {
					res.writeHead(409, { "Content-Type": "text/plain" });
					res.end("no such card");
					return;
				}
				const clamp = (value: unknown) =>
					Math.max(0, Math.min(40000, Math.round(Number.isFinite(Number(value)) ? Number(value) : 0)));
				card.rect = { x: clamp(rect.x), y: clamp(rect.y), w: clamp(rect.w), h: clamp(rect.h) };
				if (typeof payload.mini === "boolean") card.mini = payload.mini;
				broadcast(board ?? ({ clients } as Board), {
					type: "move",
					id: card.id,
					rect: card.rect,
					mini: card.mini === true,
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ placed: card.id }));
				return;
			}
			if (req.method === "POST" && url.pathname === "/edit") {
				// The user owns the words in a note. A later board_note with the same key still
				// wins, which is the agent's way of refreshing its own card.
				const payload = await readJson<{ cardId?: string; markdown?: string }>(req, res);
				if (!payload) return;
				const card = cards.find((candidate) => candidate.id === payload.cardId);
				if (!card || card.type !== "note") {
					res.writeHead(409, { "Content-Type": "text/plain" });
					res.end("not an editable note");
					return;
				}
				card.markdown = (payload.markdown ?? "").slice(0, 20000);
				broadcast(board ?? ({ clients } as Board), { type: "update", card });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ edited: card.id }));
				return;
			}
			if (req.method === "POST" && url.pathname === "/close") {
				const payload = await readJson<{ cardId?: string }>(req, res);
				if (!payload) return;
				const at = cards.findIndex((candidate) => candidate.id === payload.cardId);
				if (at < 0) {
					res.writeHead(404, { "Content-Type": "text/plain" });
					res.end("no such card");
					return;
				}
				// A closed card leaves the board for good; only a later update with the same key
				// brings it back, and then it arrives as a fresh card.
				const [closed] = cards.splice(at, 1);
				// Closing a message that has not been handed over yet cancels it outright. An
				// exchange already inside the session still has an answer coming, so the card is
				// kept aside and put back when that answer arrives.
				forgetCard(closed.id);
				if (awaitingAnswer(closed.id)) closedCards.set(closed.id, closed);
				broadcast(board ?? ({ clients } as Board), { type: "remove", id: closed.id });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ closed: closed.id }));
				return;
			}
			if (req.method === "POST" && url.pathname === "/answer") {
				const payload = await readJson<{ cardId?: string; answer?: string }>(req, res);
				if (!payload) return;
				const card = cards.find((candidate) => candidate.id === payload.cardId);
				if (!card || card.type !== "question" || card.status !== "open") {
					res.writeHead(409, { "Content-Type": "text/plain" });
					res.end("no open question");
					return;
				}
				const answer = (payload.answer ?? "").trim();
				card.status = "answered";
				card.answer = answer;
				broadcast(board ?? { clients } as Board, { type: "update", card });
				pendingAnswers.get(card.id)?.(answer);
				pendingAnswers.delete(card.id);
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("ok");
				return;
			}
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("not found");
		})().catch((error: unknown) => {
			// A handler that throws used to leave the request unanswered, which the browser shows
			// as a reset. Answer something and keep the board serving.
			if (process.env.PI_BOARD_DEBUG === "1") console.error("[board]", error);
			if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("board error");
		});
	});

	// Chromium happily reuses a socket for minutes while Node closes an idle one after five
	// seconds, so a send that lands in that gap fails as a reset. Meeting halfway avoids it.
	server.keepAliveTimeout = 65_000;
	server.headersTimeout = 70_000;

	const created: Board = { server, token, port: 0, clients, cards, meta: EMPTY_META, activity };

	// Parallel sessions each need their own board, so walk upward from the preferred port
	// before giving up on a predictable number and letting the kernel pick one.
	let candidate = remembered.port ?? PREFERRED_PORT;
	const lastPort = candidate + 20;
	const attempt = () => {
		server.listen(candidate, "127.0.0.1");
	};
	server.on("error", () => {
		server.close();
		// The remembered port belongs to another live board now, so the remembered token is no
		// longer ours: a tab still holding it would get a 403 from whoever answers there.
		token = freshToken();
		created.token = token;
		if (candidate < lastPort) {
			candidate += 1;
			attempt();
			return;
		}
		server.listen(0, "127.0.0.1");
	});
	server.on("listening", () => {
		created.port = (server.address() as { port: number }).port;
		rememberBoard(process.cwd(), created.port, token);
	});
	attempt();
	return created;
}

let enabled = process.env.PI_BOARD_DISABLED !== "1";

function ensureBoard(): Board {
	if (!board) board = startBoard();
	return board;
}

/** Tools that answer politely instead of resurrecting a board the user switched off. */
const OFF_MESSAGE = "The board is off. Turn it on with /board on.";
const BOARD_TOOLS = new Set(["board_note", "board_source", "board_ask", "board_clear"]);

function boardForTool(): Board | undefined {
	return enabled ? ensureBoard() : undefined;
}

/** Announce the URL once the port is actually bound, which can happen after fallback. */
function announceBoard(target: Board, ctx?: ExtensionContext): void {
	const show = () => {
		if (ctx?.hasUI && target.port) ctx.ui.notify(`Board: ${urlFor(target)}`, "info");
	};
	if (target.port) show();
	else target.server.once("listening", show);
}

/** Opening the board is a desktop convenience, so a headless box just skips it. */
function openInBrowser(target: Board): void {
	const opener =
		process.env.PI_BOARD_OPENER ??
		(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open");
	try {
		const child = spawn(opener, [urlFor(target)], { detached: true, stdio: "ignore" });
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// No browser on this machine; the printed URL is still enough.
	}
}

/** Run once the port is really bound, which can happen after the fallback bind. */
function whenListening(target: Board, run: () => void): void {
	if (target.port) run();
	else target.server.once("listening", run);
}

function stopBoard(): void {
	if (!board) return;
	for (const client of board.clients) client.end();
	board.clients.clear();
	board.server.close();
	board = undefined;
	for (const resolveAnswer of pendingAnswers.values()) resolveAnswer("");
	pendingAnswers.clear();
}

/** Resolve a path inside the session working directory, refusing to escape it. */
function confinedPath(target: string): string {
	const root = currentCtx?.cwd ?? process.cwd();
	const absolute = resolve(root, target);
	const rel = relative(root, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`${target} is outside the working directory`);
	}
	return absolute;
}

let cardSeq = 0;
const nextId = () => `c${Date.now().toString(36)}${(cardSeq++).toString(36)}`;

const noteTool = defineTool({
	name: "board_note",
	label: "Board note",
	description:
		"Put a note on the user's visual board. Use it for breadcrumbs, findings, summaries and todo lists instead of writing prose into the terminal. Markdown is rendered; a fenced svg block draws a picture and a fenced block shows monospace text. Pass the same key again to update that note in place instead of adding another card.",
	parameters: Type.Object({
		markdown: Type.String({ description: "Note body in markdown." }),
		title: Type.Optional(Type.String({ description: "Short card title, for example the step name." })),
		key: Type.Optional(
			Type.String({ description: "Stable name for this note, e.g. 'todo'. Reusing it updates the same card." }),
		),
	}),
	async execute(_id, params, _signal, _onUpdate, ctx) {
		currentCtx = ctx ?? currentCtx;
		const target = boardForTool();
		if (!target) return { content: [{ type: "text", text: OFF_MESSAGE }], details: undefined };
		const card: NoteCard = {
			id: nextId(),
			type: "note",
			key: params.key,
			title: params.title,
			markdown: params.markdown,
			at: Date.now(),
		};
		if (upsert(target, card)) turnNotes.push({ id: card.id, text: params.markdown });
		emit("board:note", { title: params.title, text: params.markdown });
		return {
			content: [
				{
					type: "text",
					text: `${params.key ? "Updated" : "Added"} board note${params.title ? `: ${params.title}` : ""} (id ${card.id}).`,
				},
			],
			details: { cardId: card.id },
		};
	},
});

const sourceTool = defineTool({
	name: "board_source",
	label: "Board source",
	description:
		"Open a file on the user's board, scrolled to a line. Pass the same key (defaults to the path) to refresh an already open card after the file changes.",
	parameters: Type.Object({
		path: Type.String({ description: "File path, relative to the working directory." }),
		line: Type.Optional(Type.Number({ description: "Line to centre the view on." })),
		title: Type.Optional(Type.String({ description: "Optional card title, defaults to the file name." })),
		key: Type.Optional(Type.String({ description: "Stable name for this card. Defaults to the file path." })),
	}),
	async execute(_id, params, _signal, _onUpdate, ctx) {
		currentCtx = ctx ?? currentCtx;
		const absolute = confinedPath(params.path);
		const raw = await readFile(absolute, "utf8");
		if (raw.length > MAX_SOURCE_BYTES) throw new Error(`${params.path} is too large for the board`);
		const target = boardForTool();
		if (!target) return { content: [{ type: "text", text: OFF_MESSAGE }], details: undefined };
		const card: SourceCard = {
			id: nextId(),
			type: "source",
			key: params.key ?? params.path,
			title: params.title ?? params.path.split("/").pop() ?? params.path,
			path: params.path,
			content: raw,
			line: params.line,
			at: Date.now(),
		};
		upsert(target, card);
		return {
			content: [
				{
					type: "text",
					text: `Opened ${params.path}${params.line ? ` at line ${params.line}` : ""} on the board (${raw.split("\n").length} lines).`,
				},
			],
			details: { cardId: card.id, lines: raw.split("\n").length },
		};
	},
});

const askTool = defineTool({
	name: "board_ask",
	label: "Ask on board",
	description:
		"Ask the user a question on the board and wait for their click. Use this for decisions that are genuinely theirs instead of guessing. Blocks until they answer or the question times out.",
	parameters: Type.Object({
		question: Type.String({ description: "The question, in one or two sentences." }),
		options: Type.Array(Type.String(), {
			description: "Two to four choices the user can click, each a short phrase.",
		}),
		title: Type.Optional(Type.String({ description: "Optional card title." })),
		allowFreeText: Type.Optional(Type.Boolean({ description: "Also allow a typed answer. Defaults to true." })),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		currentCtx = ctx ?? currentCtx;
		const target = boardForTool();
		if (!target) return { content: [{ type: "text", text: OFF_MESSAGE }], details: undefined };
		const card: QuestionCard = {
			id: nextId(),
			type: "question",
			title: params.title ?? "question",
			question: params.question,
			options: params.options.slice(0, 6),
			allowFreeText: params.allowFreeText !== false,
			status: "open",
			at: Date.now(),
		};
		upsert(target, card);
		emit("board:note", { title: card.title, text: params.question });

		const answer = await new Promise<string>((done) => {
			const finish = (value: string) => {
				clearTimeout(timer);
				pendingAnswers.delete(card.id);
				done(value);
			};
			const timer = setTimeout(() => finish(""), ASK_TIMEOUT_MS);
			pendingAnswers.set(card.id, finish);
			signal?.addEventListener("abort", () => finish(""));
		});

		if (!answer) {
			card.status = "answered";
			card.answer = "no answer";
			upsert(target, card);
			return {
				content: [{ type: "text", text: "The user did not answer on the board." }],
				details: { cardId: card.id, answered: false },
			};
		}
		card.status = "answered";
		card.answer = answer;
		upsert(target, card);
		return {
			content: [{ type: "text", text: `The user answered on the board: ${answer}` }],
			details: { cardId: card.id, answered: true },
		};
	},
});

const clearTool = defineTool({
	name: "board_clear",
	label: "Clear board",
	description: "Remove every card from the user's board.",
	parameters: Type.Object({}),
	async execute(_id, _params, _signal, _onUpdate, ctx) {
		currentCtx = ctx ?? currentCtx;
		const target = boardForTool();
		if (!target) return { content: [{ type: "text", text: OFF_MESSAGE }], details: undefined };
		target.cards.length = 0;
		broadcast(target, { type: "clear" });
		return { content: [{ type: "text", text: "Board cleared." }], details: undefined };
	},
});

export default function dashboardExtension(pi: ExtensionAPI) {
	emit = (name, data) => pi.events.emit(name, data);

	pi.registerTool(noteTool);
	pi.registerTool(sourceTool);
	pi.registerTool(askTool);
	pi.registerTool(clearTool);

	// alt+d is already pi's delete-word-forward, so the board takes alt+o for "open".
	pi.registerShortcut("alt+o", {
		description: "Toggle the board, opening it in the browser when switched on",
		handler: async (ctx) => {
			currentCtx = ctx;
			if (enabled) {
				enabled = false;
				stopBoard();
				ctx.ui.notify("Board off", "info");
				return;
			}
			enabled = true;
			const target = ensureBoard();
			announceBoard(target, ctx);
			whenListening(target, () => openInBrowser(target));
		},
	});

	pi.registerCommand("board", {
		description: "Show the board URL: /board [on|off|clear]",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const verb = args.trim().toLowerCase();
			if (verb === "off") {
				enabled = false;
				stopBoard();
				ctx.ui.notify("Board off. Cards and tools are gone until /board on.", "info");
				return;
			}
			if (verb === "on") {
				enabled = true;
				const target = ensureBoard();
				announceBoard(target, ctx);
				whenListening(target, () => openInBrowser(target));
				return;
			}
			if (verb === "clear") {
				const target = boardForTool();
				if (!target) {
					ctx.ui.notify(OFF_MESSAGE, "warning");
					return;
				}
				target.cards.length = 0;
				broadcast(target, { type: "clear" });
				ctx.ui.notify("Board cleared", "info");
				return;
			}
			announceBoard(ensureBoard(), ctx);
		},
	});

	// Voice mode is independent, but when it speaks it announces the line here, so the
	// user reads exactly what they heard instead of guessing at the difference.
	pi.events.on("voice:spoken", (data) => {
		if (!board) return;
		const line = (data as { text?: string }).text;
		if (!line) return;
		upsert(board, { id: nextId(), type: "note", title: "spoken", markdown: line, at: Date.now() });
	});

	// The composer hands messages straight to the session: a steer lands mid-run, a queue
	// waits for the agent to finish what it is doing. A follow-up carries the card it is about.
	deliver = async (text, mode, images, preamble) => {
		const words = preamble ? `${preamble}${text}` : text;
		// An image pasted into the composer reaches the agent as an image part, exactly as if
		// it had been pasted into the terminal.
		const content =
			images.length === 0
				? words
				: [
						{ type: "text" as const, text: words },
						...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
					];
		await pi.sendUserMessage(content, { deliverAs: mode === "steer" ? "steer" : "followUp" });
	};

	// Every tool call becomes a row in the activity rail, so the board shows the work
	// instead of the terminal scrolling past it.
	pi.on("turn_start", async () => {
		turnNotes.length = 0;
	});

	pi.on("tool_execution_start", async (event) => {
		callArgs.set(event.toolCallId, event.args);
		if (!board) return;
		pushActivity(board, {
			id: event.toolCallId,
			kind: "tool",
			tool: event.toolName,
			label: toolLabel(event.toolName, event.args),
			target: toolTarget(event.args),
			status: "running",
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_end", async (event) => {
		if (!board) return;
		const result = resultText(event.result);
		if (process.env.PI_BOARD_DEBUG === "1") {
			try {
				writeFileSync("/tmp/board-tool-result.json", JSON.stringify({ tool: event.toolName, isError: event.isError, text: result }, null, 2));
			} catch {
				// debug only
			}
		}
		// The exit marker is machinery, not output, so it never reaches the row.
		const shown = { content: [{ type: "text", text: stripExitMarker(result) }] };
		const failed = failedCall(event.isError, result);
		patchActivity(board, event.toolCallId, {
			status: failed ? "error" : "ok",
			durationMs: event.durationMs,
			summary: resultSummary(shown),
		});
		// The outcome phrase lands immediately, then the cheap model may sharpen it.
		const outcome = toolOutcome(event.isError, result);
		if (outcome) {
			patchActivity(
				board,
				event.toolCallId,
				outcome.startsWith("failed") ? { label: outcome, status: "error" } : { label: outcome },
			);
		}
		queueRowLabel(
			event.toolCallId,
			event.toolName,
			callArgs.get(event.toolCallId),
			result,
			event.isError,
			failed,
			outcome,
		);
		callArgs.delete(event.toolCallId);
	});

	// A delegate run lasts minutes and ends in a report the user reads. The rail can only show one
	// line of it, so the run gets a card that states where it is and then holds the outcome.
	interface DelegateRun {
		role: string;
		task: string;
		tools: string[];
		toolCount: number;
		fileCount: number;
		cost: number;
		startedAt: number;
		status?: string;
		summary?: string;
	}
	const delegateRuns = new Map<string, DelegateRun>();

	const elapsed = (ms: number): string => {
		const total = Math.max(0, Math.round(ms / 1000));
		if (total < 60) return `${total}s`;
		const minutes = Math.floor(total / 60);
		if (minutes < 60) return `${minutes}m ${total % 60}s`;
		return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	};

	function delegateMarkdown(run: DelegateRun, durationMs: number): string {
		const finished = run.status && run.status !== "running";
		const facts = [
			`**${finished ? run.status : "running"}** · ${elapsed(durationMs)}`,
			`${run.toolCount} tool${run.toolCount === 1 ? "" : "s"}`,
			run.fileCount ? `${run.fileCount} file${run.fileCount === 1 ? "" : "s"} changed` : "",
			run.cost > 0 ? `$${run.cost.toFixed(2)}` : "",
		].filter(Boolean);
		// The task's first line is the assignment; the rest is detail the card has no room for.
		const brief = (run.task.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
		const shown = brief.length > 160 ? `${brief.slice(0, 157)}…` : brief;
		const lines = [facts.join(" · "), "", `> ${shown}`];
		if (finished && run.summary) lines.push("", run.summary);
		if (run.tools.length) lines.push("", ...run.tools.slice(-6).map((tool) => `- \`${tool}\``));
		return lines.join("\n");
	}

	pi.events.on("delegate:progress", (data) => {
		const event = data as {
			toolCallId?: string;
			role?: string;
			task?: string;
			tools?: string[];
			toolCount?: number;
			fileCount?: number;
			cost?: number;
			durationMs?: number;
			status?: string;
			summary?: string;
		};
		const target = board;
		if (!target || !event.toolCallId) return;
		const run = delegateRuns.get(event.toolCallId) ?? {
			role: event.role ?? "delegate",
			task: event.task ?? "",
			tools: [],
			toolCount: 0,
			fileCount: 0,
			cost: 0,
			startedAt: Date.now() - (event.durationMs ?? 0),
		};
		run.tools = event.tools ?? run.tools;
		run.toolCount = event.toolCount ?? run.toolCount;
		run.fileCount = event.fileCount ?? run.fileCount;
		run.cost = event.cost ?? run.cost;
		if (event.status) run.status = event.status;
		if (event.summary) run.summary = event.summary;
		delegateRuns.set(event.toolCallId, run);
		// A long session can run hundreds of these; the card is what matters, not the memory.
		if (delegateRuns.size > 40) {
			const oldest = delegateRuns.keys().next().value;
			if (oldest) delegateRuns.delete(oldest);
		}
		upsert(target, {
			id: nextId(),
			type: "note",
			key: `delegate-${event.toolCallId}`,
			title: `delegate · ${run.role}`,
			markdown: delegateMarkdown(run, event.durationMs ?? Date.now() - run.startedAt),
			at: run.startedAt,
		});
	});

	// A finished turn closes with its answer text, which is what keeps the console closed.
	pi.on("turn_end", async (event) => {
		if (!board) return;
		const message = event.message as { role?: string };
		if (message.role !== "assistant") return;
		const text = textOf(message as { content?: unknown });
		if (!text) return;
		pushActivity(board, {
			id: nextId(),
			kind: "reply",
			status: "ok",
			startedAt: Date.now(),
			text: text.slice(0, 4000),
		});
		const waiting = awaitingTurns.shift();
		if (waiting) {
			// A card closed mid-run comes back holding the answer, rather than the answer landing
			// on a new card the user never asked for.
			restoreClosedCard(waiting.cardId);
			setPending(waiting, "answered", text.slice(0, 4000));
			// The answer belongs in the sticky. A note that copied it is noise, so it goes.
			for (const note of turnNotes.splice(0)) {
				if (!repeatsAnswer(note.text, text)) continue;
				const index = board.cards.findIndex((card) => card.id === note.id);
				if (index < 0) continue;
				const [dropped] = board.cards.splice(index, 1);
				broadcast(board, { type: "remove", id: dropped.id });
				pushActivity(board, {
					id: nextId(),
					kind: "tool",
					tool: "board_note",
					status: "ok",
					startedAt: Date.now(),
					summary: "dropped a note that repeated the answer",
				});
			}
		}
	});

	// The header is the user's only view of the session, so keep it current on every turn.
	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant" && addUsage(event.message as { usage?: { input?: number; output?: number; cost?: { total?: number } } })) {
			pushMeta();
		}
	});

	pi.on("model_select", async () => {
		pushMeta();
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		// Only the interactive session owns a port; print and subagent runs stay headless.
		if (enabled && ctx.mode === "tui") {
			announceBoard(ensureBoard(), ctx);
			pushMeta();
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		currentCtx = ctx;
		running = true;
		pushMeta();
		const live = Boolean(enabled && board) && ctx.mode === "tui";
		if (live) {
			pushMeta();
			event.systemPromptOptions.sections.dashboard = BOARD_PROMPT;
			if (event.messageType === "user") {
				return { message: { customType: "dashboard-reminder", content: BOARD_PROMPT, display: false } };
			}
		} else {
			delete event.systemPromptOptions.sections.dashboard;
			// With no board there is nothing to draw on, so the model is not offered the tools
			// and never has to discover that they are a dead end.
			const tools = event.systemPromptOptions.selectedTools;
			if (Array.isArray(tools)) {
				event.systemPromptOptions.selectedTools = tools.filter((name) => !BOARD_TOOLS.has(name));
			}
		}
	});

	// A stopped run leaves rows spinning in the rail, so close them and tell the sticky
	// that asked what happened to it.
	pi.on("agent_settled", async (event) => {
		running = false;
		if (board) {
			for (const row of board.activity) {
				if (row.kind === "tool" && row.status === "running") {
					row.status = "error";
					row.summary = "stopped";
					broadcast(board, { type: "activity", row });
				}
			}
			if (event.aborted) {
				const waiting = awaitingTurns.shift();
				// A stopped run answers nothing, so a remembered question has no use left.
				if (waiting) {
					if (!setPending(waiting, "stopped", "stopped before this answer arrived")) {
						closedCards.delete(waiting.cardId);
					}
				}
			}
		}
		pushMeta();
		void pumpOutbox();
	});

	pi.on("session_shutdown", async () => {
		stopBoard();
	});
}
