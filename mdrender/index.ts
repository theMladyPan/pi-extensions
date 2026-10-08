// mdrender: render Markdown to styled HTML and/or PDF.
// Offline rendering: bundled mermaid (diagrams), KaTeX (math), Shiki (code), headless Chrome (PDF).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, "runner.mjs");

const Parameters = Type.Object({
	file: Type.Optional(Type.String({ description: "Path to a Markdown file to render." })),
	source: Type.Optional(Type.String({ description: "Raw Markdown text to render (use instead of file)." })),
	format: Type.Optional(
		StringEnum(["html", "pdf", "both"], {
			description: "Output format. Default: html.",
		}),
	),
	theme: Type.Optional(
		StringEnum(["light", "dark", "auto"], {
			description: "Color scheme. 'auto' embeds both palettes and follows the reader's system preference (HTML only; PDF forces light unless 'dark' is requested). Default: auto.",
		}),
	),
	output: Type.Optional(
		Type.String({
			description: "Output file path or directory. Defaults to a sibling file of the input, or <cwd>/<title-slug>.<ext> for raw source.",
		}),
	),
});

interface RunnerResult {
	ok: boolean;
	error?: string;
	title?: string;
	design?: string;
	mode?: string;
	diagrams?: number;
	failedDiagrams?: number;
	outputs?: Array<{ kind: string; path: string; bytes: number }>;
	warnings?: string[];
}

function runRunner(payload: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [RUNNER], {
			cwd: path.dirname(RUNNER),
			stdio: ["pipe", "pipe", "pipe"],
			signal,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
		child.on("error", reject);
		child.on("exit", (code) => {
			const lines = stdout.trim().split("\n").filter(Boolean);
			const last = lines[lines.length - 1];
			if (last) {
				try {
					return resolve(JSON.parse(last));
				} catch {
					/* fall through to error */
				}
			}
			reject(new Error(stderr.trim() || `runner exited with code ${code}`));
		});
		child.stdin.write(JSON.stringify(payload));
		child.stdin.end();
	});
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "md_render",
		label: "Render Markdown",
		description:
			"Render Markdown to a styled, self-contained HTML file and/or PDF document. " +
			"Full markdown support: CommonMark, GFM tables and task lists, footnotes, definition lists, " +
			"sub/sup/highlight, math ($...$, $$...$$ via KaTeX), GitHub alerts, syntax highlighting (Shiki), " +
			"and Mermaid diagrams (```mermaid blocks rendered to inline SVG). Fully offline.",
		parameters: Parameters,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			if (!params.file && !params.source) {
				throw new Error("Provide 'file' (path to a Markdown file) or 'source' (raw Markdown text).");
			}
			onUpdate?.({ content: [{ type: "text", text: "Rendering markdown..." }] });
			const result = await runRunner(
				{
					markdown: params.source ?? null,
					sourcePath: params.file ?? null,
					format: params.format ?? "html",
					mode: params.theme ?? "auto",
					output: params.output ?? null,
				},
				signal,
			);
			if (!result.ok) throw new Error(result.error ?? "render failed");

			const files = (result.outputs ?? [])
				.map((o) => `${o.kind.toUpperCase()}: ${o.path} (${(o.bytes / 1024).toFixed(1)} KB)`)
				.join("\n");
			const diagramNote = result.diagrams
				? `\nDiagrams: ${result.diagrams} rendered${result.failedDiagrams ? `, ${result.failedDiagrams} failed (embedded as error panels)` : ""}`
				: "";
			const warnNote = result.warnings?.length ? `\nWarnings:\n- ${result.warnings.join("\n- ")}` : "";

			return {
				content: [{ type: "text", text: `Rendered '${result.title}' (${result.design}, ${result.mode}):\n${files}${diagramNote}${warnNote}` }],
				details: {
					title: result.title,
					outputs: result.outputs,
					diagrams: result.diagrams,
					failedDiagrams: result.failedDiagrams,
					warnings: result.warnings,
				},
			};
		},
	});
}
