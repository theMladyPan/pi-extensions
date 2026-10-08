// Headless Chrome integration: Mermaid diagram pre-rendering and PDF printing.
// Fully offline: mermaid UMD bundle is read from local node_modules.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const MERMAID_SRC = new URL("../node_modules/mermaid/dist/mermaid.min.js", import.meta.url);

const CANDIDATES = [
	process.env.CHROME_PATH,
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/opt/google/chrome/chrome",
].filter(Boolean);

export function findChrome() {
	for (const c of CANDIDATES) if (c && existsSync(c)) return c;
	for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
		const r = spawnSync("which", [name], { encoding: "utf8" });
		if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
	}
	throw new Error("No Chrome/Chromium executable found. Set CHROME_PATH.");
}

function loadMermaidSrc() {
	if (!existsSync(fileURLToPath(MERMAID_SRC))) {
		throw new Error("mermaid bundle missing; run `npm install` in the mdrender extension directory");
	}
	return readFileSync(fileURLToPath(MERMAID_SRC), "utf8");
}

async function launchChrome(timeoutMs) {
	const executablePath = findChrome();
	return puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"],
		protocolTimeout: timeoutMs,
	});
}

export class Browser {
	static async create(timeoutMs = 120_000) {
		const browser = await launchChrome(timeoutMs);
		return new Browser(browser);
	}

	constructor(browser) {
		this.browser = browser;
		this._mermaidPage = null;
		this._mermaidSrc = null;
	}

	// Pre-render mermaid sources to SVG strings inside Chrome.
	async renderMermaid(diagrams, mermaidConfig, onPageError) {
		if (!diagrams.length) return [];
		const page = await this.browser.newPage();
		this._mermaidPage = page;
		page.on("pageerror", (e) => onPageError?.(`mermaid page error: ${e.message}`));
		try {
			await page.setContent("<!doctype html><html><body></body></html>", { waitUntil: "load" });
			this._mermaidSrc ||= loadMermaidSrc();
			await page.addScriptTag({ content: this._mermaidSrc });
			await page.evaluate((cfg) => {
				window.mermaid.initialize({ startOnLoad: false, securityLevel: "loose", ...cfg });
			}, mermaidConfig);
			const results = [];
			for (let i = 0; i < diagrams.length; i++) {
				try {
					const svg = await page.evaluate(async (id, code) => {
						const { svg } = await window.mermaid.render(id, code);
						return svg;
					}, `mermaid-${i}`, diagrams[i].code);
					results.push({ ok: true, svg });
				} catch (e) {
					results.push({ ok: false, error: String(e.message || e).split("\n").slice(-1)[0] });
				}
			}
			return results;
		} finally {
			await page.close().catch(() => {});
		}
	}

	// Print an HTML file to PDF (all assets inline, so a single file:// URL suffices).
	async printToPdf(htmlPath, pdfPath) {
		const page = await this.browser.newPage();
		try {
			await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0", timeout: 60_000 });
			await page.evaluateHandle("document.fonts.ready");
			await page.pdf({
				path: pdfPath,
				printBackground: true,
				preferCSSPageSize: true,
				margin: { top: "0", bottom: "0", left: "0", right: "0" },
			});
		} finally {
			await page.close().catch(() => {});
		}
	}

	async close() {
		await this.browser.close().catch(() => {});
	}
}

// Replace placeholder divs with rendered SVGs (or an error panel) in the body HTML.
export function injectDiagrams(body, diagrams, results, warnings) {
	return body.replace(/<div class="mermaid-block" data-mermaid="(\d+)"><\/div>/g, (match, n) => {
		const idx = diagrams.findIndex((d) => d.index === Number(n));
		const res = results[idx];
		if (!res) return match;
		if (res.ok) return `<div class="mermaid-block" data-mermaid="${n}">${res.svg}</div>`;
		warnings.push(`Mermaid diagram ${n} failed: ${res.error}`);
		const code = diagrams[idx].code.replace(/&/g, "&amp;").replace(/</g, "&lt;");
		return `<div class="mermaid-block"><pre class="mermaid-error">Mermaid diagram ${n} failed to render: ${res.error}\n\n${code}</pre></div>`;
	});
}

export function pathSlug(title) {
	const s = title.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-");
	return s || "document";
}
