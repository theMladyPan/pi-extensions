// Theme design. Shipped: "github" (verbatim github.com markdown rendering, light + dark).
// The DESIGNS map keeps the shape for future designs: vars, fonts, shiki themes, mermaid config.
export const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", "Noto Sans Mono", "DejaVu Sans Mono", monospace';

export const DESIGNS = {
	github: {
		name: "GitHub",
		note: "Verbatim github.com markdown rendering: Primer colors, system fonts, line-height 1.5.",
		sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
		mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "Noto Sans Mono", "DejaVu Sans Mono", monospace',
		headings: "inherit",
		shiki: { light: "github-light", dark: "github-dark" },
		vars: {
			light: {
				bg: "#ffffff", bgCode: "#f6f8fa", bgInset: "#f6f8fa", border: "#d1d9e0",
				text: "#1f2328", textMuted: "#59636e", heading: "#1f2328", link: "#0969da",
				accent: "#0969da", accentSoft: "#ddf4ff", mark: "#fff8c5", mermaidBg: "transparent",
			},
			dark: {
				bg: "#0d1117", bgCode: "#151b23", bgInset: "#151b23", border: "#3d444d",
				text: "#e6edf3", textMuted: "#9198a1", heading: "#e6edf3", link: "#4493f8",
				accent: "#4493f8", accentSoft: "#121d2f", mark: "#bb8009", mermaidBg: "transparent",
			},
		},
		mermaid: {
			light: { theme: "neutral" },
			dark: { theme: "dark", themeVariables: { background: "transparent" } },
		},
		extraCss: `
body { line-height: 1.5; font-size: 16px; }
article { max-width: 1012px; padding: 32px; }
h1 { font-size: 2em; font-weight: 600; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
h2 { font-size: 1.5em; font-weight: 600; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.25em; font-weight: 600; }
h4 { font-size: 1em; font-weight: 600; }
h5, h6 { font-size: 0.875em; text-transform: none; letter-spacing: 0; color: var(--text-muted); }
p { margin: 0 0 16px; }
ul, ol { padding-left: 2em; margin: 0 0 16px; }
li > p { margin-bottom: 8px; }
blockquote {
	margin: 0 0 16px;
	padding: 0 1em;
	color: var(--text-muted);
	border-left: 0.25em solid var(--border);
	background: none;
	border-radius: 0;
}
code { font-size: 85%; padding: 0.2em 0.4em; border-radius: 6px; }
pre { padding: 16px; border-radius: 6px; line-height: 1.45; font-size: 85%; }
table { font-size: 100%; margin: 0 0 16px; width: max-content; max-width: 100%; }
th, td { padding: 6px 13px; }
tbody tr { background: none; }
hr { height: 0.25em; margin: 24px 0; background-color: var(--border); border: 0; }
.footnotes { font-size: 87%; }
.mermaid-block svg { display: block; }`,
	},
};

export function designFor(id) {
	const d = DESIGNS[id];
	if (!d) throw new Error(`Unknown design '${id}'. Available: ${Object.keys(DESIGNS).join(", ")}`);
	return d;
}
