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
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const PREFERRED_PORT = Number(process.env.PI_BOARD_PORT ?? 7374);
const MAX_SOURCE_BYTES = 2_000_000;
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

interface CardBase {
	id: string;
	key?: string;
	title?: string;
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
	mode: "queue" | "steer";
	reply?: string;
}

type Card = NoteCard | SourceCard | QuestionCard | StickyCard;

/** One row of the activity rail: a tool call, or the answer that closed a turn. */
interface ActivityRow {
	id: string;
	kind: "tool" | "reply";
	tool?: string;
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
let deliver: (text: string, mode: "queue" | "steer") => Promise<void> = async () => {};
/** Stickies waiting for an answer, oldest first, so replies land on the right question. */
const awaitingStickies: string[] = [];

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
	"Your transcript reply stays a couple of lines, because the substance belongs on the cards.",
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

const MAX_ACTIVITY = 300;
/** Which argument of a tool call names the thing the user cares about. */
const TARGET_KEYS = ["path", "file_path", "filePath", "command", "pattern", "query", "url", "target", "cmd"];

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

function urlFor(target: Board): string {
	return `http://127.0.0.1:${target.port}/?token=${target.token}`;
}

function broadcast(target: Board, message: unknown): void {
	const payload = `data: ${JSON.stringify(message)}\n\n`;
	for (const client of target.clients) client.write(payload);
}

/** Insert or replace by key, so a repeated key refreshes the existing card. */
function upsert(target: Board, card: Card): boolean {
	const existing = card.key ? target.cards.findIndex((candidate) => candidate.key === card.key) : -1;
	if (existing >= 0) {
		const previous = target.cards[existing];
		card.id = previous.id; // keep identity stable so the browser updates in place
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

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
	return new Promise((done) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > 64 * 1024) req.destroy();
		});
		req.on("end", () => done(body));
	});
}

function startBoard(): Board {
	const token = randomBytes(16).toString("hex");
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
				res.writeHead(403, { "Content-Type": "text/plain" });
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
				req.on("close", () => {
					clearInterval(keepAlive);
					clients.delete(res);
				});
				return;
			}
			if (req.method === "POST" && url.pathname === "/message") {
				if (url.searchParams.get("token") !== token) {
					res.writeHead(403, { "Content-Type": "text/plain" });
					res.end("bad token");
					return;
				}
				const body = await readBody(req);
				let payload: { text?: string; mode?: string } = {};
				try {
					payload = JSON.parse(body) as { text?: string; mode?: string };
				} catch {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("bad json");
					return;
				}
				const text = (payload.text ?? "").trim();
				if (!text) {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("empty message");
					return;
				}
				const mode = payload.mode === "steer" ? "steer" : "queue";
				const sticky: StickyCard = {
					id: nextId(),
					type: "sticky",
					text: text.slice(0, 4000),
					status: "queued",
					mode,
					title: "you",
					at: Date.now(),
				};
				cards.push(sticky);
				awaitingStickies.push(sticky.id);
				broadcast(board ?? ({ clients } as Board), { type: "card", card: sticky });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ id: sticky.id }));
				void deliver(text, mode)
					.then(() => {
						sticky.status = "sent";
						broadcast(board ?? ({ clients } as Board), { type: "update", card: sticky });
					})
					.catch(() => {
						sticky.status = "answered";
						sticky.reply = "could not deliver this message";
						broadcast(board ?? ({ clients } as Board), { type: "update", card: sticky });
					});
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
			if (req.method === "POST" && url.pathname === "/edit") {
				// The user owns the words in a note. A later board_note with the same key still
				// wins, which is the agent's way of refreshing its own card.
				const body = await readBody(req);
				let payload: { cardId?: string; markdown?: string } = {};
				try {
					payload = JSON.parse(body) as { cardId?: string; markdown?: string };
				} catch {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("bad json");
					return;
				}
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
				const body = await readBody(req);
				let payload: { cardId?: string } = {};
				try {
					payload = JSON.parse(body) as { cardId?: string };
				} catch {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("bad json");
					return;
				}
				const at = cards.findIndex((candidate) => candidate.id === payload.cardId);
				if (at < 0) {
					res.writeHead(404, { "Content-Type": "text/plain" });
					res.end("no such card");
					return;
				}
				// A closed card leaves the board for good; only a later update with the same key
				// brings it back, and then it arrives as a fresh card.
				const [closed] = cards.splice(at, 1);
				const waiting = awaitingStickies.indexOf(closed.id);
				if (waiting >= 0) awaitingStickies.splice(waiting, 1);
				broadcast(board ?? ({ clients } as Board), { type: "remove", id: closed.id });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ closed: closed.id }));
				return;
			}
			if (req.method === "POST" && url.pathname === "/answer") {
				const body = await readBody(req);
				let payload: { cardId?: string; answer?: string } = {};
				try {
					payload = JSON.parse(body) as { cardId?: string; answer?: string };
				} catch {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("bad json");
					return;
				}
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
		})();
	});

	const created: Board = { server, token, port: 0, clients, cards, meta: EMPTY_META, activity };

	// Parallel sessions each need their own board, so walk upward from the preferred port
	// before giving up on a predictable number and letting the kernel pick one.
	let candidate = PREFERRED_PORT;
	const attempt = () => {
		server.listen(candidate, "127.0.0.1");
	};
	server.on("error", () => {
		server.close();
		if (candidate < PREFERRED_PORT + 20) {
			candidate += 1;
			attempt();
			return;
		}
		server.listen(0, "127.0.0.1");
	});
	server.on("listening", () => {
		created.port = (server.address() as { port: number }).port;
	});
	attempt();
	return created;
}

let enabled = process.env.PI_BOARD_DISABLED !== "1";

function ensureBoard(): Board {
	if (!board) board = startBoard();
	return board;
}

/** Tools answer politely instead of resurrecting a board the user switched off. */
const OFF_MESSAGE = "The board is off. Turn it on with /board on.";

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
	// waits for the agent to finish what it is doing.
	deliver = async (text, mode) => {
		await pi.sendUserMessage(text, { deliverAs: mode === "steer" ? "steer" : "followUp" });
	};

	// Every tool call becomes a row in the activity rail, so the board shows the work
	// instead of the terminal scrolling past it.
	pi.on("turn_start", async () => {
		turnNotes.length = 0;
	});

	pi.on("tool_execution_start", async (event) => {
		if (!board) return;
		pushActivity(board, {
			id: event.toolCallId,
			kind: "tool",
			tool: event.toolName,
			target: toolTarget(event.args),
			status: "running",
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_end", async (event) => {
		if (!board) return;
		patchActivity(board, event.toolCallId, {
			status: event.isError ? "error" : "ok",
			durationMs: event.durationMs,
			summary: resultSummary(event.result),
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
		const waitingId = awaitingStickies.shift();
		const sticky = waitingId ? board.cards.find((card) => card.id === waitingId) : undefined;
		if (sticky && sticky.type === "sticky") {
			sticky.status = "answered";
			sticky.reply = text.slice(0, 4000);
			broadcast(board, { type: "update", card: sticky });
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
		if (board && ctx.mode === "tui") {
			pushMeta();
			event.systemPromptOptions.sections.dashboard = BOARD_PROMPT;
			if (event.messageType === "user") {
				return { message: { customType: "dashboard-reminder", content: BOARD_PROMPT, display: false } };
			}
		} else {
			delete event.systemPromptOptions.sections.dashboard;
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
				const waitingId = awaitingStickies.shift();
				const sticky = waitingId ? board.cards.find((card) => card.id === waitingId) : undefined;
				if (sticky && sticky.type === "sticky") {
					sticky.status = "stopped";
					sticky.reply = "stopped before this answer arrived";
					broadcast(board, { type: "update", card: sticky });
				}
			}
		}
		pushMeta();
	});

	pi.on("session_shutdown", async () => {
		stopBoard();
	});
}
