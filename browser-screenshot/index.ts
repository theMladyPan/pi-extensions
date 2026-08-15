import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_SCRIPT = path.join(__dirname, "runner.py");

const ActionSchema = Type.Object({
	action: StringEnum(["goto", "click", "fill", "press", "wait_for", "wait", "click_xy", "set_input_files"] as const, {
		description: "Action type to execute sequentially.",
	}),
	url: Type.Optional(Type.String({ description: "URL for goto action (wait_until: domcontentloaded)." })),
	selector: Type.Optional(Type.String({ description: "CSS selector for click, fill, press, wait_for, set_input_files." })),
	text: Type.Optional(Type.String({ description: "Text string to fill into the input element or file path for set_input_files." })),
	files: Type.Optional(Type.Array(Type.String(), { description: "File paths for set_input_files action." })),
	key: Type.Optional(Type.String({ description: "Key to press on the element (e.g. 'Enter', 'Tab')." })),
	ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000, description: "Wait duration in ms (max 5000)." })),
	x: Type.Optional(Type.Number({ description: "X coordinate for click_xy." })),
	y: Type.Optional(Type.Number({ description: "Y coordinate for click_xy." })),
});

const BrowserScreenshotParameters = Type.Object({
	actions: Type.Array(ActionSchema, {
		minItems: 1,
		maxItems: 20,
		description: "Ordered list of sequential browser actions (max 20).",
	}),
	full_page: Type.Optional(
		Type.Boolean({
			description: "Whether to capture the full scrollable page instead of fixed 1920x1080 viewport.",
		}),
	),
	include_console: Type.Optional(
		Type.Boolean({
			description: "Whether to return captured browser console logs and page errors.",
		}),
	),
	ignore_https_errors: Type.Optional(
		Type.Boolean({
			description: "Explicit opt-in to ignore HTTPS certificate errors (for local dev only). Defaults to false.",
		}),
	),
});

interface RunnerOutput {
	ok: boolean;
	output_path: string;
	failed_action_index?: number | null;
	failed_action?: string | null;
	error?: string | null;
	console_logs?: string[];
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Execute a batch of sequential browser actions in an isolated headless Chrome session and return exactly one final screenshot inline.",
		parameters: BrowserScreenshotParameters,
		async execute(_toolCallId, params, signal, onUpdate) {
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-browser-"));
			const screenshotPath = path.join(tmpDir, "screenshot.png");

			try {
				onUpdate?.({ content: [{ type: "text", text: "Starting headless browser session..." }] });

				const runnerPayload = {
					actions: params.actions,
					output_path: screenshotPath,
					full_page: Boolean(params.full_page),
					include_console: Boolean(params.include_console),
					ignore_https_errors: Boolean(params.ignore_https_errors),
					action_timeout_ms: 10000,
					overall_timeout_ms: 30000,
				};

				const runnerProcess = spawn("uv", ["run", "--with", "playwright", "python3", RUNNER_SCRIPT], {
					stdio: ["pipe", "pipe", "pipe"],
				});

				let stdoutData = "";
				let stderrData = "";
				let timedOut = false;

				runnerProcess.stdout.on("data", (chunk: Buffer) => {
					stdoutData += chunk.toString();
				});

				runnerProcess.stderr.on("data", (chunk: Buffer) => {
					stderrData += chunk.toString();
				});

				// Swallow EPIPE / stream errors if uv/python exits before stdin is drained
				runnerProcess.stdin.on("error", () => {});

				const watchdogTimer = setTimeout(() => {
					timedOut = true;
					runnerProcess.kill("SIGTERM");
					setTimeout(() => {
						if (!runnerProcess.killed) {
							runnerProcess.kill("SIGKILL");
						}
					}, 2000).unref();
				}, 35000);

				const abortHandler = () => {
					runnerProcess.kill("SIGTERM");
					setTimeout(() => {
						if (!runnerProcess.killed) {
							runnerProcess.kill("SIGKILL");
						}
					}, 2000).unref();
				};

				if (signal) {
					signal.addEventListener("abort", abortHandler, { once: true });
				}

				try {
					runnerProcess.stdin.write(JSON.stringify(runnerPayload));
					runnerProcess.stdin.end();
				} catch {
					// Catch sync write failure if process immediately exited
				}

				const exitCode = await new Promise<number | null>((resolve) => {
					runnerProcess.on("close", resolve);
					runnerProcess.on("error", () => resolve(1));
				});

				clearTimeout(watchdogTimer);

				if (signal) {
					signal.removeEventListener("abort", abortHandler);
				}

				if (timedOut) {
					throw new Error("Browser session timed out after 35 seconds (watchdog limit exceeded).");
				}

				if (signal?.aborted) {
					throw new Error("Browser session aborted.");
				}

				let parsedResult: RunnerOutput | null = null;
				try {
					parsedResult = JSON.parse(stdoutData.trim()) as RunnerOutput;
				} catch {
					// Runner crashed before emitting JSON
				}

				if (!parsedResult && exitCode !== 0) {
					throw new Error(`Browser runner failed: ${stderrData || stdoutData || "Unknown process failure"}`);
				}

				let imageBase64: string | null = null;
				try {
					const imgBuffer = await fs.readFile(screenshotPath);
					if (imgBuffer.length > 0) {
						imageBase64 = imgBuffer.toString("base64");
					}
				} catch {
					// Screenshot file may not exist if launch crashed completely
				}

				if (!imageBase64 && !parsedResult?.ok) {
					throw new Error(
						`Browser execution failed before capturing screenshot: ${parsedResult?.error || stderrData || "No screenshot generated"}`,
					);
				}

				const content: Array<
					{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
				> = [];

				if (parsedResult && !parsedResult.ok) {
					const errHeader = `Action #${parsedResult.failed_action_index} (${parsedResult.failed_action}) failed: ${parsedResult.error}`;
					content.push({ type: "text", text: errHeader });
				} else {
					content.push({ type: "text", text: "Browser actions completed successfully." });
				}

				if (params.include_console && parsedResult?.console_logs && parsedResult.console_logs.length > 0) {
					content.push({
						type: "text",
						text: `Console output:\n${parsedResult.console_logs.join("\n")}`,
					});
				}

				if (imageBase64) {
					content.push({
						type: "image",
						data: imageBase64,
						mimeType: "image/png",
					});
				}

				return {
					content,
					details: {
						ok: parsedResult?.ok ?? false,
						failed_action_index: parsedResult?.failed_action_index ?? null,
						failed_action: parsedResult?.failed_action ?? null,
						error: parsedResult?.error ?? null,
						console_logs: parsedResult?.console_logs ?? [],
					},
				};
			} finally {
				await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
			}
		},
	});
}
