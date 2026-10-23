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

type Card = NoteCard | SourceCard | QuestionCard;

interface Board {
	server: Server;
	token: string;
	port: number;
	clients: Set<ServerResponse>;
	cards: Card[];
}

let board: Board | undefined;
let currentCtx: ExtensionContext | undefined;
let emit: (name: string, data: unknown) => void = () => {};
const pendingAnswers = new Map<string, (answer: string) => void>();

const BOARD_PROMPT = [
	"[DASHBOARD MODE: the user watches a visual board, so put your narration there instead of in prose]",
	"Send every breadcrumb, finding and summary the user should read through board_note, one note per step, short and conversational.",
	"Open the file you are talking about with board_source and pass the line you mean, so the user sees it without hunting.",
	"Keep a card updated by passing the same key again: a todo list grows, a status note changes, a source card refreshes after you edit the file.",
	"When a decision is genuinely the user's, ask with board_ask instead of guessing; it blocks until they click.",
	"Inside a note, a fenced svg block renders as a picture and a fenced block renders as monospace text; use them for diagrams, palettes, graphs and file trees.",
	"Your normal reply still goes to the transcript: keep it to a few lines, because the substance belongs on the board.",
].join("\n");

function urlFor(target: Board): string {
	return `http://127.0.0.1:${target.port}/?token=${target.token}`;
}

function broadcast(target: Board, message: unknown): void {
	const payload = `data: ${JSON.stringify(message)}\n\n`;
	for (const client of target.clients) client.write(payload);
}

/** Insert or replace by key, so a repeated key refreshes the existing card. */
function upsert(target: Board, card: Card): void {
	const existing = card.key ? target.cards.findIndex((candidate) => candidate.key === card.key) : -1;
	if (existing >= 0) {
		const previous = target.cards[existing];
		card.id = previous.id; // keep identity stable so the browser updates in place
		target.cards[existing] = card;
		broadcast(target, { type: "update", card });
		return;
	}
	target.cards.push(card);
	if (target.cards.length > 200) target.cards.shift();
	broadcast(target, { type: "card", card });
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
				res.write(`data: ${JSON.stringify({ type: "snapshot", cards })}\n\n`);
				clients.add(res);
				const keepAlive = setInterval(() => res.write(`: ping\n\n`), 20_000);
				req.on("close", () => {
					clearInterval(keepAlive);
					clients.delete(res);
				});
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

	const created: Board = { server, token, port: 0, clients, cards };
	// The listen error arrives asynchronously, so port 0 is the fallback rather than a try/catch.
	server.on("error", () => {
		server.close();
		server.listen(0, "127.0.0.1");
	});
	server.on("listening", () => {
		created.port = (server.address() as { port: number }).port;
	});
	server.listen(PREFERRED_PORT, "127.0.0.1");
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
		upsert(target, card);
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

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		// Only the interactive session owns a port; print and subagent runs stay headless.
		if (enabled && ctx.mode === "tui") announceBoard(ensureBoard(), ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		currentCtx = ctx;
		if (board && ctx.mode === "tui") {
			event.systemPromptOptions.sections.dashboard = BOARD_PROMPT;
			if (event.messageType === "user") {
				return { message: { customType: "dashboard-reminder", content: BOARD_PROMPT, display: false } };
			}
		} else {
			delete event.systemPromptOptions.sections.dashboard;
		}
	});

	pi.on("session_shutdown", async () => {
		stopBoard();
	});
}
