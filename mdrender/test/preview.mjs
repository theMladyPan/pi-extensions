// Smoke-test preview: one HTML per theme design, light and dark stacked.
// Usage: node test/preview.mjs <outDir>
import fs from "node:fs";
import path from "node:path";
import { createMarkdown, renderBody } from "../lib/markdown.mjs";
import { buildPreviewPage } from "../lib/html.mjs";
import { Browser, injectDiagrams } from "../lib/browser.mjs";
import { DESIGNS } from "../lib/themes.mjs";

const outDir = process.argv[2] || "/tmp/mdr-themes";
fs.mkdirSync(outDir, { recursive: true });
const source = fs.readFileSync(new URL("./sample.md", import.meta.url), "utf8");
const warnings = [];

const browser = await Browser.create();
try {
	for (const [id, design] of Object.entries(DESIGNS)) {
		const md = createMarkdown(warnings);
		const { body, diagrams } = await renderBody(md, source, {
			sourceDir: new URL(".", import.meta.url).pathname,
			shiki: { themes: { light: design.shiki.light, dark: design.shiki.dark }, defaultColor: false },
			warnings,
		});
		const light = injectDiagrams(body, diagrams, await browser.renderMermaid(diagrams, { ...design.mermaid.light, fontFamily: design.sans }), warnings);
		const dark = injectDiagrams(body, diagrams, await browser.renderMermaid(diagrams, { ...design.mermaid.dark, fontFamily: design.sans }), warnings);
		const html = buildPreviewPage({ bodies: { light, dark }, title: design.name, designId: id, hasMath: true, warnings });
		const file = path.join(outDir, `${id}.html`);
		fs.writeFileSync(file, html);
		console.error(`wrote ${file} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
	}
} finally {
	await browser.close();
}
if (warnings.length) console.error("warnings:", warnings.join("\n"));