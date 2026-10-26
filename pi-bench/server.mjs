/**
 * pi-bench — a local daemon that owns pi agents. A thread is one card on a canvas and one
 * `pi --mode rpc` child process. The browser client is the board's established one: the daemon
 * speaks the routes it already calls rather than shipping a second UI.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

/**
 * The client is the board's established one, served from the extension folder rather than copied
 * here. The daemon's job is to be what that client talks to; a second UI next to it is a defect.
 */
const PUBLIC_DIR = fileURLToPath(new URL("../dashboard/public/", import.meta.url));
/** The token lives here so a restart reuses it. The port is recorded for debugging only. */
const STATE_FILE = join(homedir(), ".pi", "agent", "state", "pi-bench.json");
const PROVIDER = process.env.PI_BENCH_PROVIDER ?? "klotilda";
const MODEL = process.env.PI_BENCH_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const TOOLS = "read,bash,edit,write";
const MAX_BODY_BYTES = 1_000_000;
const MAX_ACTIVITY = 300;
const BROWSE_LIMIT = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * One exchange with a thread. The question lives on the thread so the card shows the conversation
 * the way the extension's stickies did: the words typed in, and the answer once it lands.
 * @typedef {object} Turn
 * @property {string} text
 * @property {"queued"|"sent"|"answered"|"stopped"} status
 * @property {"queue"|"steer"} mode
 * @property {number} at
 * @property {string} [reply]
 */

/**
 * A thread is one card on the canvas and one child process on demand.
 * @typedef {object} Thread
 * @property {string} id
 * @property {string} title
 * @property {string|null} sessionId
 * @property {"idle"|"running"|"dead"} status
 * @property {string} folder
 * @property {string} provider
 * @property {string} model
 * @property {number} at
 * @property {Turn[]} turns
 * @property {string[]} queued messages waiting for the run in flight to settle
 * @property {{x:number,y:number,w:number,h:number}} [rect]
 * @property {boolean} [mini]
 */

/** @type {Map<string, Thread>} */
const threads = new Map();
/** @type {object[]} */
const activity = [];
/** @type {Set<import("node:http").ServerResponse>} */
const clients = new Set();
/** The live child behind a thread. Kept beside the thread so the thread record stays plain JSON. */
const children = new Map();

function readRememberedToken() {
	try {
		const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		if (typeof saved?.token === "string" && saved.token) return saved.token;
	} catch {
		// No usable state file: a fresh token below is still a working board.
	}
	return randomBytes(16).toString("hex");
}

function rememberToken(token, port) {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
		// Two daemons can start at once, so the new file replaces the old one in a single step.
		const temp = `${STATE_FILE}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ token, port, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, STATE_FILE);
	} catch (error) {
		console.error(`pi-bench: could not write ${STATE_FILE}: ${error.message}`);
	}
}

/**
 * The CLI a child needs. Same order as delegate.ts: the script this process is already running
 * pi from, then the managed install, then the `pi` binary on PATH.
 */
function piCli() {
	const script = process.argv[1];
	if (script && existsSync(script) && (basename(script) === "pi" || script.includes("pi-coding-agent"))) {
		return { command: process.execPath, args: [script] };
	}
	const root = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
	try {
		const version = readFileSync(join(root, "current-version"), "utf8").trim();
		const cli = join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		if (version && existsSync(cli)) return { command: process.execPath, args: [cli] };
	} catch {
		// No managed install here; PATH is the last resort.
	}
	return { command: "pi", args: [] };
}

/** The short text a rail row shows. Arguments stay out of it: the row is a signpost, not a log. */
function describeTool(name, args) {
	if (name === "read" || name === "write" || name === "edit") return `${name} ${String(args.path ?? args.file_path ?? "")}`.trim();
	if (name === "bash") {
		const command = String(args.command ?? "").replace(/\s+/g, " ");
		return `$ ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`;
	}
	if (name === "grep") return `grep ${String(args.pattern ?? "")}`;
	if (name === "find") return `find ${String(args.pattern ?? "*")}`;
	return name;
}

/** What a tool row says once the call is over: its first line of output, cut short. */
function firstLine(result) {
	const content = Array.isArray(result?.content) ? result.content : [];
	const text = content
		.filter((part) => part?.type === "text")
		.map((part) => String(part.text ?? ""))
		.join("\n");
	return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 140) ?? "";
}

// ---------- the board the client draws -------------------------------------

/** A thread as the card the browser has always drawn: a message with a conversation under it. */
function cardFor(thread) {
	const answered = thread.turns.some((turn) => turn.status === "answered");
	const status =
		thread.status === "dead"
			? "stopped"
			: thread.status === "running"
				? "sent"
				: answered
					? "answered"
					: thread.turns.length
						? "queued"
						: "queued";
	const card = {
		id: thread.id,
		type: "sticky",
		title: thread.title,
		at: thread.at,
		// The conversation lives in the turns; the card's own `text` stays empty so no message is
		// invented for a thread that the human has not typed into yet.
		text: "",
		status,
		mode: "queue",
		images: 0,
		turns: thread.turns.map((turn) => ({ ...turn })),
	};
	if (thread.rect) card.rect = thread.rect;
	if (thread.mini) card.mini = true;
	return card;
}

function meta() {
	const working = [...threads.values()].filter((thread) => thread.status === "running");
	return {
		folder: basename(process.cwd()),
		cwd: process.cwd(),
		port,
		model: MODEL,
		tokensIn: 0,
		tokensOut: 0,
		cost: 0,
		// Tells the shared client to lay itself out as a board of threads: no bottom composer, a
		// + button, and the field living inside the card being answered.
		mode: "threads",
		contextPercent: null,
		running: working.length > 0,
		runStartedAt: working.length ? Math.min(...working.map((thread) => thread.runStartedAt ?? thread.at)) : null,
	};
}

function broadcast(payload) {
	const frame = `data: ${JSON.stringify(payload)}\n\n`;
	for (const client of clients) {
		// A tab that closed is still in the set for a moment; writing to its dead socket would
		// raise an error nobody is listening for.
		if (client.writableEnded || client.destroyed) {
			clients.delete(client);
			continue;
		}
		client.write(frame);
	}
}

const card = (thread) => broadcast({ type: "card", card: cardFor(thread) });
const update = (thread) => broadcast({ type: "update", card: cardFor(thread) });

function addRow(row) {
	activity.push(row);
	if (activity.length > MAX_ACTIVITY) activity.splice(0, activity.length - MAX_ACTIVITY);
	broadcast({ type: "activity", row });
}

function patchRow(id, patch) {
	const row = activity.find((candidate) => candidate.id === id);
	if (!row) return;
	Object.assign(row, patch);
	broadcast({ type: "activity", row });
}

/** Something the daemon cannot paper over: the card shows it as stopped and the console says why. */
function threadError(thread, message) {
	console.error(`pi-bench: ${thread.title}: ${message}`);
	thread.status = "dead";
	const last = thread.turns[thread.turns.length - 1];
	if (last && last.status !== "answered") last.status = "stopped";
	addRow({ id: randomUUID(), kind: "reply", status: "error", startedAt: Date.now(), text: message });
	update(thread);
	children.get(thread.id)?.stdin?.end();
}

// ---------- the child ------------------------------------------------------

function childArgv(thread) {
	return ["--mode", "rpc", "--no-session", "-ne", "--tools", TOOLS, "--provider", thread.provider, "--model", thread.model];
}

/** The thread's child, started on first use. One child per thread, reused until it exits. */
function ensureChild(thread) {
	const existing = children.get(thread.id);
	if (existing && existing.exitCode === null && existing.stdin?.writable) return existing;
	const cli = piCli();
	const child = spawn(cli.command, [...cli.args, ...childArgv(thread)], {
		cwd: thread.folder,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.set(thread.id, child);
	// A child that died between two messages turns the next write into EPIPE. That is a card
	// error, not a daemon crash.
	child.stdin.on("error", (error) => threadError(thread, `child stdin failed: ${error.message}`));
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) handleChildLine(thread, line);
	});
	// Stdout is protocol only; diagnostics arrive here and belong in the daemon's own log.
	child.stderr.on("data", (chunk) => process.stderr.write(`[${thread.title}] ${chunk}`));
	child.on("error", (error) => {
		children.delete(thread.id);
		threadError(thread, `child failed to start: ${error.message}`);
	});
	child.on("close", (code, signal) => {
		children.delete(thread.id);
		// An exit after `agent_settled` is the orderly shutdown this daemon asked for. An exit
		// while a run is live is the child dying mid-answer.
		if (thread.status === "running") threadError(thread, `child exited (${signal ?? code}) before it settled`);
	});
	// RPC mode emits no session header, so get_state is the only place a session id can come from.
	child.stdin.write(`${JSON.stringify({ id: "session", type: "get_state" })}\n`);
	return child;
}

/** One prompt, either a new question or what was waiting behind the run in flight. */
function prompt(thread, text) {
	const turn = thread.turns[thread.turns.length - 1];
	if (turn) turn.status = "sent";
	thread.status = "running";
	thread.runStartedAt = Date.now();
	update(thread);
	try {
		const child = ensureChild(thread);
		child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "prompt", message: text })}\n`);
	} catch (error) {
		threadError(thread, `could not send to the child: ${error.message}`);
	}
}

function handleChildLine(thread, line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		process.stderr.write(`[${thread.title}] unparsed child line: ${line.slice(0, 200)}\n`);
		return;
	}
	if (event.type === "response") {
		if (event.command === "get_state" && typeof event.data?.sessionId === "string") {
			thread.sessionId = event.data.sessionId;
			update(thread);
		} else if (event.command === "prompt" && event.success === false) {
			// A rejected prompt starts no run, so no agent_settled would ever arrive.
			threadError(thread, `prompt rejected: ${event.error ?? "unknown reason"}`);
		} else if (event.command === "prompt" && event.data?.disposition === "handled") {
			threadError(thread, "the message was handled as a command, so no run started");
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		addRow({
			id: String(event.toolCallId),
			kind: "tool",
			tool: String(event.toolName ?? "tool"),
			label: describeTool(event.toolName, event.args ?? {}),
			status: "running",
			startedAt: Date.now(),
		});
		return;
	}
	if (event.type === "tool_execution_end") {
		patchRow(String(event.toolCallId), {
			status: event.isError ? "error" : "ok",
			durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
			summary: firstLine(event.result),
		});
		return;
	}
	if (event.type === "turn_end" && event.message?.role === "assistant") {
		const message = event.message;
		const text = (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block?.type === "text")
			.map((block) => String(block.text ?? ""))
			.join("")
			.trim();
		if (!text) return;
		const turn = thread.turns[thread.turns.length - 1];
		if (turn) {
			turn.reply = text;
			turn.status = "answered";
		}
		addRow({ id: randomUUID(), kind: "reply", status: "ok", startedAt: Date.now(), text: text.slice(0, 4000) });
		update(thread);
		return;
	}
	if (event.type === "agent_settled") {
		thread.status = "idle";
		// A turn whose answer was redirected by a steer, or whose run was stopped, never gets a reply
		// of its own. It reads as stopped rather than as a message still being worked on.
		for (const turn of thread.turns) if (turn.status === "sent") turn.status = "stopped";
		update(thread);
		// Nothing runs after settle, so closing stdin is what lets the child exit.
		children.get(thread.id)?.stdin?.end();
		const next = thread.queued.shift();
		if (next) {
			thread.turns.push({ text: next, status: "queued", mode: "queue", at: Date.now() });
			update(thread);
			prompt(thread, next);
		}
	}
}

// ---------- routes --------------------------------------------------------

function readBody(req, limit = MAX_BODY_BYTES) {
	return new Promise((done) => {
		const chunks = [];
		let size = 0;
		let oversized = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) oversized = true;
			else chunks.push(chunk);
		});
		req.on("end", () => done(oversized ? undefined : Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => done(undefined));
	});
}

/** Read and parse a JSON body. Answers 400 or 413 itself and returns null, so the caller stops. */
async function readJson(req, res) {
	const body = await readBody(req);
	if (body === undefined) {
		fail(res, 413, "body too large");
		return null;
	}
	if (!body.trim()) return {};
	try {
		return JSON.parse(body);
	} catch {
		fail(res, 400, "bad json");
		return null;
	}
}

function fail(res, status, message) {
	res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
	res.end(message);
	return undefined;
}

function answer(res, status, payload) {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(payload));
}

function serveStatic(res, file, type) {
	try {
		const body = readFileSync(join(PUBLIC_DIR, file));
		res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
		res.end(body);
	} catch (error) {
		console.error(`pi-bench: cannot serve ${file}: ${error.message}`);
		fail(res, 404, "not found");
	}
}

function createThread(body) {
	const thread = {
		id: randomUUID(),
		title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 80) : `thread ${threads.size + 1}`,
		sessionId: null,
		status: "idle",
		folder: typeof body.folder === "string" && body.folder ? resolve(body.folder) : process.cwd(),
		provider: PROVIDER,
		model: typeof body.model === "string" && body.model ? body.model : MODEL,
		at: Date.now(),
		turns: [],
		queued: [],
	};
	// Creation does not spawn: the child starts on the first message, so an empty board costs nothing.
	threads.set(thread.id, thread);
	return thread;
}

async function onThread(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	const thread = createThread(body);
	card(thread);
	answer(res, 200, { threadId: thread.id, card: cardFor(thread) });
}

async function onMessage(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return void fail(res, 400, "empty message");
	const mode = body.mode === "steer" ? "steer" : "queue";
	const asked = typeof body.cardId === "string" ? body.cardId : "";
	let thread = asked ? threads.get(asked) : undefined;
	if (asked && !thread) return void fail(res, 409, "no such card");
	if (!thread) {
		// A message with no card behind it starts a thread of its own, named after what was asked.
		thread = createThread({ title: text.slice(0, 60) });
		card(thread);
	}
	if (thread.status === "dead") return void fail(res, 409, "thread ended");

	thread.turns.push({ text: text.slice(0, 4000), status: "queued", mode, at: Date.now() });
	const index = thread.turns.length - 1;
	update(thread);
	const running = thread.status === "running";
	if (running && mode === "steer") {
		// A steer joins the run in flight instead of waiting behind it.
		try {
			children.get(thread.id)?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "steer", message: text })}\n`);
		} catch (error) {
			threadError(thread, `could not steer the child: ${error.message}`);
		}
	} else if (running) {
		thread.queued.push(text);
	} else {
		prompt(thread, text);
	}
	answer(res, 200, { id: thread.id, turn: index });
}

async function onLayout(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	const thread = threads.get(String(body.cardId ?? ""));
	const rect = body.rect;
	if (!thread || !rect) return void fail(res, 409, "no such card");
	const clamp = (value) => Math.max(0, Math.min(40000, Math.round(Number.isFinite(Number(value)) ? Number(value) : 0)));
	thread.rect = { x: clamp(rect.x), y: clamp(rect.y), w: clamp(rect.w), h: clamp(rect.h) };
	if (typeof body.mini === "boolean") thread.mini = body.mini;
	broadcast({ type: "move", id: thread.id, rect: thread.rect, mini: thread.mini === true });
	answer(res, 200, { placed: thread.id });
}

async function onClose(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	const id = String(body.cardId ?? "");
	const thread = threads.get(id);
	if (!thread) return void fail(res, 404, "no such card");
	threads.delete(id);
	children.get(id)?.kill("SIGKILL");
	children.delete(id);
	broadcast({ type: "remove", id });
	answer(res, 200, { closed: id });
}

function onStop(res) {
	const running = [...threads.values()].filter((thread) => thread.status === "running");
	if (!running.length) return void fail(res, 409, "no run in progress");
	for (const thread of running) {
		const child = children.get(thread.id);
		// Abort lets the child settle and report; the kill is only for a child that will not.
		try {
			child?.stdin?.write(`${JSON.stringify({ id: randomUUID(), type: "abort" })}\n`);
		} catch {
			// A child gone already has nothing to abort.
		}
	}
	answer(res, 200, { stopped: running.map((thread) => thread.id) });
}

/** The composer's file picker walks folders and answers with paths, never with file contents. */
function onBrowse(url, res) {
	const start = process.cwd();
	const asked = url.searchParams.get("path") ?? "";
	let dir = start;
	let named = "";
	if (asked) {
		const expanded = asked === "~" ? homedir() : asked.startsWith("~/") ? join(homedir(), asked.slice(2)) : resolve(start, asked);
		try {
			dir = realpathSync(expanded);
			if (!statSync(dir).isDirectory()) {
				named = basename(dir);
				dir = dirname(dir);
			}
		} catch {
			return void fail(res, 404, `no such folder: ${asked}`);
		}
	}
	const query = (url.searchParams.get("q") ?? named).trim().toLowerCase();
	const entries = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			if (CONTROL_CHARS.test(entry.name)) continue;
			if (query && !entry.name.toLowerCase().includes(query)) continue;
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = statSync(join(dir, entry.name)).isDirectory();
				} catch {
					continue; // a link to nothing would only fail after it was picked
				}
			}
			entries.push({ name: entry.name, path: join(dir, entry.name), dir: isDir });
		}
	} catch {
		return void fail(res, 403, `cannot list ${dir}`);
	}
	entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
	answer(res, 200, {
		path: dir,
		parent: dirname(dir),
		home: homedir(),
		cwd: start,
		entries: entries.slice(0, BROWSE_LIMIT),
		total: entries.length,
		truncated: entries.length > BROWSE_LIMIT,
	});
}

const token = readRememberedToken();

const server = createServer((req, res) => {
	void (async () => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		// Static assets carry no session data, so the token only guards the data routes.
		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/board.js")) {
			serveStatic(
				res,
				url.pathname === "/" ? "index.html" : "board.js",
				url.pathname === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
			);
			return;
		}
		if (url.searchParams.get("token") !== token) {
			// A refused POST has to have its body taken off the wire, otherwise the client's next
			// request rides the same socket into the leftovers and reads as a reset.
			req.resume();
			fail(res, 403, "forbidden");
			return;
		}
		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
			res.write(
				`data: ${JSON.stringify({
					type: "snapshot",
					cards: [...threads.values()].map(cardFor),
					activity,
					meta: meta(),
				})}\n\n`,
			);
			clients.add(res);
			const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
			const forget = () => {
				clearInterval(keepAlive);
				clients.delete(res);
			};
			req.on("close", forget);
			res.on("error", forget);
			return;
		}
		// The rail's detail panel has no payloads here yet, so it says so instead of hanging.
		if (req.method === "GET" && url.pathname.startsWith("/activity/")) return void fail(res, 404, "no detail kept for this row");
		if (req.method === "GET" && url.pathname === "/browse") {
			onBrowse(url, res);
			return;
		}
		// Everything the board had for a single session: kept honest by refusing rather than lying.
		if (req.method === "GET" && url.pathname === "/state") {
			answer(res, 200, {
				threads: [...threads.values()].map((thread) => ({ ...thread, live: children.has(thread.id) })),
				cards: [...threads.values()].map(cardFor),
				activity,
				meta: meta(),
			});
			return;
		}
		if (req.method === "POST" && url.pathname === "/thread") {
			await onThread(req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/message") {
			await onMessage(req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/layout") {
			await onLayout(req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/close") {
			await onClose(req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/stop") {
			onStop(res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/compact") {
			fail(res, 409, "compaction belongs to the child, and no run is waiting on it");
			return;
		}
		if (req.method === "POST" && url.pathname === "/answer") {
			fail(res, 409, "questions are not wired to the daemon yet");
			return;
		}
		if (req.method === "POST" && url.pathname === "/edit") {
			fail(res, 409, "not an editable note");
			return;
		}
		fail(res, 404, "not found");
	})().catch((error) => {
		// A handler that throws used to leave the request unanswered, which the browser shows as a
		// reset. Answer something and keep the board serving.
		console.error(`pi-bench: ${error.stack ?? error}`);
		if (!res.headersSent) fail(res, 500, "board error");
		else res.end();
	});
});

function shutdown() {
	for (const child of children.values()) child.kill("SIGKILL");
	children.clear();
	server.close(() => process.exit(0));
	// A socket that will not close must not keep a stopped daemon alive.
	setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// A daemon that dies without a signal would otherwise leave its children running.
process.on("exit", () => {
	for (const child of children.values()) if (child.exitCode === null) child.kill("SIGKILL");
});

let port = 0;
server.listen(0, "127.0.0.1", () => {
	port = server.address().port;
	rememberToken(token, port);
	console.log(`pi-bench listening on http://127.0.0.1:${port}/?token=${token}`);
});
