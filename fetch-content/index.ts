import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const GEMINI_GENERATE_URL =
	"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

const FETCH_TIMEOUT_MS = 30_000;
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_CONTENT_LENGTH = 100_000;

const FetchContentParameters = Type.Object({
	url: Type.Optional(
		Type.String({
			description: "A single http:// or https:// URL to fetch.",
		}),
	),
	urls: Type.Optional(
		Type.Array(
			Type.String({
				description: "One or more http:// or https:// URLs to fetch in parallel.",
			}),
		),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("summary"), Type.Literal("verbatim")], {
			description: '"summary" (default) extracts a concise summary; "verbatim" returns the full substantive content.',
		}),
	),
	prompt: Type.Optional(
		Type.String({
			description: "A target question or topic to focus the extraction on.",
		}),
	),
});

const truncate = (s: string) =>
	s.length > MAX_CONTENT_LENGTH ? `${s.slice(0, MAX_CONTENT_LENGTH)}...` : s;

function extractErrorMessage(payload: unknown, fallback: string): string {
	if (typeof payload === "string" && payload.trim()) {
		return payload.trim();
	}
	if (payload && typeof payload === "object") {
		const obj = payload as Record<string, unknown>;
		if (typeof obj.message === "string" && obj.message.trim()) {
			return obj.message.trim();
		}
		if (typeof obj.error === "string" && obj.error.trim()) {
			return obj.error.trim();
		}
		if (obj.error && typeof obj.error === "object") {
			const nested = obj.error as Record<string, unknown>;
			if (typeof nested.message === "string" && nested.message.trim()) {
				return nested.message.trim();
			}
		}
	}
	return fallback;
}

function isValidHttpUrl(raw: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		return false;
	}
	return parsed.protocol === "http:" || parsed.protocol === "https:";
}

// Strip noise tags and decode HTML entities into a plain text-ish blob.
// ponytail: regex-based HTML scrubbing is lossy but good enough to cut tokens
// before Gemini re-cleans it; upgrade to a DOM parser if structure matters.
function cleanHtml(html: string): string {
	const stripped = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ")
		.replace(/<canvas[\s\S]*?<\/canvas>/gi, " ")
		.replace(/<head[\s\S]*?<\/head>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();

	return truncate(stripped);
}

async function fetchAndClean(rawUrl: string, parentSignal?: AbortSignal): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	if (parentSignal) {
		if (parentSignal.aborted) controller.abort();
		else parentSignal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	let response: Response;
	try {
		response = await fetch(rawUrl, {
			headers: {
				"User-Agent": BROWSER_USER_AGENT,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
			signal: controller.signal,
		});
	} catch (err) {
		throw new Error(`Fetch failed for ${rawUrl}: ${extractErrorMessage(err, "network error")}`);
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) {
		let detail = response.statusText;
		try {
			const raw = await response.text();
			if (raw.trim()) {
				try {
					detail = extractErrorMessage(JSON.parse(raw), response.statusText);
				} catch {
					detail = raw.trim();
				}
			}
		} catch {
			// keep statusText
		}
		throw new Error(`Fetch failed for ${rawUrl} (status ${response.status}${detail ? `: ${detail}` : ""})`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	const body = await response.text();

	// Non-HTML payloads are returned as-is (truncated), no tag stripping needed.
	if (!/text\/html|application\/xhtml/i.test(contentType)) {
		const trimmed = body.trim();
		return truncate(trimmed);
	}

	return cleanHtml(body);
}

async function processWithGemini(
	text: string,
	mode: "summary" | "verbatim",
	prompt: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	const focus = prompt.trim() ? `\n\nFocus the extraction on this question/topic:\n${prompt.trim()}` : "";

	const instructions = `You are a web content extraction assistant. Process raw text scraped from a web page.

Always remove: GDPR notices, cookie banners, navigation menus, headers, footers, ads, and all web boilerplate.
Return clean, well-structured Markdown only.

${
	mode === "summary"
		? `Extract all relevant information into a clean, concise, well-structured markdown summary. Do not invent facts not present in the content.`
		: `Return the entire substantive content VERBATIM as clean Markdown. Keep all text, code blocks, lists, and tables intact. Do not summarize, abbreviate, or skip content. Only omit boilerplate.`
}${focus}

Raw scraped content:
${text}`;

	const response = await fetch(GEMINI_GENERATE_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-goog-api-key": apiKey,
		},
		body: JSON.stringify({
			contents: [{ role: "user", parts: [{ text: instructions }] }],
			generationConfig: { temperature: 0.2 },
		}),
		signal,
	});

	if (!response.ok) {
		let detail = response.statusText;
		try {
			const raw = await response.text();
			if (raw.trim()) {
				try {
					detail = extractErrorMessage(JSON.parse(raw), response.statusText);
				} catch {
					detail = raw.trim();
				}
			}
		} catch {
			// keep statusText
		}
		throw new Error(`Gemini processing failed (status ${response.status}${detail ? `: ${detail}` : ""})`);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error("Malformed JSON response from Gemini API");
	}

	const candidateText = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
		?.candidates?.[0]?.content?.parts?.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.join("")
		.trim();

	if (!candidateText) {
		throw new Error("Gemini returned empty content");
	}

	return candidateText;
}

interface FetchResult {
	url: string;
	content: string;
}

interface CleanedFetch {
	url: string;
	cleaned: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch one or more http(s) URLs and extract clean, structured content via Gemini gemini-3.5-flash-lite. Use summary mode for concise extraction or verbatim mode for full substantive content.",
		parameters: FetchContentParameters,
		async execute(_toolCallId, params, signal, onUpdate) {
			const geminiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)?.trim();

			const mode: "summary" | "verbatim" =
				params.mode === "verbatim" ? "verbatim" : "summary";
			const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";

			const rawUrls: string[] = [];
			if (typeof params.url === "string" && params.url.trim()) rawUrls.push(params.url.trim());
			if (Array.isArray(params.urls)) {
				for (const u of params.urls) {
					if (typeof u === "string" && u.trim()) rawUrls.push(u.trim());
				}
			}

			if (rawUrls.length === 0) {
				return {
					content: [
						{ type: "text", text: "No URL provided. Provide at least one of `url` or `urls`." },
					],
					details: { error: "MISSING_URL" },
				};
			}

			const validUrls: string[] = [];
			const invalidUrls: string[] = [];
			for (const u of rawUrls) {
				if (isValidHttpUrl(u)) validUrls.push(u);
				else invalidUrls.push(u);
			}

			if (validUrls.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No valid http(s) URLs. Invalid: ${invalidUrls.join(", ")}`,
						},
					],
					details: { error: "INVALID_URLS", invalidUrls },
				};
			}

			onUpdate?.({ content: [{ type: "text", text: "Fetching..." }] });

			const fetchSettled = await Promise.allSettled(
				validUrls.map((u) => fetchAndClean(u, signal)),
			);

			const cleaned: CleanedFetch[] = [];
			const fetchFailures: Array<{ url: string; error: string }> = [];
			for (let i = 0; i < fetchSettled.length; i++) {
				const s = fetchSettled[i];
				if (s.status === "fulfilled") {
					cleaned.push({ url: validUrls[i], cleaned: s.value });
				} else {
					fetchFailures.push({
						url: validUrls[i],
						error: extractErrorMessage(s.reason, "unknown error"),
					});
				}
			}

			if (cleaned.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `All fetches failed:\n${fetchFailures.map((f) => `- ${f.url}: ${f.error}`).join("\n")}`,
						},
					],
					details: { error: "ALL_FETCHES_FAILED", failures: fetchFailures },
				};
			}

			const results: FetchResult[] = [];
			const processFailures: Array<{ url: string; error: string }> = [];

			if (!geminiKey) {
				for (const item of cleaned) {
					results.push({
						url: item.url,
						content: `${item.cleaned}\n\n> Note: GEMINI_API_KEY (or GOOGLE_API_KEY) not set; returning locally cleaned text without Gemini processing.`,
					});
				}
			} else {
				onUpdate?.({ content: [{ type: "text", text: "Processing with Gemini..." }] });

				const processSettled = await Promise.allSettled(
					cleaned.map((item) =>
						processWithGemini(item.cleaned, mode, prompt, geminiKey, signal).then(
							(content): FetchResult => ({ url: item.url, content }),
						),
					),
				);

				for (let i = 0; i < processSettled.length; i++) {
					const s = processSettled[i];
					if (s.status === "fulfilled") {
						results.push(s.value);
					} else {
						processFailures.push({
							url: cleaned[i].url,
							error: extractErrorMessage(s.reason, "unknown error"),
						});
					}
				}
			}

			const failures = [...fetchFailures, ...processFailures];

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Could not retrieve or process content for any URL:\n${failures.map((f) => `- ${f.url}: ${f.error}`).join("\n")}`,
						},
					],
					details: { error: "ALL_FETCHES_FAILED", failures },
				};
			}

			const blocks = results.map((r) => `## ${r.url}\n\n${r.content}`);

			const failureNote =
				failures.length > 0
					? `\n\n---\n\nFailed URLs:\n${failures.map((f) => `- ${f.url}: ${f.error}`).join("\n")}`
					: "";

			return {
				content: [{ type: "text", text: `${blocks.join("\n\n---\n\n")}${failureNote}` }],
				details: {
					mode,
					fetchedCount: results.length,
					failedCount: failures.length,
					invalidUrls,
					geminiUsed: Boolean(geminiKey),
				},
			};
		},
	});
}
