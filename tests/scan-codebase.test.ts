/**
 * Test for scan-codebase.ts: stub ExtensionAPI, run the /scan_codebase
 * handler against a fixture tree, assert the generated tree + delivery mode.
 * Run: node --experimental-strip-types --test scan-codebase.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import scanCodebase from "../scan-codebase.ts";

type Sent = { message: unknown; options: unknown };

type FakePi = {
	registerEntryRenderer: () => void;
	registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) => void;
	sendMessage: (message: unknown, options: unknown) => void;
	appendEntry: () => void;
};

function makePi(sent: Sent[]): { handler: (cwd: string) => Promise<void> } {
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	const pi: FakePi = {
		registerEntryRenderer: () => {},
		registerCommand: (_name, cmd) => {
			command = cmd;
		},
		sendMessage: (message, options) => sent.push({ message, options }),
		appendEntry: () => {},
	};
	const ctx = {
		cwd: ".",
		hasUI: false,
		ui: { select: async () => undefined, notify: () => {} },
	};
	// deno-lint-ignore no-explicit-any
	scanCodebase(pi as any);
	assert.ok(command, "command registered");
	return {
		handler: async (cwd: string) => {
			await command!.handler("", { ...ctx, cwd });
		},
	};
}

async function makeFixture(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "scan-"));
	await mkdir(join(dir, "src"));
	await mkdir(join(dir, "empty"));
	await mkdir(join(dir, "ignored"));
	await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
	await writeFile(join(dir, ".gitignore"), "*.log\nignored/\n");
	await writeFile(join(dir, "src/index.ts"), "a\nb\nc\n");
	await writeFile(join(dir, "README.md"), "hello\n");
	await writeFile(join(dir, "ignored.log"), "noise\n");
	await writeFile(join(dir, "ignored/inner.ts"), "x\n");
	// empty/ stays empty: must appear in the tree with no children
	await writeFile(join(dir, "logo.bin"), Buffer.from([0, 1, 2, 0, 3]));
	await writeFile(join(dir, "node_modules/pkg/index.js"), "m\n");
	return dir;
}

test("scan_codebase builds tree with sizes, LOC, ignored markers", async () => {
	const cwd = await makeFixture();
	const sent: Sent[] = [];
	const { handler } = makePi(sent);
	await handler(cwd);

	assert.equal(sent.length, 1);
	assert.deepEqual((sent[0].options as { deliverAs: string }), { deliverAs: "nextTurn" });
	const content = (sent[0].message as { content: string }).content;

	assert.match(content, /^# Codebase scan: \. — \d+ files,/);
	assert.match(content, /\(ignored: 1 files, 2 dirs\)/); // ignored.log + collapsed ignored/, node_modules/
	assert.match(content, /├── empty\//);
	assert.doesNotMatch(content, /keep\.txt/);
	assert.match(content, /├── src\//);
	assert.match(content, /│   └── index\.ts\s+0\.0KB\s+4/);
	assert.match(content, /├── ignored\/\s+\(ignored, not scanned\)/);
	assert.match(content, /├── node_modules\/\s+\(ignored, not scanned\)/);
	assert.match(content, /├── ignored\.log\s+0\.0KB\s+\(ignored\)/);
	assert.match(content, /├── logo\.bin\s+0\.0KB\s+-/); // binary: size, no LOC
	assert.match(content, /└── README\.md\s+0\.0KB\s+2/);
	assert.doesNotMatch(content, /inner\.ts/); // ignored dir not recursed
	assert.doesNotMatch(content, /pkg/); // skip list dir not recursed
});

test("scan_codebase caps tree at 1000 lines with a truncation note", async () => {
	const dir = await mkdtemp(join(tmpdir(), "scan-big-"));
	await mkdir(join(dir, "big"));
	for (let i = 0; i < 1100; i++) await writeFile(join(dir, `big/f${i}.ts`), "x\n");
	const sent: Sent[] = [];
	const { handler } = makePi(sent);
	await handler(dir);

	const content = (sent[0].message as { content: string }).content;
	assert.match(content, /^# Codebase scan: \. — 1100 files,/); // stats stay full
	assert.match(content, /\[Truncated at 1000 lines — \d+ more entries not shown\]/);
	const treeLines = content.split("\n").length - 3; // header, blank, root line
	assert.ok(treeLines <= 1001, `expected capped tree, got ${treeLines} lines`);
});
