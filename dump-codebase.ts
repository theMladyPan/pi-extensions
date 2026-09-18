/**
 * /dump_codebase [path... ] — user-invoked dump of (part of) a codebase
 * into the model context. Not a tool: only the user can invoke it.
 *
 * Multiple folders work: `/dump_codebase src docs`. Paths and gitignore
 * checks are relative to the project root (cwd). Walks each root, skips
 * VCS/dependency/build dirs, binaries, and huge files, and concatenates text
 * files with `===== path =====` headers. Respects the root .gitignore by
 * default; interactive choice (exclude/include/cancel) before dumping. The
 * dump is a custom message: display=false keeps the TUI clean, full text
 * reaches the LLM. A TUI card (appendEntry, LLM-free) shows stats: file
 * count, extensions, ~lines, ~tokens, and a 10-line preview.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import ignore from "ignore";

const MAX_KB = 400; // ponytail: safety cap; raise here if a real project needs more
const SKIP_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".history",
	".nvm",
	".pixi",
	"dist",
	"build",
	"out",
	".next",
	".pytest_cache",
	".ruff_cache",
	".mypy_cache",
]);
// ponytail: allowlist, not blacklist — unknown extensions are excluded by
// default. Extensionless files (Dockerfile, Makefile, LICENSE, .gitignore)
// are included; looksBinary() catches binaries that sneak through either way.
const TEXT_EXTS = new Set([
	".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
	".c", ".h", ".cpp", ".cc", ".hpp", ".rs", ".go", ".java", ".kt", ".rb", ".php", ".cs",
	".md", ".txt", ".rst", ".adoc",
	".toml", ".yaml", ".yml", ".json", ".jsonc", ".ini", ".cfg", ".conf", ".env", ".properties",
	".html", ".htm", ".css", ".scss", ".xml", ".svg", ".csv", ".tsv",
	".sh", ".bash", ".zsh", ".fish", ".ps1", ".sql",
]);
const MAX_FILE_BYTES = 512 * 1024;

type Found = { rel: string; abs: string; size: number };
type DumpStats = {
	root: string;
	files: number;
	size: string;
	extensions: string;
	lines: number;
	tokens: number;
	capped: boolean;
	capKb: number;
	preview: string;
};

// ponytail: only the root .gitignore is honored; nested .gitignore files and
// negation patterns inside ignored dirs are not (we prune ignored dirs).
async function walk(
	dir: string,
	base: string,
	ig: ReturnType<typeof ignore> | null,
	files: Found[],
): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return; // unreadable dir: skip
	}
	for (const entry of entries) {
		if (entry.name === ".DS_Store") continue;
		const full = join(dir, entry.name);
		const rel = relative(base, full);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name) || (ig && ig.ignores(rel))) continue;
			await walk(full, base, ig, files);
		} else if (entry.isFile()) {
			const ext = extname(entry.name).toLowerCase();
			if (ext !== "" && !TEXT_EXTS.has(ext)) continue;
			const info = await stat(full).catch(() => null);
			if (info?.isFile() && info.size <= MAX_FILE_BYTES) files.push({ rel, abs: full, size: info.size });
		}
	}
}

function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8192).includes(0);
}

function kb(bytes: number): string {
	return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function buildStats(
	label: string,
	dump: string,
	dumped: number,
	total: number,
	capped: boolean,
	maxKb: number,
): DumpStats {
	const exts = new Map<string, number>();
	for (const m of dump.matchAll(/===== (.+?) =====/g)) {
		const ext = extname(m[1]).toLowerCase() || "(no ext)";
		exts.set(ext, (exts.get(ext) ?? 0) + 1);
	}
	const extensions = [...exts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([e, n]) => (n > 1 ? `${e}(${n})` : e))
		.join(" ");
	return {
		root: label,
		files: dumped,
		size: kb(total),
		extensions,
		lines: dump.split("\n").length,
		tokens: Math.round(dump.length / 4), // ponytail: chars/4 heuristic
		capped,
		capKb: maxKb,
		preview: dump.split("\n").slice(0, 10).join("\n"),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer("dump-codebase-report", (entry, _options, theme) => {
		const s = entry.data as DumpStats;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(
			new Text(
				`${theme.bold(`dump_codebase ${s.root}`)} — ${s.files} files, ${s.size}` +
					`, ~${s.lines} lines, ~${s.tokens} tokens${s.capped ? ` (capped at ${s.capKb}KB)` : ""}`,
				0,
				0,
			),
		);
		box.addChild(new Text(theme.fg("dim", `ext: ${s.extensions}`), 0, 0));
		for (const line of s.preview.split("\n")) {
			box.addChild(new Text(theme.fg("dim", line), 0, 0));
		}
		box.addChild(new Text(theme.fg("muted", "... (full dump sent to the model)"), 0, 0));
		return box;
	});

	pi.registerCommand("dump_codebase", {
		description: "Dump the whole codebase into model context (gitignored excluded by default)",
		handler: async (args, ctx) => {
			const rootArgs = args.trim().split(/\s+/).filter(Boolean);
			// Trailing bare number = cap in KB: `/dump_codebase src docs 800`
			let maxKb = MAX_KB;
			if (rootArgs.length > 0 && /^\d+$/.test(rootArgs[rootArgs.length - 1])) {
				maxKb = Number(rootArgs.pop());
			}
			const roots = rootArgs.map((a) => resolve(ctx.cwd, a));
			if (roots.length === 0) roots.push(ctx.cwd);
			const label = roots.map((r) => relative(ctx.cwd, r) || ".").join(" ");
			const ig = ignore();
			const gi = await readFile(join(ctx.cwd, ".gitignore"), "utf8").catch(() => null);
			if (gi) ig.add(gi);

			const all: Found[] = [];
			const seen = new Set<string>();
			for (const root of roots) {
				// Inside cwd: paths and gitignore checks share one namespace relative
				// to cwd. Outside cwd: no gitignore, paths relative to that root.
				const inside = !relative(ctx.cwd, root).startsWith("..");
				const found: Found[] = [];
				await walk(root, inside ? ctx.cwd : root, inside ? ig : null, found);
				for (const f of found) {
					if (!seen.has(f.rel)) {
						seen.add(f.rel);
						all.push(f);
					}
				}
			}
			const wanted = all.filter((f) => !ig.ignores(f.rel));

			if (ctx.hasUI) {
				const wantedBytes = wanted.reduce((n, f) => n + f.size, 0);
				const choice = await ctx.ui.select(`dump_codebase ${label}`, [
					`Dump ${wanted.length} files (~${kb(wantedBytes)}), gitignored excluded`,
					`Include gitignored too (+${all.length - wanted.length} files)`,
					"Cancel",
				]);
				if (choice === undefined || choice.startsWith("Cancel")) {
					ctx.ui.notify("dump_codebase cancelled", "info");
					return;
				}
				if (choice.startsWith("Include")) {
					wanted.push(...all.filter((f) => ig.ignores(f.rel)));
				}
			}
			if (wanted.length === 0) {
				ctx.ui.notify(`No text files found under ${label}`, "warning");
				return;
			}
			wanted.sort((a, b) => a.rel.localeCompare(b.rel));

			const chunks: string[] = [`# Codebase dump: ${label} (${wanted.length} files)`];
			let total = 0;
			let dumped = 0;
			let stopped = false;
			for (const { rel, abs } of wanted) {
				const buffer = await readFile(abs).catch(() => null);
				if (!buffer || looksBinary(buffer)) continue;
				const header = `\n===== ${rel} =====\n`;
				const body = buffer.toString("utf8");
				if (total + header.length + body.length > maxKb * 1024) {
					chunks.push(
						`\n[Stopped at ${rel}: ${maxKb}KB cap reached. Remaining files: ${wanted
							.slice(wanted.findIndex((f) => f.rel === rel))
							.map((f) => f.rel)
							.join(", ")}]`,
					);
					stopped = true;
					break;
				}
				total += header.length + body.length;
				dumped += 1;
				chunks.push(header + body);
			}
			const dump = chunks.join("");
			// nextTurn: sits in history until the user's next prompt, so they can
			// type a message or run another command before the LLM sees the dump.
			pi.sendMessage(
				{ customType: "dump-codebase", content: dump, display: false },
				{ deliverAs: "nextTurn" },
			);
			const stats = buildStats(label, dump, dumped, total, stopped, maxKb);
			if (ctx.hasUI) {
				pi.appendEntry("dump-codebase-report", stats);
			} else {
				ctx.ui.notify(
					`Dumped ${stats.files} files, ${stats.size}, ~${stats.lines} lines, ~${stats.tokens} tokens` +
						`${stats.capped ? ` (capped at ${stats.capKb}KB)` : ""}`,
					"info",
				);
			}
		},
	});
}