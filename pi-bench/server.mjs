/**
 * pi-bench — a local daemon that owns pi agents. One thread is one card on a canvas and one
 * `pi --mode rpc` child process. This slice proves one thread end to end: create it, type into it,
 * watch the answer land on the card.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

/**
 * The client is the board's established one, served from the extension folder rather than copied
 * here. The daemon's job is to be what that client talks to; a second UI next to it is a defect.
 * It is not wired to these routes yet, which is the next slice: the composer still posts the
 * extension's shapes.
 */
const PUBLIC_DIR = fileURLToPath(new URL("../dashboard/public/", import.meta.url));
/** The token lives here so a reload reuses it. The port is recorded for debugging only. */
const STATE_FILE = join(homedir(), ".pi", "agent", "state", "pi-bench.json");
const PROVIDER = process.env.PI_BENCH_PROVIDER ?? "klotilda";
const MODEL = process.env.PI_BENCH_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const TOOLS = "read,bash,edit,write";
const MAX_BODY_BYTES = 1_000_000;

/**
 * A card entry on a thread: the human's message, the answer, a tool activity row, or an error the
 * daemon could not hide. Tool rows are patched in place, keyed by the tool call id.
 * @typedef {object} Card
 * @property {string} id
 * @property {"you"|"assistant"|"tool"|"error"} kind
 * @property {string} [text]
 * @property {string} [label]
 * @property {"running"|"ok"|"error"} [status]
 * @property {number} [startedAt]
 * @property {number} [durationMs]
 */

/** @type {Map<string, {id:string,title:string,sessionId:string|null,status:"idle"|"running"|"dead",folder:string,provider:string,model:string,cards:Card[]}>} */
const threads = new Map();
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

/** The short text a tool row shows. Arguments stay out of it: the row is a signpost, not a log. */
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

function send(target, payload) {
	const frame = `data: ${JSON.stringify(payload)}\n\n`;
	for (const client of target) {
		// A tab that closed or reloaded is still in the set for a moment; writing to its dead
		// socket would raise an error nobody is listening for.
		if (client.writableEnded || client.destroyed) {
			target.delete(client);
			continue;
		}
		client.write(frame);
	}
}

function publish(thread, payload) {
	send(clients, payload);
}

function addCard(thread, card) {
	thread.cards.push(card);
	publish(thread, { type: "card", threadId: thread.id, card });
}

function setStatus(thread, status) {
	if (thread.status === status) return;
	thread.status = status;
	publish(thread, { type: "update", thread });
}

/** Something the daemon cannot paper over: the card shows it and so does the console. */
function threadError(thread, message) {
	console.error(`pi-bench: ${thread.title}: ${message}`);
	addCard(thread, { id: randomUUID(), kind: "error", text: message });
	setStatus(thread, "dead");
	children.get(thread.id)?.stdin?.end();
}

function childArgv(thread) {
	return [
		"--mode",
		"rpc",
		"--no-session",
		"-ne",
		"--tools",
		TOOLS,
		"--provider",
		thread.provider,
		"--model",
		thread.model,
	];
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
			publish(thread, { type: "update", thread });
		} else if (event.command === "prompt" && event.success === false) {
			// A rejected prompt starts no run, so no agent_settled would ever arrive.
			threadError(thread, `prompt rejected: ${event.error ?? "unknown reason"}`);
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		addCard(thread, {
			id: String(event.toolCallId),
			kind: "tool",
			label: describeTool(event.toolName, event.args ?? {}),
			status: "running",
			startedAt: Date.now(),
		});
		return;
	}
	if (event.type === "tool_execution_end") {
		const card = thread.cards.find((candidate) => candidate.id === event.toolCallId && candidate.kind === "tool");
		if (!card) return;
		card.status = event.isError ? "error" : "ok";
		card.durationMs = typeof event.durationMs === "number" ? event.durationMs : Date.now() - (card.startedAt ?? Date.now());
		publish(thread, { type: "activity", threadId: thread.id, card });
		return;
	}
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const message = event.message;
		const text = (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block?.type === "text")
			.map((block) => block.text)
			.join("");
		if (text.trim()) addCard(thread, { id: randomUUID(), kind: "assistant", text: text.trim() });
		if (message.errorMessage) threadError(thread, String(message.errorMessage));
		return;
	}
	if (event.type === "agent_settled") {
		// Nothing runs after settle, so closing stdin is what lets the child exit.
		setStatus(thread, "idle");
		children.get(thread.id)?.stdin?.end();
	}
}

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

async function onCreateThread(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	const id = randomUUID();
	const folder = typeof body.folder === "string" && body.folder ? body.folder : process.cwd();
	const thread = {
		id,
		title: typeof body.title === "string" && body.title ? body.title : `thread ${threads.size + 1}`,
		sessionId: null,
		status: "idle",
		folder,
		provider: PROVIDER,
		model: typeof body.model === "string" && body.model ? body.model : MODEL,
		cards: [],
	};
	// Creation does not spawn: the child starts on the first message, so an empty board costs nothing.
	threads.set(id, thread);
	publish(thread, { type: "update", thread });
	answer(res, 200, { threadId: id });
}

async function onMessage(req, res) {
	const body = await readJson(req, res);
	if (!body) return;

	const thread = threads.get(String(body.threadId ?? ""));
	if (!thread) return void fail(res, 404, "unknown thread");
	if (thread.status === "dead") return void fail(res, 409, "thread ended");
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return void fail(res, 400, "empty text");
	addCard(thread, { id: randomUUID(), kind: "you", text });
	setStatus(thread, "running");
	try {
		const child = ensureChild(thread);
		// A false return means the write is buffered, not lost: the record is on its way either way.
		child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "prompt", message: text })}\n`);
	} catch (error) {
		threadError(thread, `could not send to the child: ${error.message}`);
		fail(res, 500, "could not send to the child");
		return;
	}
	answer(res, 200, { accepted: true });
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
			send(new Set([res]), { type: "snapshot", threads: [...threads.values()] });
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
		if (req.method === "GET" && url.pathname === "/state") {
			answer(res, 200, { threads: [...threads.values()] });
			return;
		}
		if (req.method === "POST" && url.pathname === "/thread") {
			await onCreateThread(req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/message") {
			await onMessage(req, res);
			return;
		}
		fail(res, 404, "not found");
	})();
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

server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	rememberToken(token, port);
	console.log(`pi-bench listening on http://127.0.0.1:${port}/?token=${token}`);
});
