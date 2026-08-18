import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const GEMINI_GENERATE_URL =
	"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

const MAX_HIGHLIGHT_LENGTH = 500;
const MAX_TOTAL_EVIDENCE_LENGTH = 12000;

const ExaSearchParameters = Type.Object({
	question: Type.String({
		description: "The specific question or target answer you need synthesized from web evidence.",
	}),
	queries: Type.Array(
		Type.String({
			description: "Search queries in ranked order. Provide 1-5 varied angles/phrasings for broad coverage.",
		}),
		{
			minItems: 1,
			maxItems: 5,
			description: "Ranked list of 1 to 5 search queries. Pass a JSON string array as `queries`, never bracket-indexed keys such as `queries[0]`.",
		},
	),
	numResults: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 10,
			default: 5,
			description: "Number of search results per query (1-10, default 5).",
		}),
	),
	numQueries: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5,
			default: 3,
			description: "Maximum number of queries to execute from the provided queries list (1-5, default 3).",
		}),
	),
});

interface ExaResult {
	title?: string | null;
	url?: string | null;
	publishedDate?: string | null;
	highlights?: unknown;
}

interface NormalizedEvidence {
	title: string;
	url: string;
	publishedDate?: string;
	highlights: string[];
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

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

async function searchExa(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<NormalizedEvidence[]> {
	const response = await fetch(EXA_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			query,
			type: "auto",
			numResults,
			contents: {
				highlights: true,
			},
		}),
		signal,
	});

	if (!response.ok) {
		let detail = "";
		try {
			const errJson = await response.json();
			detail = extractErrorMessage(errJson, response.statusText);
		} catch {
			try {
				detail = (await response.text()).trim();
			} catch {
				detail = response.statusText;
			}
		}
		throw new Error(`Exa search failed (status ${response.status}${detail ? `: ${detail}` : ""})`);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error("Malformed JSON response from Exa search API");
	}

	if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
		return [];
	}

	const rawResults = (data as { results: ExaResult[] }).results;
	const items: NormalizedEvidence[] = [];

	for (const item of rawResults) {
		if (!item || typeof item !== "object") continue;
		const rawUrl = typeof item.url === "string" ? item.url.trim() : "";
		if (!rawUrl) continue;

		const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : rawUrl;
		const publishedDate =
			typeof item.publishedDate === "string" && item.publishedDate.trim()
				? item.publishedDate.trim()
				: undefined;

		const rawHighlights = Array.isArray(item.highlights) ? item.highlights : [];
		const highlights: string[] = [];

		for (const h of rawHighlights) {
			if (typeof h === "string") {
				const trimmed = h.trim();
				if (trimmed) {
					highlights.push(
						trimmed.length > MAX_HIGHLIGHT_LENGTH ? `${trimmed.slice(0, MAX_HIGHLIGHT_LENGTH)}...` : trimmed,
					);
				}
			}
		}

		items.push({
			title,
			url: rawUrl,
			publishedDate,
			highlights,
		});
	}

	return items;
}

async function synthesizeWithGemini(
	question: string,
	evidence: NormalizedEvidence[],
	geminiApiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	let evidenceText = "";
	for (const [index, item] of evidence.entries()) {
		const entry = [
			`[Source ${index + 1}]`,
			`Title: ${item.title}`,
			`URL: ${item.url}`,
			item.publishedDate ? `Date: ${item.publishedDate}` : undefined,
			"Highlights:",
			item.highlights.length ? item.highlights.map((h) => `- ${h}`).join("\n") : "- (No text highlights available)",
			"",
		]
			.filter(Boolean)
			.join("\n");

		const block = `${entry}\n`;
		const remaining = MAX_TOTAL_EVIDENCE_LENGTH - evidenceText.length;
		if (remaining <= 0) break;
		evidenceText += block.length > remaining ? block.slice(0, remaining) : block;
	}

	const prompt = `You are a factual synthesis assistant. Answer the user's question directly and concisely based ONLY on the provided web evidence.

Rules:
- Ground all statements strictly in the provided evidence.
- Do not assume, extrapolate, or invent facts not present in the excerpts.
- If the evidence does not contain sufficient details to answer fully, state what is known and mention the limitation.
- Do not fabricate citation keys or URLs in the text.

Question:
${question}

Evidence:
${evidenceText}`;

	const response = await fetch(GEMINI_GENERATE_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-goog-api-key": geminiApiKey,
		},
		body: JSON.stringify({
			contents: [
				{
					role: "user",
					parts: [{ text: prompt }],
				},
			],
			generationConfig: {
				temperature: 0.2,
			},
		}),
		signal,
	});

	if (!response.ok) {
		let detail = "";
		try {
			const errJson = await response.json();
			detail = extractErrorMessage(errJson, response.statusText);
		} catch {
			try {
				detail = (await response.text()).trim();
			} catch {
				detail = response.statusText;
			}
		}
		throw new Error(`Gemini synthesis failed (status ${response.status}${detail ? `: ${detail}` : ""})`);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error("Malformed JSON response from Gemini API");
	}

	const candidates = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
		?.candidates;
	const candidateText = candidates?.[0]?.content?.parts
		?.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.join("")
		.trim();

	if (!candidateText) {
		throw new Error("Gemini returned empty synthesis text");
	}

	return candidateText;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description:
			"Search the web using Exa's neural/auto search across multiple ranked query angles and synthesize a direct answer with Gemini gemini-3.5-flash-lite. Always provide 1-5 varied query angles in queries for comprehensive coverage.",
		parameters: ExaSearchParameters,
		async execute(_toolCallId, params, signal, onUpdate) {
			const exaKey = process.env.EXA_API_KEY?.trim();
			const geminiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)?.trim();

			if (!exaKey) {
				return {
					content: [
						{
							type: "text",
							text: "Missing EXA_API_KEY environment variable. Please set EXA_API_KEY to use exa_search.",
						},
					],
					details: { error: "MISSING_EXA_API_KEY" },
				};
			}

			if (!geminiKey) {
				return {
					content: [
						{
							type: "text",
							text: "Missing GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable. Please set GEMINI_API_KEY to use exa_search.",
						},
					],
					details: { error: "MISSING_GEMINI_API_KEY" },
				};
			}

			const rawQueries = Array.isArray(params.queries) ? params.queries : [];
			const cleanQueries = rawQueries.map((q) => (typeof q === "string" ? q.trim() : "")).filter(Boolean);

			if (cleanQueries.length === 0) {
				return {
					content: [{ type: "text", text: "No valid search queries provided." }],
					details: { error: "EMPTY_QUERIES" },
				};
			}

			const targetQuestion = typeof params.question === "string" ? params.question.trim() : "";
			if (!targetQuestion) {
				return {
					content: [{ type: "text", text: "No question provided for synthesis." }],
					details: { error: "EMPTY_QUESTION" },
				};
			}

			const maxQueries = clamp(
				typeof params.numQueries === "number" ? params.numQueries : 3,
				1,
				5,
			);
			const numResults = clamp(
				typeof params.numResults === "number" ? params.numResults : 5,
				1,
				10,
			);

			const selectedQueries = cleanQueries.slice(0, maxQueries);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Searching Exa with ${selectedQueries.length} query angle(s)...`,
					},
				],
			});

			const searchPromises = selectedQueries.map((q) => searchExa(q, numResults, exaKey, signal));
			const settled = await Promise.allSettled(searchPromises);
			const resultsPerQuery: NormalizedEvidence[][] = [];
			let firstRejection: unknown = null;
			for (const s of settled) {
				if (s.status === "fulfilled") {
					resultsPerQuery.push(s.value);
				} else if (firstRejection === null) {
					firstRejection = s.reason;
				}
			}
			if (resultsPerQuery.length === 0) {
				throw new Error(extractErrorMessage(firstRejection, "All Exa search queries failed"));
			}

			const dedupedSources: NormalizedEvidence[] = [];
			const seenUrls = new Set<string>();

			for (const list of resultsPerQuery) {
				for (const item of list) {
					if (!seenUrls.has(item.url)) {
						seenUrls.add(item.url);
						dedupedSources.push(item);
					}
				}
			}

			if (dedupedSources.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No usable search results found for the provided queries.",
						},
					],
					details: { queryCount: selectedQueries.length, resultCount: 0 },
				};
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Synthesizing answer from ${dedupedSources.length} source(s)...`,
					},
				],
			});

			const summary = await synthesizeWithGemini(targetQuestion, dedupedSources, geminiKey, signal);

			const sourcesList = dedupedSources.map((s) => `- ${s.title}: ${s.url}`).join("\n");
			const finalOutput = `${summary}\n\nSources:\n${sourcesList}`;

			return {
				content: [{ type: "text", text: finalOutput }],
				details: {
					queryCount: selectedQueries.length,
					sourceCount: dedupedSources.length,
				},
			};
		},
	});
}
