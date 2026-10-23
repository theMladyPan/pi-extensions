/**
 * Voice mode for pi: live prompt building from the microphone, spoken breadcrumbs
 * as the agent works, and a hotkey that submits when idle or steers mid-run.
 *
 * The plugin is either on or off, starting off.
 *
 * Shortcuts
 *   alt+s  turn voice mode on or off
 *   alt+x  mute or unmute the microphone while voice mode is on
 *   alt+l  switch the recognition and speech language between English and Slovak
 *
 * Command
 *   /voice [on|off|mute|unmute|lang en|lang sk]
 *
 * How speech differs from the console
 *   The transcript keeps exact filenames, paths, and numbers. The spoken stream
 *   passes through `humanizeForSpeech` first, so `src/config/settings.py` is read
 *   aloud as "settings py in src config folder" and a commit hash is "a hash".
 *   The language hint is sent to both directions: `speechConfig.languageCode`
 *   for TTS, and a leading text part for the transcribe model, which rejects
 *   `systemInstruction`.
 *
 * How live dictation works
 *   `arecord` streams 16 kHz mono s16le PCM on stdout. An energy gate inspects
 *   100 ms frames; quiet frames never leave the machine, so silence costs $0.
 *   When speech starts, frames accumulate until a short pause (~0.7 s of quiet)
 *   or 5.5 s of continuous speech, then that utterance is sent to
 *   `gemini-3.5-transcribe` and appended into the editor live. Speaking starts
 *   silencing any ongoing TTS after a couple of voiced frames (barge-in).
 *
 * How live breadcrumbs work
 *   When voice mode is on, `before_agent_start` adds a `voice_breadcrumbs`
 *   system-prompt section asking the model to narrate each step AFTER thinking
 *   and BEFORE its tool batch in one short spoken sentence ("Found a stale
 *   note in the auth docs, checking the validator next…") and end with a tight
 *   spoken wrap-up. `message_update` watches `text_delta` events, pulls complete
 *   sentences out of the stream as they arrive, strips markdown/code, and queues
 *   them into `gemini-3.8-flash-tts` (voice `Fola`) so speech happens while the
 *   tools run rather than after the whole turn finishes.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Measured on identical Slovak audio: the dedicated transcribe model drifted to Bulgarian/Polish
// on 4 of 12 clips, while flash read all 12 correctly. Flash is the default; env can override.
const DEFAULT_STT_MODEL = process.env.PI_VOICE_STT_MODEL ?? "gemini-3.8-flash";
const DEFAULT_TTS_MODEL = process.env.PI_VOICE_TTS_MODEL ?? "gemini-3.8-flash-tts";
const DEFAULT_VOICE = process.env.PI_VOICE_NAME ?? "Fola";

export type Lang = "en" | "sk";

interface LangConfig {
	/** BCP-47 code passed as speechConfig.languageCode. */
	code: string;
	label: string;
	/** Leading text part for the transcribe model; it rejects systemInstruction. */
	sttHint: string;
}

const LANGS: Record<Lang, LangConfig> = {
	en: {
		code: "en-US",
		label: "English",
		sttHint:
			"Transcribe this English (en-US) audio verbatim in English. Output only the transcript, no commentary. If there is no clear speech, output nothing.",
	},
	sk: {
		code: "sk-SK",
		label: "Slovak",
		sttHint:
			"Transcribe this Slovak (sk-SK) audio verbatim in Slovak. Output only the transcript, no commentary. If there is no clear speech, output nothing.",
	},
};

const initialLang = (process.env.PI_VOICE_LANG ?? "en") as Lang;

const WRAP_MODEL = process.env.PI_VOICE_WRAP_MODEL ?? "gemini-3.5-flash-lite";
/** Set PI_VOICE_LOG to a file path to record every spoken line, useful when tuning the voice. */
const VOICE_LOG = process.env.PI_VOICE_LOG;
const WRAP_MAX_CHARS = 320;

/** Short spoken closure: what actually changed, plus the one question worth answering next. */
const WRAP_INSTRUCTIONS = [
	"You summarize a coding agent's finished reply for someone who is listening, not reading.",
	"Write one or two spoken sentences, at most 40 words. Say what actually changed or what the situation now is. If the reply leaves an obvious next decision, end with the single most useful question in one short sentence.",
	"No file paths, no directories, no markdown, no code, no lists. Name a file only if it is essential, and then just the file name.",
	"Answer in the same language as the reply.",
	"Example reply: 'Moved RETRY_TIMEOUT into src/config/settings.py, updated client.py and worker.py, client tests pass, worker suite does not exist.'",
	"Example output for it: 'I consolidated the retry timeout into settings py and the client tests pass. Do you want worker tests written next?'",
	"Example reply: 'Zjednotil som RETRY_TIMEOUT do settings.py a upravil klienta. Testy klienta prechádzajú.'",
	"Example output for it: 'Zjednotil som timeout do settings py a testy klienta prechádzajú. Mám doplniť testy pre workera?'",
].join("\n");

const SAMPLE_RATE = 16_000;
const FRAME_MS = 100;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // 3200 bytes = 100 ms of s16le mono
const SILENCE_HOLD_FRAMES = 7; // 700 ms of quiet closes an utterance
const MIN_VOICED_FRAMES = 3; // ≥ 300 ms of speech before we bother transcribing
const MAX_UTTERANCE_FRAMES = 65; // flush every 6.5 s during long stretches so text appears live
const BARGE_IN_FRAMES = 2; // 200 ms of speech cuts current playback
const RMS_SPEECH_START = Number(process.env.PI_VOICE_RMS ?? 320); // enter utterance above ~3x ambient noise (~80 RMS)
const RMS_SPEECH_HOLD = Math.round(RMS_SPEECH_START * 0.65); // stay in utterance through softer syllables (~210 RMS)

const BREADCRUMB_PROMPT = [
	"[LIVE VOICE MODE: ONLY SHORT BREADCRUMBS ARE SPOKEN. YOUR FINAL ANSWER IS READ IN THE CONSOLE AND IS NOT SPOKEN]",
	"Before each tool call, write ONE short conversational line about what you just found or decided and what you do next. That single line is the only thing the user hears from you.",
	'Never say paths or directories. Name the file only, like "settings py" or "the compose yaml", and never a long path.',
	'Style: "Stumbled on a stale auth note; checking how the validator runs."',
	'Style: "The key check never validates the signature — fixing that."',
	'Style: "Three copies of the retry timeout; consolidating into settings py."',
	"No markdown, tables, or code blocks in breadcrumbs. One line per tool batch, and do not restate your final answer for the ears.",
].join("\n");

/** Root-mean-square amplitude of a 16-bit signed little-endian PCM buffer. */
export function pcmRms(frame: Buffer): number {
	const samples = frame.length >> 1;
	if (samples === 0) return 0;
	let sumSquares = 0;
	for (let i = 0; i < samples; i++) {
		const sample = frame.readInt16LE(i * 2);
		sumSquares += sample * sample;
	}
	return Math.sqrt(sumSquares / samples);
}

export function wrapPcmAsWav(pcm: Buffer, rate: number, channels = 1): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * channels * 2, 28);
	header.writeUInt16LE(channels * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/** Extension spoken as a word instead of spelled out. */
const EXTENSION_WORDS: Record<string, string> = {
	md: "markdown",
	markdown: "markdown",
	py: "py",
	ts: "ts",
	tsx: "tsx",
	js: "js",
	jsx: "jsx",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	sh: "shell",
	bash: "shell",
	txt: "text",
	css: "css",
	html: "html",
	rs: "rust",
	go: "go",
	sql: "sql",
	lock: "lock",
	ini: "ini",
	cfg: "config",
	conf: "config",
	log: "log",
	wav: "wav",
	csv: "csv",
	png: "png",
	svg: "svg",
	xml: "xml",
	env: "env",
};

/** Paths, optionally with directories, or bare filenames with an extension. */
const PATH_PATTERN = /(?:[\w.@+-]+\/)+[\w.@+-]+|[\w-]+\.[A-Za-z][A-Za-z0-9]{1,7}\b/g;

/** `settings_py` → `settings py`, `parseToken` → `parse token`, `README` → `readme`. */
export function splitIdentifier(word: string): string {
	const spaced = word
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
	return spaced.toLowerCase().trim();
}

function speakPath(match: string): string {
	const segments = match.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	const base = segments.pop() ?? match;
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const extension = dot > 0 ? base.slice(dot + 1) : "";
	const stemWords = splitIdentifier(stem);
	const extensionWord = extension ? (EXTENSION_WORDS[extension.toLowerCase()] ?? splitIdentifier(extension)) : "";
	// Directories are dropped on purpose: a spoken path is long, noisy, and useless to the ear.
	return extensionWord ? `${stemWords} ${extensionWord}` : stemWords;
}

/**
 * Make text pleasant to hear without changing what the console shows.
 * Filenames become words, identifiers become spaced words, and unreadable
 * values (hashes, uuids, long numbers) become plain nouns.
 */
export function humanizeForSpeech(text: string): string {
	let out = text;
	out = out.replace(PATH_PATTERN, (match) => speakPath(match));
	out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "a uuid");
	out = out.replace(/\b0x[0-9a-f]+\b/gi, "a hex value");
	out = out.replace(/(\D):(\d{1,4})\b/g, "$1 line $2");
	out = out.replace(/\b[0-9a-f]{7,}\b/gi, "a hash");
	out = out.replace(/\b\d{4,}\b/g, "a number");
	out = out.replace(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi, (match) => splitIdentifier(match));
	out = out.replace(/\b([a-z]+[A-Z][A-Za-z0-9]*)\b/g, (match) => splitIdentifier(match));
	out = out
		.replace(/->|=>/g, " to ")
		.replace(/<=|>=/g, " compared to ")
		.replace(/==|!=/g, " equals ")
		.replace(/&&/g, " and ")
		.replace(/\|\|/g, " or ");
	return out.replace(/\s+/g, " ").trim();
}

/**
 * Turn a markdown answer into prose worth hearing. Code, tables, links, and
 * decoration are dropped so the speaker does not read a diff character by
 * character. Truncation lands on a sentence boundary.
 */
export function toSpeakable(markdown: string, maxChars = 420): string {
	let text = markdown;
	text = text.replace(/```[\s\S]*?```/g, " ");
	text = text.replace(/^\s*\|.*\|\s*$/gm, " ");
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	text = text.replace(/<?https?:\/\/\S+>?/g, "");
	text = text.replace(/^\s{0,3}#{1,6}\s*/gm, "");
	text = text.replace(/^\s*[-*+]\s+/gm, "");
	text = text.replace(/^\s*>\s?/gm, "");
	text = text.replace(/`([^`]+)`/g, "$1");
	text = text.replace(/[*_~]{1,3}/g, "");
	text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu, "");
	text = text.replace(/\s+/g, " ").trim();
	text = humanizeForSpeech(text);
	if (text.length <= maxChars) return text;
	const window = text.slice(0, maxChars);
	const stop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
	if (stop > maxChars * 0.4) return window.slice(0, stop + 1);
	const space = window.lastIndexOf(" ");
	return `${window.slice(0, space > 0 ? space : maxChars)}…`;
}

/**
 * Pull complete sentences off a streaming text buffer while tracking fenced code
 * blocks so code is never read aloud. Returns the sentences ready to speak and
 * the unconsumed tail of the stream.
 */
export class SentenceStream {
	private buffer = "";
	private inFence = false;

	push(delta: string): string[] {
		this.buffer += delta;
		const ready: string[] = [];

		while (true) {
			const fenceIdx = this.buffer.indexOf("```");
			if (this.inFence) {
				if (fenceIdx === -1) {
					this.buffer = "";
					break;
				}
				this.buffer = this.buffer.slice(fenceIdx + 3);
				this.inFence = false;
				continue;
			}

			const scanLimit = fenceIdx === -1 ? this.buffer.length : fenceIdx;
			const slice = this.buffer.slice(0, scanLimit);
			const boundary = findSentenceBoundary(slice);

			if (boundary !== -1) {
				const raw = this.buffer.slice(0, boundary).trim();
				this.buffer = this.buffer.slice(boundary);
				const clean = toSpeakable(raw);
				if (clean.length >= 4) ready.push(clean);
				continue;
			}

			if (fenceIdx !== -1) {
				const beforeFence = toSpeakable(slice);
				if (beforeFence.length >= 4) ready.push(beforeFence);
				this.buffer = this.buffer.slice(fenceIdx + 3);
				this.inFence = true;
				continue;
			}

			break;
		}
		return ready;
	}

	flush(): string[] {
		if (this.inFence) {
			this.buffer = "";
			this.inFence = false;
			return [];
		}
		const clean = toSpeakable(this.buffer);
		this.buffer = "";
		return clean.length >= 4 ? [clean] : [];
	}

	reset(): void {
		this.buffer = "";
		this.inFence = false;
	}
}

function findSentenceBoundary(text: string): number {
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\n" && text[i + 1] === "\n" && i >= 12) return i + 2;
		if ((ch === "." || ch === "!" || ch === "?") && i >= 16) {
			const next = text[i + 1];
			if (next === " " || next === "\n") return i + 2;
		}
	}
	return -1;
}

async function gemini(model: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
	const key = process.env.GEMINI_API_KEY;
	if (!key) throw new Error("GEMINI_API_KEY is not set");
	const response = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${key}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		signal: signal ?? AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		const body = (await response.text()).slice(0, 240);
		throw new Error(`${model} HTTP ${response.status}: ${body}`);
	}
	return (await response.json()) as unknown;
}

export function extractTranscript(response: unknown): string {
	const parts = (((response as any)?.candidates?.[0]?.content?.parts ?? []) as any[]);
	const pieces: string[] = [];
	for (const part of parts) {
		if (typeof part?.audioTranscription?.text === "string") pieces.push(part.audioTranscription.text);
		else if (typeof part?.text === "string") pieces.push(part.text);
	}
	return pieces.join(" ").replace(/\s+/g, " ").trim();
}

/** Seconds of 24 kHz mono s16le audio inside a WAV buffer, or 0 when the header is unreadable. */
export function wavSeconds(wav: Buffer): number {
	if (wav.length <= 44) return 0;
	const byteRate = wav.length > 28 ? wav.readUInt32LE(28) : 0;
	return byteRate > 0 ? (wav.length - 44) / byteRate : 0;
}

const CHARS_PER_SECOND = 13; // rough speaking pace, used only to spot a truncated render

/** A message that calls tools is a breadcrumb message; one without calls is the final answer. */
export function hasToolCallBlocks(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((block: any) => block?.type === "toolCall" || block?.type === "tool_call");
}

/** Keep breadcrumbs to a line or two: the ears get the gist, the console keeps the detail. */
export function takeBreadcrumb(sentences: string[], maxSentences = 2, maxChars = 240): string[] {
	const kept: string[] = [];
	let total = 0;
	for (const sentence of sentences) {
		if (kept.length >= maxSentences) break;
		if (total + sentence.length > maxChars) {
			if (kept.length === 0) kept.push(sentence.slice(0, maxChars));
			break;
		}
		kept.push(sentence);
		total += sentence.length;
	}
	return kept;
}

/**
 * One transcription attempt. The language hint must lead: the transcribe model
 * rejects systemInstruction, and without a hint Slovak speech is misread as Polish.
 */
async function transcribeOnce(wav: Buffer, model: string, lang: Lang): Promise<string> {
	const response = await gemini(model, {
		contents: [
			{
				parts: [
					{ text: LANGS[lang].sttHint },
					{ inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
				],
			},
		],
	});
	return extractTranscript(response);
}

/**
 * Transcribe speech. An empty result on a clip long enough to contain speech is
 * retried once with a firmer hint, because silence is common enough to lose
 * otherwise-good dictation.
 */
export async function transcribeWav(wav: Buffer, model = DEFAULT_STT_MODEL, lang: Lang = "en"): Promise<string> {
	const first = await transcribeOnce(wav, model, lang);
	const wrongScript = /[\u0400-\u04FF]/.test(first);
	if (first && !wrongScript) return first;
	if (wavSeconds(wav) < 0.4) return first;
	// Empty output and Cyrillic output are the two observed failure modes; one retry recovers most.
	const second = await transcribeOnce(wav, model, lang);
	return wrongScript && second ? second : second || first;
}

async function synthesizeOnce(text: string, voice: string, model: string, lang: Lang): Promise<Buffer> {
	const response = await gemini(model, {
		contents: [{ parts: [{ text }] }],
		generationConfig: {
			responseModalities: ["AUDIO"],
			speechConfig: {
				languageCode: LANGS[lang].code,
				voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
			},
		},
	});
	const parts = (((response as any)?.candidates?.[0]?.content?.parts ?? []) as any[]);
	for (const part of parts) {
		const inline = part?.inlineData ?? part?.inline_data;
		if (inline?.data) {
			const data = Buffer.from(inline.data, "base64");
			const mime: string = inline.mimeType ?? inline.mime_type ?? "audio/wav";
			if (mime.startsWith("audio/L16")) {
				const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24_000);
				return wrapPcmAsWav(data, rate);
			}
			return data;
		}
	}
	throw new Error(`${model} returned no audio`);
}

/**
 * Render speech. A render far shorter or longer than the text can plausibly take
 * is retried once; the observed failure mode is a truncated clip, and a retry is
 * cheaper than speaking a sentence the user cannot make out.
 */
/** Last sentence of a reply, used when the summarizer is unavailable. */
export function lastSentence(text: string, maxChars = 240): string {
	const clean = toSpeakable(text, maxChars * 2);
	const sentences = clean.match(/[^.!?]+[.!?]*/g) ?? [clean];
	return (sentences[sentences.length - 1] ?? "").trim().slice(0, maxChars);
}

/**
 * Condense a finished reply into the one thing worth hearing: what changed, plus
 * the next question. Falls back to the reply's last sentence if the call fails,
 * so the user is never left in silence after a run.
 */
export async function summarizeForSpeech(answer: string, lang: Lang = "en"): Promise<string> {
	try {
		const response = await gemini(WRAP_MODEL, {
			contents: [{ parts: [{ text: `${WRAP_INSTRUCTIONS}\n\nReply:\n${answer.slice(0, 6000)}` }] }],
			generationConfig: { temperature: 0.3, maxOutputTokens: 160 },
		});
		const text = extractTranscript(response);
		if (text) return toSpeakable(text, WRAP_MAX_CHARS);
	} catch {
		// Fall through to the extractive fallback.
	}
	return lastSentence(answer);
}

export async function synthesize(
	text: string,
	voice = DEFAULT_VOICE,
	model = DEFAULT_TTS_MODEL,
	lang: Lang = "en",
): Promise<Buffer> {
	const first = await synthesizeOnce(text, voice, model, lang);
	const expected = text.length / CHARS_PER_SECOND;
	const seconds = wavSeconds(first);
	const plausible = seconds >= 0.25 && seconds >= expected * 0.45 && seconds <= expected * 2.6 + 1;
	return plausible ? first : synthesizeOnce(text, voice, model, lang);
}

function hasCommand(name: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

function appendToEditor(ctx: ExtensionContext, snippet: string): void {
	const clean = snippet.trim();
	if (!clean || !ctx.hasUI) return;
	const current = ctx.ui.getEditorText();
	const separator = current.length > 0 && !/\s$/.test(current) ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}${clean}`);
}

export default function voiceExtension(pi: ExtensionAPI) {
	let active = false;
	let muted = false;
	let wrapUpEnabled = process.env.PI_VOICE_WRAP !== "0";
	let lang: Lang = LANGS[initialLang] ? initialLang : "en";
	const voice = DEFAULT_VOICE;

	let activeCtx: ExtensionContext | undefined;
	let workDir: string | undefined;

	// Live mic / VAD state
	let mic: ChildProcess | undefined;
	let pcmCarry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let utteranceFrames: Buffer[] = [];
	let preRoll: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let voicedFrames = 0;
	let silentFrames = 0;
	let inFlightStt = 0;
	let sttChain: Promise<void> = Promise.resolve();

	// Live TTS queue state
	const stream = new SentenceStream();
	let pendingBreadcrumbs: string[] = [];
	const speechQueue: Array<{ text: string; audio: Promise<Buffer> }> = [];
	let speechDraining = false;
	let speechGeneration = 0;
	let playback: ChildProcess | undefined;
	let playingNow = false;

	const scratch = () => {
		if (!workDir) workDir = mkdtempSync(join(tmpdir(), "pi-voice-"));
		return workDir;
	};

	const renderStatus = () => {
		if (!activeCtx?.hasUI) return;
		if (!active) {
			activeCtx.ui.setStatus("voice", undefined);
			return;
		}
		const micPart = muted
			? "🔇 muted"
			: voicedFrames > 0
				? "🎙 hearing…"
				: inFlightStt > 0
					? "⏳ transcribing"
					: "🎙 live";
		const spkPart = playingNow || speechQueue.length > 0 ? " · 🔊 speaking" : "";
		activeCtx.ui.setStatus("voice", `${micPart} · ${lang.toUpperCase()}${spkPart}`);
	};

	const stopSpeech = () => {
		speechGeneration += 1;
		speechQueue.length = 0;
		pendingBreadcrumbs = [];
		stream.reset();
		if (playback && !playback.killed) playback.kill("SIGTERM");
		playback = undefined;
		playingNow = false;
		renderStatus();
	};

	const playWav = (file: string) =>
		new Promise<void>((resolve) => {
			const [command, args] = hasCommand("ffplay")
				? ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "error", file]]
				: hasCommand("paplay")
					? ["paplay", [file]]
					: ["aplay", ["-q", file]];
			const child = spawn(command as string, args as string[], { stdio: "ignore" });
			playback = child;
			const done = () => {
				if (playback === child) playback = undefined;
				resolve();
			};
			child.once("exit", done);
			child.once("error", done);
		});

	/** Last assistant message text, which is the reply the console shows. */
	const lastAssistantProse = (ctx: ExtensionContext): string => {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry: any = entries[i];
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			const blocks: any[] = entry.message.content ?? [];
			const text = blocks
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
		return "";
	};

	/** Speak the condensed outcome once the run has settled. */
	const speakWrapUp = async (ctx: ExtensionContext) => {
		const answer = lastAssistantProse(ctx);
		if (!answer) return;
		const short = toSpeakable(answer, WRAP_MAX_CHARS);
		const spoken = answer.length <= WRAP_MAX_CHARS ? short : await summarizeForSpeech(answer, lang);
		if (spoken && active) enqueueSentence(spoken, "wrap");
	};

	const enqueueSentence = (sentence: string, kind: "breadcrumb" | "wrap" = "breadcrumb") => {
		if (!active) return;
		if (VOICE_LOG) {
			try {
				appendFileSync(VOICE_LOG, `${new Date().toISOString()} ${kind}: ${sentence}\n`);
			} catch {
				// Logging must never break speech.
			}
		}
		const gen = speechGeneration;
		// Kick synthesis off immediately so the next sentence is already rendering while the current one plays.
		const audio = synthesize(sentence, voice, DEFAULT_TTS_MODEL, lang);
		audio.catch(() => {});
		speechQueue.push({ text: sentence, audio });
		if (!speechDraining) void drainSpeech(gen);
	};

	const drainSpeech = async (gen: number) => {
		speechDraining = true;
		try {
			while (active && gen === speechGeneration && speechQueue.length > 0) {
				const item = speechQueue.shift()!;
				renderStatus();
				const wav = await item.audio;
				if (!active || gen !== speechGeneration) break;
				const file = join(scratch(), `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
				writeFileSync(file, wav);
				playingNow = true;
				renderStatus();
				await playWav(file);
				playingNow = false;
				rmSync(file, { force: true });
			}
		} catch (error) {
			if (active && gen === speechGeneration && activeCtx?.hasUI) {
				const msg = error instanceof Error ? error.message : String(error);
				activeCtx.ui.notify(`TTS error: ${msg}`, "warning");
			}
		} finally {
			// Always release the flag. An interruption bumps the generation, and the old code left
			// speechDraining stuck on true, which silenced every later breadcrumb and wrap-up.
			speechDraining = false;
			if (gen === speechGeneration) {
				playingNow = false;
				renderStatus();
			}
			// Anything queued after the interruption belongs to the new generation; play it.
			if (active && speechQueue.length > 0) void drainSpeech(speechGeneration);
		}
	};

	const flushUtterance = () => {
		if (utteranceFrames.length === 0) return;
		const frames = utteranceFrames;
		const voiced = voicedFrames;
		utteranceFrames = [];
		voicedFrames = 0;
		silentFrames = 0;
		if (voiced < MIN_VOICED_FRAMES) {
			renderStatus();
			return;
		}
		const pcm = Buffer.concat(frames);
		const wav = wrapPcmAsWav(pcm, SAMPLE_RATE);
		inFlightStt += 1;
		renderStatus();
		sttChain = sttChain
			.then(async () => {
				if (!active) return;
				try {
					const text = await transcribeWav(wav, DEFAULT_STT_MODEL, lang);
					if (active && text && activeCtx) appendToEditor(activeCtx, text);
				} catch (error) {
					if (active && activeCtx?.hasUI) {
						const msg = error instanceof Error ? error.message : String(error);
						activeCtx.ui.notify(`STT error: ${msg}`, "warning");
					}
				} finally {
					inFlightStt = Math.max(0, inFlightStt - 1);
					renderStatus();
				}
			})
			.catch(() => {
				inFlightStt = Math.max(0, inFlightStt - 1);
				renderStatus();
			});
	};

	const onPcmFrame = (frame: Buffer) => {
		if (!active || muted) return;
		const rms = pcmRms(frame);
		// Hysteresis: a higher threshold starts an utterance, a lower one keeps it open across soft consonants.
		// While the assistant's own audio is playing out of the speakers, raise the gate so room echo is ignored
		// unless the user speaks firmly over it to barge in.
		const baseThreshold = utteranceFrames.length > 0 ? RMS_SPEECH_HOLD : RMS_SPEECH_START;
		const threshold = playingNow ? RMS_SPEECH_START * 4.5 : baseThreshold;
		const speaking = rms >= threshold;

		if (speaking) {
			if (utteranceFrames.length === 0 && preRoll.length > 0) {
				utteranceFrames.push(preRoll);
			}
			utteranceFrames.push(Buffer.from(frame));
			voicedFrames += 1;
			silentFrames = 0;
			if (playingNow && voicedFrames >= BARGE_IN_FRAMES) {
				stopSpeech();
			}
			if (utteranceFrames.length >= MAX_UTTERANCE_FRAMES) {
				flushUtterance();
			} else if (voicedFrames === 1) {
				renderStatus();
			}
		} else if (utteranceFrames.length > 0) {
			utteranceFrames.push(Buffer.from(frame));
			silentFrames += 1;
			if (silentFrames >= SILENCE_HOLD_FRAMES) {
				flushUtterance();
			}
		} else {
			preRoll = Buffer.from(frame);
		}
	};

	const startMic = () => {
		if (mic || !active || muted) return;
		if (!hasCommand("arecord")) {
			if (activeCtx?.hasUI) activeCtx.ui.notify("arecord not found (install alsa-utils)", "error");
			return;
		}
		pcmCarry = Buffer.alloc(0);
		utteranceFrames = [];
		voicedFrames = 0;
		silentFrames = 0;
		const child = spawn("arecord", ["-q", "-D", "default", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		mic = child;
		child.stdout?.on("data", (chunk: Buffer) => {
			pcmCarry = pcmCarry.length === 0 ? chunk : Buffer.concat([pcmCarry, chunk]);
			while (pcmCarry.length >= FRAME_BYTES) {
				const frame = pcmCarry.subarray(0, FRAME_BYTES);
				pcmCarry = pcmCarry.subarray(FRAME_BYTES);
				onPcmFrame(frame);
			}
		});
		child.once("exit", () => {
			if (mic === child) mic = undefined;
		});
		child.once("error", () => {
			if (mic === child) mic = undefined;
		});
		renderStatus();
	};

	const stopMic = (flushPending: boolean) => {
		if (flushPending) flushUtterance();
		else {
			utteranceFrames = [];
			voicedFrames = 0;
			silentFrames = 0;
		}
		pcmCarry = Buffer.alloc(0);
		if (mic && !mic.killed) mic.kill("SIGTERM");
		mic = undefined;
		renderStatus();
	};

	// A hard exit skips session_shutdown, and an orphaned arecord keeps the microphone
	// open for every later session. Kill our children synchronously when the process goes.
	const killChildren = () => {
		if (mic && !mic.killed) mic.kill("SIGKILL");
		if (playback && !playback.killed) playback.kill("SIGKILL");
	};
	process.once("exit", killChildren);

	const setActive = (ctx: ExtensionContext, next: boolean) => {
		activeCtx = ctx;
		if (active === next) return;
		active = next;
		if (active) {
			muted = false;
			if (ctx.hasUI && ctx.mode === "tui") startMic();
			if (ctx.hasUI) ctx.ui.notify("Voice on — speak and press Enter to send, alt+x mutes, alt+s turns off, /voice wrap off silences the closing summary", "info");
		} else {
			stopMic(false);
			stopSpeech();
			if (ctx.hasUI) ctx.ui.notify("Voice off", "info");
		}
		renderStatus();
	};

	const toggleMute = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		if (!active) {
			setActive(ctx, true);
			return;
		}
		muted = !muted;
		if (muted) stopMic(true);
		else startMic();
		if (ctx.hasUI) ctx.ui.notify(muted ? "Mic muted" : "Mic live", "info");
		renderStatus();
	};

	const cycleLanguage = (ctx: ExtensionContext, requested?: Lang) => {
		activeCtx = ctx;
		const next: Lang = requested ?? (lang === "en" ? "sk" : "en");
		if (!LANGS[next]) return;
		lang = next;
		if (ctx.hasUI) ctx.ui.notify(`Language: ${LANGS[lang].label} (${LANGS[lang].code})`, "info");
		renderStatus();
	};

	const flushPendingSpeech = () => {
		if (utteranceFrames.length > 0) flushUtterance();
	};

	pi.registerShortcut("alt+s", {
		description: "Toggle live voice mode on or off",
		handler: (ctx) => setActive(ctx, !active),
	});

	pi.registerShortcut("alt+x", {
		description: "Mute or unmute the microphone",
		handler: (ctx) => toggleMute(ctx),
	});

	pi.registerShortcut("alt+l", {
		description: "Switch voice language between English and Slovak",
		handler: (ctx) => cycleLanguage(ctx),
	});

	pi.registerCommand("voice", {
		description: "Toggle live voice mode: /voice [on|off|mute|unmute|lang en|lang sk|wrap on|off|say <text>]",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const [verb = "", value = ""] = args.trim().toLowerCase().split(/\s+/);
			if (verb === "on") setActive(ctx, true);
			else if (verb === "off") setActive(ctx, false);
			else if (verb === "mute") {
				if (!active) setActive(ctx, true);
				if (!muted) toggleMute(ctx);
			} else if (verb === "unmute") {
				if (!active) setActive(ctx, true);
				else if (muted) toggleMute(ctx);
			} else if (verb === "lang") {
				if (value === "en" || value === "sk") cycleLanguage(ctx, value);
				else cycleLanguage(ctx);
			} else if (verb === "say") {
				const text = args.trim().slice(3).trim();
				if (!text) {
					ctx.ui.notify("Usage: /voice say <text>", "warning");
					return;
				}
				activeCtx = ctx;
				enqueueSentence(toSpeakable(text, WRAP_MAX_CHARS), "wrap");
			} else if (verb === "wrap") {
				wrapUpEnabled = value !== "off";
				if (!wrapUpEnabled) stopSpeech();
				ctx.ui.notify(`Spoken wrap-up ${wrapUpEnabled ? "on" : "off"}`, "info");
			} else {
				setActive(ctx, !active);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		renderStatus();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		activeCtx = ctx;
		if (active && ctx.mode === "tui") {
			event.systemPromptOptions.sections.voice_breadcrumbs = BREADCRUMB_PROMPT;
			if (event.messageType === "user") {
				return {
					message: {
						customType: "voice-breadcrumbs",
						content: BREADCRUMB_PROMPT,
						display: false,
					},
				};
			}
		} else {
			delete event.systemPromptOptions.sections.voice_breadcrumbs;
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		activeCtx = ctx;
		if (!active || !ctx.hasUI || ctx.mode !== "tui") return;
		return {
			entries: [
				{
					type: "custom_message" as const,
					customType: "voice-breadcrumbs-turn",
					content:
						"Voice mode reminder: before your next tool call or final answer, first write 1–2 short spoken breadcrumb sentences explaining what you just learned from the tool output and what you are doing next.",
					display: false,
				},
			],
		};
	});

	pi.on("input", async (event, ctx) => {
		activeCtx = ctx;
		if (event.source === "interactive") {
			// Enter submitted the prompt; transcribe the tail of the sentence so it is not swallowed,
			// then let it land in the editor for the next message.
			flushPendingSpeech();
			stopSpeech();
		}
		return { action: "continue" as const };
	});

	pi.on("message_start", async (event, ctx) => {
		activeCtx = ctx;
		if ((event.message as any)?.role === "assistant") {
			stream.reset();
			pendingBreadcrumbs = [];
		}
	});

	// Text is buffered while it streams and only spoken once the message is known to call tools:
	// a message with tool calls is a breadcrumb, the message without calls is the final answer the
	// console already shows. Speaking at message_end still lands before tool execution runs.
	pi.on("message_update", async (event, ctx) => {
		activeCtx = ctx;
		if (!active || !ctx.hasUI || ctx.mode !== "tui") return;
		const update = event.assistantMessageEvent;
		if (update.type === "text_delta") {
			pendingBreadcrumbs.push(...stream.push(update.delta));
		} else if (update.type === "text_end") {
			pendingBreadcrumbs.push(...stream.flush());
		}
	});

	pi.on("message_end", async (event) => {
		if (!active) return;
		const message: any = event.message;
		if (message?.role !== "assistant") return;
		pendingBreadcrumbs.push(...stream.flush());
		const speaks = hasToolCallBlocks(message.content);
		const breadcrumbs = speaks ? takeBreadcrumb(pendingBreadcrumbs) : [];
		pendingBreadcrumbs = [];
		for (const sentence of breadcrumbs) enqueueSentence(sentence);
	});

	pi.on("agent_settled", async (event, ctx) => {
		activeCtx = ctx;
		pendingBreadcrumbs = [];
		stream.reset();
		if (event.aborted) {
			stopSpeech();
			return;
		}
		if (!active || !ctx.hasUI || ctx.mode !== "tui") return;
		if (!wrapUpEnabled) return;
		await speakWrapUp(ctx);
	});

	pi.on("session_shutdown", async () => {
		active = false;
		stopMic(false);
		stopSpeech();
		if (workDir) rmSync(workDir, { recursive: true, force: true });
		workDir = undefined;
	});
}
