// HTML document assembly: theme variables, base typography CSS, print rules.
import { readFileSync } from "node:fs";
import { designFor, MONO } from "./themes.mjs";

const SANS_URL = new URL("../node_modules/katex/dist/", import.meta.url);

function varsCss(v) {
	return [
		`--bg: ${v.bg};`, `--bg-code: ${v.bgCode};`, `--bg-inset: ${v.bgInset};`,
		`--border: ${v.border};`, `--text: ${v.text};`, `--text-muted: ${v.textMuted};`,
		`--heading: ${v.heading};`, `--link: ${v.link};`, `--accent: ${v.accent};`,
		`--accent-soft: ${v.accentSoft};`, `--mark: ${v.mark};`, `--mermaid-bg: ${v.mermaidBg};`,
	].join(" ");
}

// mode: "light" | "dark" | "auto" (auto = prefers-color-scheme) | "preview" (both scopes)
function paletteBlocks(design, mode) {
	const light = varsCss(design.vars.light);
	const dark = varsCss(design.vars.dark);
	if (mode === "light") return `[data-scope="light"], :root { ${light} }`;
	if (mode === "dark") return `[data-scope="dark"], :root { ${dark} }`;
	if (mode === "preview") return `[data-scope="light"] { ${light} }\n[data-scope="dark"] { ${dark} }`;
	return `:root { ${light} }\n[data-scope="light"] { ${light} }\n[data-scope="dark"] { ${dark} }\n@media (prefers-color-scheme: dark) { :root { ${dark} } }`;
}

function shikiShim(mode) {
	const lightRule = ".shiki, .shiki span { color: var(--shiki-light); background-color: var(--shiki-light-bg); }";
	const darkRule = ".shiki, .shiki span { color: var(--shiki-dark); background-color: var(--shiki-dark-bg); }";
	if (mode === "light") return lightRule;
	if (mode === "dark") return darkRule;
	if (mode === "preview") {
		const scope = (sel, rule) => rule.split(",").map((s) => `${sel} ${s.trim()}`).join(", ");
		return `${scope('[data-scope="light"]', lightRule)}\n${scope('[data-scope="dark"]', darkRule)}`;
	}
	return `${lightRule}\n@media (prefers-color-scheme: dark) { ${darkRule} }`;
}

const ALERT_LABELS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };
const ALERT_COLORS = { note: "var(--link)", tip: "#1a7f37", important: "#8250df", warning: "#9a6700", caution: "#cf222e" };

function baseCss(design, mode) {
	const alerts = Object.entries(ALERT_LABELS).map(([kind, label]) => `
.alert-${kind} { border-left-color: ${ALERT_COLORS[kind]}; }
.alert-${kind} > :first-child::before {
	content: "${label}";
	color: ${ALERT_COLORS[kind]};
	display: block;
	font-weight: 600;
	font-size: 0.82em;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	margin-bottom: 0.35em;
}`).join("\n");

	const css = `* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
	margin: 0;
	background: var(--bg);
	color: var(--text);
	font-family: ${design.sans};
	font-size: 16px;
	line-height: 1.7;
	text-rendering: optimizeLegibility;
}
article {
	max-width: 860px;
	margin: 0 auto;
	padding: 3rem 2.5rem 4.5rem;
}
h1, h2, h3, h4, h5, h6 {
	color: var(--heading);
	font-family: ${design.headings};
	font-weight: 650;
	line-height: 1.3;
	margin: 1.9em 0 0.6em;
	letter-spacing: -0.015em;
	break-after: avoid-page;
}
h1 { font-size: 2.1em; margin-top: 0.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.35em; }
h2 { font-size: 1.55em; }
h3 { font-size: 1.25em; }
h4 { font-size: 1.05em; }
h5, h6 { font-size: 0.95em; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
p { margin: 0.9em 0; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
strong { color: var(--heading); font-weight: 650; }
mark { background: var(--mark); color: var(--text); padding: 0.08em 0.25em; border-radius: 3px; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2.5em 0; }

ul, ol { padding-left: 1.6em; margin: 0.8em 0; }
li { margin: 0.3em 0; }
li > ul, li > ol { margin: 0.2em 0; }
li.task-list-item { list-style: none; margin-left: -1.4em; }
li.task-list-item input[type="checkbox"] { margin-right: 0.55em; accent-color: var(--accent); }

blockquote {
	margin: 1.2em 0;
	padding: 0.35em 1.2em;
	border-left: 3px solid var(--accent);
	background: var(--accent-soft);
	border-radius: 0 8px 8px 0;
	color: var(--text);
}
blockquote > :first-child { margin-top: 0.4em; }
blockquote > :last-child { margin-bottom: 0.4em; }
${alerts}

code, pre, kbd {
	font-family: ${design.mono ?? MONO};
	font-variant-ligatures: none;
}
code {
	background: var(--bg-code);
	border: 1px solid var(--border);
	padding: 0.12em 0.4em;
	border-radius: 5px;
	font-size: 0.86em;
}
pre {
	background: var(--bg-code);
	border: 1px solid var(--border);
	border-radius: 10px;
	padding: 1em 1.2em;
	overflow-x: auto;
	line-height: 1.55;
	font-size: 0.86em;
	break-inside: avoid-page;
}
pre code { background: none; border: 0; padding: 0; font-size: 1em; }
${shikiShim(mode)}
.shiki-plain { color: var(--text); }
kbd {
	background: var(--bg-inset);
	border: 1px solid var(--border);
	border-bottom-width: 2px;
	border-radius: 5px;
	padding: 0.1em 0.45em;
	font-size: 0.82em;
}

table {
	border-collapse: collapse;
	margin: 1.3em auto;
	width: 100%;
	font-size: 0.93em;
	break-inside: avoid-page;
}
th, td { border: 1px solid var(--border); padding: 0.5em 0.9em; text-align: left; }
th { background: var(--bg-inset); color: var(--heading); font-weight: 600; }
tbody tr:nth-child(even) { background: var(--bg-inset); }

img { max-width: 100%; height: auto; border-radius: 8px; }
figure { margin: 1.4em 0; text-align: center; break-inside: avoid-page; }
figcaption { color: var(--text-muted); font-size: 0.85em; margin-top: 0.5em; }

.mermaid-block {
	display: flex;
	justify-content: center;
	margin: 1.6em 0;
	break-inside: avoid-page;
}
.mermaid-block svg { max-width: 100%; height: auto; background: var(--mermaid-bg); }
.mermaid-error {
	color: #cf222e;
	background: var(--bg-inset);
	border: 1px dashed #cf222e;
	border-radius: 8px;
	padding: 0.8em 1.2em;
	font-family: ${design.mono ?? MONO};
	font-size: 0.85em;
	white-space: pre-wrap;
	width: 100%;
}

.math-display { margin: 1.3em 0; overflow-x: auto; break-inside: avoid-page; }
.math-display .katex-display { margin: 0; }
.math-error { color: #cf222e; font-family: ${design.mono ?? MONO}; }

.footnotes { margin-top: 3em; padding-top: 1em; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.9em; }
.footnotes hr { display: none; }
.footnotes ol { padding-left: 1.4em; }
.footnote-backref { text-decoration: none; }
sup a { text-decoration: none; }

dl { margin: 1em 0; }
dt { color: var(--heading); font-weight: 600; margin-top: 0.8em; }
dd { margin: 0.2em 0 0.4em 1.6em; }

@media print {
	html { font-size: 11pt; }
	article { max-width: none; padding: 0; }
	pre, table, figure, .mermaid-block, .math-display { break-inside: avoid-page; }
}
@page { size: A4; margin: 18mm 16mm; }
`;
	return css + (design.extraCss ? `\n${design.extraCss}` : "");
}

// Inlines KaTeX CSS with woff2 fonts as data URIs so math renders in a single portable file.
function katexCss(warnings) {
	try {
		let css = readFileSync(new URL("katex.min.css", SANS_URL), "utf8");
		const refs = [...new Set(css.match(/fonts\/[A-Za-z0-9_.-]+\.woff2/g) || [])];
		for (const rel of refs) {
			const data = readFileSync(new URL(rel, SANS_URL), "base64");
			css = css.split(`url(${rel})`).join(`url(data:font/woff2;base64,${data})`);
		}
		return css;
	} catch (e) {
		warnings.push(`KaTeX CSS inlining failed: ${e.message}`);
		return "";
	}
}

export function buildDocument({ body, title, designId, mode, hasMath, warnings, lang = "en" }) {
	const design = designFor(designId);
	const css = baseCss(design, mode) + (hasMath ? `\n${katexCss(warnings)}` : "");
	const modeAttr = mode === "auto" ? "" : ` data-mode="${mode}"`;
	return `<!doctype html>
<html lang="${lang}"${modeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
${paletteBlocks(design, mode)}
${css}
</style>
</head>
<body>
<article>
${body}
</article>
</body>
</html>
`;
}

// Preview page showing light and dark side by side (stacked) for the smoke test.
export function buildPreviewPage({ bodies, title, designId, hasMath, warnings }) {
	const design = designFor(designId);
	const css = baseCss(design, "preview") + (hasMath ? `\n${katexCss(warnings)}` : "");
	const section = (mode, body) => `
<section data-scope="${mode}">
<h1 style="font-family:${design.sans};color:var(--heading)">${design.name} — ${mode}</h1>
<article>${body}</article>
</section>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
${paletteBlocks(design, "preview")}
${css}
${shikiShim("preview")}
body { margin: 0; }
section[data-scope="light"] { background: var(--bg); color: var(--text); padding-bottom: 2rem; }
section[data-scope="dark"] { background: var(--bg); color: var(--text); padding-bottom: 2rem; }
section + section { border-top: 4px solid #888; }
</style>
</head>
<body>
${section("light", bodies.light)}
${section("dark", bodies.dark)}
</body>
</html>
`;
}
