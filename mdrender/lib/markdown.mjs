// Markdown-it pipeline: CommonMark + GFM-style tables (built-in), footnotes,
// definition lists, task lists, sub/sup/mark, KaTeX math, GitHub alerts,
// heading anchors, Shiki code highlighting, Mermaid placeholders, local image embedding.
import fs from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import deflist from "markdown-it-deflist";
import mark from "markdown-it-mark";
import sub from "markdown-it-sub";
import sup from "markdown-it-sup";
import tasklists from "markdown-it-task-lists";
import { codeToHtml } from "shiki";
import katex from "katex";

const IMAGE_MIME = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif",
};
const IMAGE_LIMIT = 10 * 1024 * 1024;
const ALERT_TYPES = ["note", "tip", "important", "warning", "caution"];

function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- KaTeX -------------------------------------------------------------

function renderMath(tex, displayMode, warnings) {
	try {
		return katex.renderToString(tex, {
			displayMode, throwOnError: false, strict: false, output: "htmlAndMathml",
		});
	} catch (e) {
		warnings.push(`KaTeX error in '${tex.slice(0, 40)}': ${e.message}`);
		return `<span class="math-error">${escapeHtml(tex)}</span>`;
	}
}

// Inline math: $...$ with GitHub-style guards.
function inlineMathRule(state, silent) {
	const src = state.src;
	const pos = state.pos;
	if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
	if (pos > 0 && src.charCodeAt(pos - 1) === 0x5c /* \ */) return false;
	const start = pos + 1;
	let end = src.indexOf("$", start);
	while (end !== -1 && src.charCodeAt(end - 1) === 0x5c) end = src.indexOf("$", end + 1);
	if (end === -1) return false;
	const content = src.slice(start, end);
	if (!content.trim()) return false;
	if (content.startsWith(" ") || content.endsWith(" ")) return false;
	// "$5 to $10": digit right after opening and closing delimiter -> money, not math
	if (/^[0-9]/.test(content) && /[0-9]$/.test(content) && end + 1 < src.length && /[0-9]/.test(src[end + 1]) && /^[0-9]$/.test(content)) return false;
	if (!silent) {
		const token = state.push("math_inline", "math", 0);
		token.markup = "$";
		token.content = content;
	}
	state.pos = end + 1;
	return true;
}

// Block math: $$...$$ on one line, or $$ ... $$ spanning lines.
function blockMathRule(state, startLine, endLine, silent) {
	const pos = state.bMarks[startLine] + state.tShift[startLine];
	const max = state.eMarks[startLine];
	if (state.src.slice(pos, pos + 2) !== "$$") return false;
	const firstLine = state.src.slice(pos + 2, max).trim();

	let contentLines = [];
	let endLineFound = -1;
	if (firstLine.endsWith("$$") && firstLine.length >= 2 && firstLine !== "$$") {
		const inner = firstLine.slice(0, -2).trim();
		if (inner) {
			contentLines = [inner];
			endLineFound = startLine;
		}
	}
	if (endLineFound === -1) {
		if (firstLine && firstLine !== "$$") contentLines.push(firstLine);
		let closed = false;
		for (let i = startLine + 1; i < endLine; i++) {
			const p = state.bMarks[i] + state.tShift[i];
			const m = state.eMarks[i];
			const line = state.src.slice(p, m).trim();
			if (line.endsWith("$$")) {
				const rest = line.slice(0, -2).trim();
				if (rest) contentLines.push(rest);
				endLineFound = i;
				closed = true;
				break;
			}
			contentLines.push(state.src.slice(p, m));
		}
		if (!closed) return false;
	}
	if (silent) return true;

	const token = state.push("math_block", "math", 0);
	token.markup = "$$";
	token.content = contentLines.join("\n");
	token.block = true;
	state.line = endLineFound + 1;
	return true;
}

// --- slugger -----------------------------------------------------------

function makeSlugger() {
	const seen = new Map();
	return function slug(text) {
		let base = text.toLowerCase().trim()
			.replace(/[\][(<>"'*~`^$|\\]/g, "")
			.replace(/[^\w\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "section";
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return n === 0 ? base : `${base}-${n}`;
	};
}

// --- factory -----------------------------------------------------------

export function createMarkdown(warnings) {
	const diagrams = [];
	const md = new MarkdownIt({ html: true, linkify: true, typographer: true, breaks: false })
		.use(footnote)
		.use(deflist)
		.use(mark)
		.use(sub)
		.use(sup)
		.use(tasklists, { enabled: true, label: true, labelAfter: true });

	md.inline.ruler.before("escape", "math_inline", inlineMathRule);
	md.block.ruler.before("fence", "math_block", blockMathRule, { alt: ["paragraph", "reference", "blockquote", "list"] });

	md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false, warnings);
	md.renderer.rules.math_block = (tokens, idx) =>
		`<div class="math-display">${renderMath(tokens[idx].content, true, warnings)}</div>\n`;

	const slug = makeSlugger();
	md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
		const text = tokens[idx + 1] ? tokens[idx + 1].content : "";
		tokens[idx].attrSet("id", slug(text));
		return self.renderToken(tokens, idx, options);
	};

	// Fence renderer: mermaid placeholder, shiki-highlighted code, or escaped fallback.
	md.renderer.rules.fence = (tokens, idx) => {
		const token = tokens[idx];
		const info = (token.info || "").trim();
		const lang = info.split(/\s+/)[0].toLowerCase();
		if (lang === "mermaid") {
			const n = diagrams.length + 1;
			diagrams.push({ index: n, code: token.content });
			return `<div class="mermaid-block" data-mermaid="${n}"></div>\n`;
		}
		if (token._shiki) return token._shiki;
		warnings.push(`No syntax highlighting for '${lang}'; rendered as plain code.`);
		return `<pre class="shiki-plain"><code>${escapeHtml(token.content)}</code></pre>\n`;
	};

	md.diagrams = diagrams;
	return md;
}

// --- token enhancement ---

async function highlightFences(tokens, shiki, warnings) {
	for (const token of tokens) {
		if (token.type !== "fence") continue;
		const lang = (token.info || "").trim().split(/\s+/)[0].toLowerCase();
		if (!lang || lang === "mermaid") continue;
		try {
			token._shiki = await codeToHtml(token.content, { lang, ...shiki });
		} catch (e) {
			if (!/Unknown language|language .* not found|doesn't exist/i.test(String(e.message))) {
				warnings.push(`Shiki error for '${lang}': ${e.message}`);
			}
			try {
				token._shiki = await codeToHtml(token.content, { lang: "text", ...shiki });
			} catch {
				token._shiki = "";
			}
		}
	}
}

function embedImages(tokens, sourceDir, warnings) {
	const walk = (list) => {
		for (const token of list) {
			if (token.type === "image" && token.attrs) {
				const src = token.attrGet("src");
				if (src && !/^(https?:|data:|\/\/)/i.test(src)) {
					const file = path.resolve(sourceDir, src.split("#")[0].split("?")[0]);
					try {
						const stat = fs.statSync(file);
						if (stat.size > IMAGE_LIMIT) throw new Error(`${(stat.size / 1e6).toFixed(1)}MB exceeds 10MB limit`);
						const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
						if (!mime) throw new Error(`unsupported image type ${path.extname(file) || "(none)"}`);
						const data = fs.readFileSync(file).toString("base64");
						token.attrSet("src", `data:${mime};base64,${data}`);
					} catch (e) {
						warnings.push(`Image '${src}' not embedded: ${e.message}`);
					}
				}
			}
			if (token.children) walk(token.children);
		}
	};
	walk(tokens);
}

function applyAlerts(tokens, warnings) {
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type !== "blockquote_open") continue;
		const po = tokens[i + 1];
		const inl = tokens[i + 2];
		if (!po || po.type !== "paragraph_open" || !inl || inl.type !== "inline") continue;
		const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(inl.content.trimStart());
		if (!m) continue;
		const kind = m[1].toLowerCase();
		tokens[i].attrJoin("class", `alert alert-${kind}`);
		const rest = inl.content.trimStart().slice(m[0].length);
		if (inl.children && inl.children.length) {
			const first = inl.children[0];
			const fm = /^\[![A-Z]+\]\s*/i.exec((first.content || "").trimStart());
			first.content = fm ? first.content.trimStart().slice(fm[0].length) : rest;
		}
		inl.content = rest;
	}
}

export async function renderBody(md, source, { sourceDir, shiki, warnings }) {
	const tokens = md.parse(source, {});
	await highlightFences(tokens, shiki, warnings);
	applyAlerts(tokens, warnings);
	if (sourceDir) embedImages(tokens, sourceDir, warnings);
	const body = md.renderer.render(tokens, md.options, {});
	return { body, diagrams: md.diagrams, hasMath: /class="katex/.test(body) };
}
