/**
 * Injects agent context into the system prompt via before_agent_start:
 * - Scoped models: lets the agent pick delegate targets zero-shot.
 * - Top-level folder structure of the working directory.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IGNORED = new Set([
	"node_modules",
	"__pycache__",
	".git",
	".cache",
	".venv",
	"venv",
	".history",
	".nvm",
]);

function folderStructure(cwd: string): string | null {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(cwd, { withFileTypes: true });
	} catch {
		return null;
	}
	const lines = entries
		.filter((e) => !IGNORED.has(e.name) && !(e.name.startsWith(".") && e.isDirectory()))
		.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
		.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
	if (lines.length === 0) return null;
	return lines.map((l) => `- ${l}`).join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (_event, ctx) => {
		const modelLines = ctx.scopedModels.map((s) => {
			const id = `${s.model.provider}/${s.model.id}`;
			return s.thinkingLevel ? `- ${id} (thinking: ${s.thinkingLevel})` : `- ${id}`;
		});
		const modelsSection =
			modelLines.length > 0
				? `# Scoped models\nYou can delegate subagent work to any of these provider/model pairs (use "provider/model" verbatim):\n${modelLines.join("\n")}`
				: `# Scoped models\nNo models are scoped; every available model is usable. Query ctx.modelRegistry if you need the catalogue.`;

		const structure = folderStructure(ctx.cwd ?? process.cwd());
		const structureSection = structure
			? `# Workspace structure (top-level)\n${structure}`
			: "";

		return {
			systemPrompt: [ctx.getSystemPrompt(), modelsSection, structureSection]
				.filter(Boolean)
				.join("\n\n"),
		};
	});
}