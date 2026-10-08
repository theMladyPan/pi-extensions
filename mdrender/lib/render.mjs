// Orchestration: markdown -> body HTML (+ mermaid SVGs) -> document HTML and/or PDF.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMarkdown, renderBody } from "./markdown.mjs";
import { buildDocument } from "./html.mjs";
import { Browser, injectDiagrams, pathSlug } from "./browser.mjs";
import { designFor } from "./themes.mjs";

// Shipped theme design (user-selected during smoke test).
export const DEFAULT_DESIGN = { light: "github", dark: "github" };

function stripTags(s) {
	return s.replace(/<[^>]+>/g, "").trim();
}

function extractTitle(body, fallback) {
	const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body);
	return m ? stripTags(m[1]) : fallback;
}

function resolveOutput(kind, output, sourcePath, title) {
	const ext = kind === "pdf" ? ".pdf" : ".html";
	const name = pathSlug(title);
	let dir, base;
	if (output) {
		const abs = path.resolve(output);
		const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
		dir = isDir ? abs : path.dirname(abs);
		base = isDir ? name : path.basename(abs).replace(/\.(html?|pdf)$/i, "") || name;
	} else if (sourcePath) {
		const abs = path.resolve(sourcePath);
		dir = path.dirname(abs);
		base = path.basename(abs, path.extname(abs));
	} else {
		dir = process.cwd();
		base = name;
	}
	return path.join(dir, base + ext);
}

export async function render(input) {
	const warnings = [];
	const {
		markdown,
		sourcePath: sourcePathArg = null,
		format = "html",
		design = null,
		mode = "auto",
		output = null,
	} = input;
	const sourcePath = sourcePathArg ?? input.file ?? null;

	if (markdown == null && !sourcePath) throw new Error("Provide either 'markdown' text or a 'sourcePath' file.");
	let source;
	if (markdown != null) {
		source = String(markdown);
	} else {
		const abs = path.resolve(sourcePath);
		source = fs.readFileSync(abs, "utf8");
	}
	if (!["html", "pdf", "both"].includes(format)) throw new Error(`format must be html|pdf|both, got '${format}'`);
	if (!["light", "dark", "auto"].includes(mode)) throw new Error(`mode must be light|dark|auto, got '${mode}'`);

	const effectiveMode = format === "pdf" && mode === "auto" ? "light" : mode;
	const designId = design || DEFAULT_DESIGN[effectiveMode === "dark" ? "dark" : "light"];
	const designObj = designFor(designId);

	const md = createMarkdown(warnings);
	const shiki = effectiveMode === "auto"
		? { themes: { light: designObj.shiki.light, dark: designObj.shiki.dark }, defaultColor: false }
		: { theme: designObj.shiki[effectiveMode] };

	const { body, diagrams, hasMath } = await renderBody(md, source, {
		sourceDir: sourcePath ? path.dirname(path.resolve(sourcePath)) : process.cwd(),
		shiki,
		warnings,
	});
	const title = extractTitle(body, sourcePath ? path.basename(sourcePath, path.extname(sourcePath)) : "Document");

	let browser = null;
	try {
		if (diagrams.length || format !== "html") {
			browser = await Browser.create();
		}
		let diagramResults = [];
		if (diagrams.length) {
			const mermaidConfig = { ...(designObj.mermaid[effectiveMode] ?? designObj.mermaid.light), fontFamily: designObj.sans };
			diagramResults = await browser.renderMermaid(diagrams, mermaidConfig, (msg) => warnings.push(msg));
		}
		const finalBody = injectDiagrams(body, diagrams, diagramResults, warnings);

		const outputs = [];
		const wantHtml = format === "html" || format === "both";
		const wantPdf = format === "pdf" || format === "both";

		if (wantHtml) {
			const htmlPath = resolveOutput("html", output, sourcePath, title);
			const html = buildDocument({
				body: finalBody, title, designId, mode: effectiveMode, hasMath, warnings,
			});
			fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
			fs.writeFileSync(htmlPath, html);
			outputs.push({ kind: "html", path: htmlPath, bytes: Buffer.byteLength(html) });
		}
		if (wantPdf) {
			const pdfPath = resolveOutput("pdf", output, sourcePath, title);
			fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
			const tmpHtml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mdrender-tmp-")), "doc.html");
			fs.writeFileSync(tmpHtml, buildDocument({
				body: finalBody, title, designId, mode: effectiveMode, hasMath, warnings,
			}));
			await browser.printToPdf(tmpHtml, pdfPath);
			fs.rmSync(path.dirname(tmpHtml), { recursive: true, force: true });
			outputs.push({ kind: "pdf", path: pdfPath, bytes: fs.statSync(pdfPath).size });
		}

		return {
			ok: true,
			title,
			design: designId,
			mode: effectiveMode,
			diagrams: diagramResults.filter((r) => r.ok).length,
			failedDiagrams: diagramResults.filter((r) => !r.ok).length,
			outputs,
			warnings,
		};
	} finally {
		if (browser) await browser.close();
	}
}
