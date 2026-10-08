#!/usr/bin/env node
// CLI runner for the mdrender extension. Reads a JSON request (argv[1] or stdin),
// writes a JSON result to stdout. Logs and diagnostics go to stderr.
import { render } from "./lib/render.mjs";

function readStdin() {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => (data += c));
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
	});
}

const raw = process.argv[2] || (await readStdin());
let req;
try {
	req = JSON.parse(raw);
} catch (e) {
	console.error(`invalid JSON request: ${e.message}`);
	process.exit(2);
}

const timer = setTimeout(() => {
	console.error("render timed out after 150s");
	process.exit(3);
}, 150_000);

try {
	const result = await render(req);
	console.log(JSON.stringify(result));
} catch (e) {
	console.log(JSON.stringify({ ok: false, error: e.message }));
} finally {
	clearTimeout(timer);
}
