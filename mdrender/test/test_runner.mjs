// End-to-end tests: spawn runner.mjs exactly like the extension tool does.
// Run: node test/test_runner.mjs  (or: npm test inside mdrender/)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const SAMPLE = path.join(DIR, "sample.md");

function run(payload, timeoutMs = 120_000) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(DIR, "..", "runner.mjs")], { cwd: DIR });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`runner timeout\nstderr: ${stderr}`));
		}, timeoutMs);
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("exit", () => {
			clearTimeout(timer);
			const lines = stdout.trim().split("\n").filter(Boolean);
			try {
				resolve(JSON.parse(lines[lines.length - 1]));
			} catch (e) {
				reject(new Error(`no JSON result\nstderr: ${stderr}\nstdout: ${stdout.slice(0, 500)}`));
			}
		});
		child.stdin.write(JSON.stringify(payload));
		child.stdin.end();
	});
}

function tmpdir(name) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mdr-test-${name}-`));
	return dir;
}

test("html auto mode: full feature coverage", async () => {
	const dir = tmpdir("auto");
	const r = await run({ file: SAMPLE, format: "html", mode: "auto", output: dir });
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.equal(r.design, "github");
	assert.equal(r.mode, "auto");
	const html = fs.readFileSync(r.outputs[0].path, "utf8");
	assert.ok(html.includes("<!doctype html>"));
	// mermaid diagrams rendered to inline svg
	assert.equal(r.diagrams, 3, "three mermaid diagrams");
	assert.ok((html.match(/<svg/g) || []).length >= 3, "mermaid svgs present");
	assert.ok(html.includes('data-mermaid="3"'));
	// katex math
	assert.ok(html.includes('class="katex"'), "inline katex");
	assert.ok(html.includes("katex-display"), "display katex");
	assert.ok(html.includes("data:font/woff2"), "katex fonts inlined");
	// shiki dual-theme code
	assert.ok(html.includes("--shiki-light:"), "shiki light vars");
	assert.ok(html.includes("--shiki-dark:"), "shiki dark vars");
	// github alerts
	assert.ok(html.includes("alert-warning") && html.includes("alert-note"));
	assert.ok(!html.includes("[!NOTE]"), "alert marker stripped");
	// task lists, footnotes, tables, deflist, sub/sup/mark
	assert.ok(html.includes("task-list-item"));
	assert.ok(html.includes("footnote-backref"));
	assert.ok(html.includes("<table>"));
	assert.ok(html.includes("<dt>"));
	assert.ok(html.includes("<mark>"));
	assert.ok(html.includes("<sub>") && html.includes("<sup>"));
	// heading anchors
	assert.ok(html.includes('id="markdown-render-sample"'));
	// dual palette + media query for auto mode
	assert.ok(html.includes('data-scope="dark"'));
	assert.ok(html.includes("prefers-color-scheme: dark"));
	// embedded local image
	assert.ok(html.includes("data:image/svg+xml;base64,"), "local image embedded");
	// autolink + typographer entities
	assert.ok(html.includes("https://example.com"));
});

test("pdf generation (dark mode)", async () => {
	const dir = tmpdir("pdf");
	const r = await run({ file: SAMPLE, format: "pdf", mode: "dark", output: dir });
	assert.equal(r.ok, true, JSON.stringify(r));
	const out = r.outputs[0];
	assert.equal(out.kind, "pdf");
	assert.equal(path.extname(out.path), ".pdf");
	assert.ok(out.bytes > 20_000, `pdf too small: ${out.bytes}`);
	const magic = fs.readFileSync(out.path).subarray(0, 5).toString();
	assert.equal(magic, "%PDF-");
	assert.equal(r.mode, "dark");
});

test("both formats from raw source with output base name", async () => {
	const dir = tmpdir("both");
	const r = await run({
		markdown: "# Report\n\nBody **text** with $x^2$ math.\n\n```mermaid\ngraph TD; A-->B;\n```",
		format: "both",
		mode: "light",
		output: path.join(dir, "custom-name"),
	});
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.equal(r.outputs.length, 2);
	assert.ok(r.outputs.some((o) => o.path.endsWith("custom-name.html")));
	assert.ok(r.outputs.some((o) => o.path.endsWith("custom-name.pdf")));
	assert.equal(r.title, "Report");
	const html = fs.readFileSync(r.outputs.find((o) => o.kind === "html").path, "utf8");
	assert.ok(html.includes('data-mode="light"'));
	assert.ok(!html.includes("prefers-color-scheme"), "fixed mode has no auto palette");
});

test("mermaid failure falls back to error panel", async () => {
	const dir = tmpdir("mermaid-err");
	const r = await run({
		markdown: "# T\n\n```mermaid\ngraph TD; A -->;\n```",
		format: "html",
		mode: "light",
		output: dir,
	});
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.equal(r.failedDiagrams, 1);
	assert.ok(r.warnings.some((w) => /Mermaid diagram 1 failed/.test(w)));
	const html = fs.readFileSync(r.outputs[0].path, "utf8");
	assert.ok(html.includes("mermaid-error"), "error panel embedded");
});

test("unknown code language falls back to plain code", async () => {
	const dir = tmpdir("lang");
	const r = await run({ markdown: "# T\n\n```notalang\nplain text\n```", format: "html", mode: "light", output: dir });
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.ok(r.warnings.some((w) => /notalang/.test(w)));
	const html = fs.readFileSync(r.outputs[0].path, "utf8");
	assert.ok(html.includes("shiki-plain"));
});

test("currency amounts are not parsed as math", async () => {
	const dir = tmpdir("money");
	const r = await run({ markdown: "# T\n\nCosts $5 and $10 total.", format: "html", mode: "light", output: dir });
	assert.equal(r.ok, true, JSON.stringify(r));
	const html = fs.readFileSync(r.outputs[0].path, "utf8");
	assert.ok(!html.includes('class="katex"'), "no math from currency");
	assert.ok(html.includes("$5 and $10"));
});

test("missing local image keeps src and warns", async () => {
	const dir = tmpdir("img");
	const r = await run({ markdown: "# T\n\n![x](./nope.png)", format: "html", mode: "light", output: dir });
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.ok(r.warnings.some((w) => /nope\.png/.test(w)));
	const html = fs.readFileSync(r.outputs[0].path, "utf8");
	assert.ok(html.includes('src="./nope.png"'));
});

test("default output is sibling of source file", async () => {
	const dir = tmpdir("sibling");
	const src = path.join(dir, "notes.md");
	fs.writeFileSync(src, "# Notes\n\nhello");
	const r = await run({ file: src, format: "html", mode: "light" });
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.equal(r.outputs[0].path, path.join(dir, "notes.html"));
	assert.equal(r.title, "Notes");
});

test("heading slug dedupe", async () => {
	const dir = tmpdir("slug");
	const r = await run({ markdown: "# Dup\n\n## Dup\n\n### Dup", format: "html", mode: "light", output: dir });
	assert.equal(r.ok, true, JSON.stringify(r));
	const html = fs.readFileSync(r.outputs[0].path, "utf8");
	assert.ok(html.includes('id="dup"'));
	assert.ok(html.includes('id="dup-1"'));
	assert.ok(html.includes('id="dup-2"'));
});

test("invalid request fails cleanly", async () => {
	const r = await run({ format: "html" });
	assert.equal(r.ok, false);
	assert.ok(/Provide/.test(r.error));
});
