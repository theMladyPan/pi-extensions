/**
 * /scan_codebase [path...] — file-tree scan of (part of) a codebase into the
 * model context. Not a tool: only the user can invoke it.
 *
 * Lists every file and folder under each root as a tree: size in KB/MB for
 * all files, LOC for text files. Gitignored entries (plus well-known dirs
 * like .git, .venv, node_modules) are kept in the tree but marked
 * "(ignored)": ignored folders are not recursed, ignored files show size
 * only, no LOC. Empty dirs are shown. Sent with deliverAs "nextTurn": it
 * sits in history until the user's next prompt, so they can type a message
 * or run another command before the LLM sees the scan. A TUI card shows
 * summary stats and a preview.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ignore from "ignore";

const MAX_FILE_BYTES = 512 * 1024; // ponytail: bigger files get size only, no LOC read
const MAX_LINES = 1000; // ponytail: tree cap; stats stay full even when truncated

// Same skip list as dump-codebase: counted as "ignored" even when not in
// .gitignore (.git is not usually gitignored but must not flood the tree).
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

type Node = {
	name: string;
	isDir: boolean;
	ignored: boolean;
	size: number;
	loc: number | null;
	children: Node[];
};

type ScanStats = {
	root: string;
	files: number;
	size: string;
	loc: number;
	ignoredFiles: number;
	ignoredDirs: number;
	preview: string;
};

function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8192).includes(0);
}

function fmtSize(bytes: number): string {
	const kb = bytes / 1024;
	return kb < 1024 ? `${kb.toFixed(1)}KB` : `${(kb / 1024).toFixed(1)}MB`;
}

// The ignore package needs a trailing slash to match dir-only patterns
// ("dist/"); test both spellings. ponytail: negation quirks untested.
function isIgnored(rel: string, ig: ReturnType<typeof ignore> | null, isDir: boolean): boolean {
	if (ig === null) return false;
	return ig.ignores(rel) || (isDir && ig.ignores(`${rel}/`));
}

async function walk(dir: string, base: string, ig: ReturnType<typeof ignore> | null, node: Node): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return; // unreadable dir: skip
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		const rel = relative(base, full);
		if (entry.isDirectory()) {
			const ignored = SKIP_DIRS.has(entry.name) || isIgnored(rel, ig, true);
			const child: Node = { name: entry.name, isDir: true, ignored, size: 0, loc: null, children: [] };
			node.children.push(child);
			if (!ignored) await walk(full, base, ig, child);
		} else if (entry.isFile()) {
			const info = await stat(full).catch(() => null);
			const size = info?.isFile() ? info.size : 0;
			const ignored = entry.name === ".DS_Store" || isIgnored(rel, ig, false);
			let loc: number | null = null;
			if (!ignored && size > 0 && size <= MAX_FILE_BYTES) {
				const buffer = await readFile(full).catch(() => null);
				if (buffer && !looksBinary(buffer)) loc = buffer.toString("utf8").split("\n").length;
			}
			node.children.push({ name: entry.name, isDir: false, ignored, size, loc, children: [] });
		}
	}
}

// Dirs first, then files; each alphabetical. Ignored entries mixed in by name.
function renderTree(root: Node): string {
	const out: string[] = [root.name === "." ? "." : `${root.name}/`];
	const rows: { left: string; node: Node }[] = [];
	const render = (node: Node, prefix: string): void => {
		const sorted = [...node.children].sort(
			(a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name),
		);
		sorted.forEach((child, i) => {
			const last = i === sorted.length - 1;
			const branch = last ? "└── " : "├── ";
			const label = child.isDir ? `${child.name}/` : child.name;
			rows.push({ left: prefix + branch + label, node: child });
			if (child.isDir && !child.ignored) render(child, prefix + (last ? "    " : "│   "));
		});
	};
	render(root, "");
	const width = Math.max(0, ...rows.map((r) => r.left.length));
	for (const { left, node } of rows) {
		let line = left.padEnd(width + 4);
		if (node.isDir) {
			line += node.ignored ? "(ignored, not scanned)" : "";
		} else if (node.ignored) {
			line += `${fmtSize(node.size)}  (ignored)`;
		} else {
			line += fmtSize(node.size).padStart(9);
			line += node.loc === null ? "       -" : String(node.loc).padStart(9);
		}
		out.push(line);
	}
	return out.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer("scan-codebase-report", (entry, _options, theme) => {
		const s = entry.data as ScanStats;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(
			new Text(
				`${theme.bold(`scan_codebase ${s.root}`)} — ${s.files} files, ${s.size}, ${s.loc} LOC` +
					`, ignored: ${s.ignoredFiles} files, ${s.ignoredDirs} dirs`,
				0,
				0,
			),
		);
		for (const line of s.preview.split("\n")) {
			box.addChild(new Text(theme.fg("dim", line), 0, 0));
		}
		box.addChild(new Text(theme.fg("muted", "... (full tree sent with your next prompt)"), 0, 0));
		return box;
	});

	pi.registerCommand("scan_codebase", {
		description: "Scan the codebase into a file tree (sizes, LOC, gitignored marked) for your next prompt",
		handler: async (args, ctx) => {
			const roots = args.trim().split(/\s+/).filter(Boolean).map((a) => resolve(ctx.cwd, a));
			if (roots.length === 0) roots.push(ctx.cwd);
			const label = roots.map((r) => relative(ctx.cwd, r) || ".").join(" ");
			const ig = ignore();
			const gi = await readFile(join(ctx.cwd, ".gitignore"), "utf8").catch(() => null);
			if (gi) ig.add(gi);

			const trees: string[] = [];
			let files = 0;
			let ignoredFiles = 0;
			let ignoredDirs = 0;
			let totalBytes = 0;
			let totalLoc = 0;
			for (const root of roots) {
				// Inside cwd: paths and gitignore checks share one namespace relative
				// to cwd. Outside cwd: no gitignore, paths relative to that root.
				const inside = !relative(ctx.cwd, root).startsWith("..");
				const rootNode: Node = { name: relative(ctx.cwd, root) || ".", isDir: true, ignored: false, size: 0, loc: null, children: [] };
				await walk(root, inside ? ctx.cwd : root, inside ? ig : null, rootNode);
				trees.push(renderTree(rootNode));

				const stack = [...rootNode.children];
				while (stack.length > 0) {
					const n = stack.pop()!;
					if (n.ignored) {
						n.isDir ? ignoredDirs++ : ignoredFiles++;
						continue;
					}
					if (n.isDir) {
						stack.push(...n.children);
					} else {
						files++;
						totalBytes += n.size;
						if (n.loc !== null) totalLoc += n.loc;
					}
				}
			}

			const ignored =
				ignoredFiles + ignoredDirs > 0 ? ` (ignored: ${ignoredFiles} files, ${ignoredDirs} dirs)` : "";
			const header =
				`# Codebase scan: ${label} — ${files} files, ${fmtSize(totalBytes)}, ${totalLoc} LOC${ignored}\n\n`;
			// Stats above stay full: they describe the whole scan, only the tree
			// display is truncated.
			let tree = trees.length === 1 ? trees[0] : trees.join("\n\n");
			const lines = tree.split("\n");
			let note = "";
			if (lines.length > MAX_LINES) {
				note = `\n[Truncated at ${MAX_LINES} lines — ${lines.length - MAX_LINES} more entries not shown]`;
				tree = lines.slice(0, MAX_LINES).join("\n");
			}
			const content = header + tree + note;

			pi.sendMessage(
				{ customType: "scan-codebase", content, display: false },
				{ deliverAs: "nextTurn" },
			);
			const stats: ScanStats = {
				root: label,
				files,
				size: fmtSize(totalBytes),
				loc: totalLoc,
				ignoredFiles,
				ignoredDirs,
				preview: content.split("\n").slice(2, 10).join("\n"),
			};
			if (ctx.hasUI) {
				pi.appendEntry("scan-codebase-report", stats);
			} else {
				ctx.ui.notify(
					`Scanned ${files} files, ${stats.size}, ${totalLoc} LOC${ignored}`,
					"info",
				);
			}
		},
	});
}
