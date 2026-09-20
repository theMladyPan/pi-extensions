// Per-response latency and tokens/s footer stats.
// TTFT from enter, tok/s from first token, total from enter. Accumulates across
// all assistant messages in a turn (tool calls included).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEY = "stats";

export default function (pi: ExtensionAPI): void {
  let submitMs = 0;
  let firstTokenMs = 0;
  let outTokens = 0;

  pi.on("agent_start", () => {
    submitMs = performance.now();
    firstTokenMs = 0;
    outTokens = 0;
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant" && firstTokenMs === 0) {
      firstTokenMs = performance.now();
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || submitMs === 0) return;
    outTokens += (event.message as { usage?: { output?: number } }).usage?.output ?? 0;
    const now = performance.now();
    const ttft = firstTokenMs > 0 ? (firstTokenMs - submitMs) / 1000 : 0;
    const gen = (now - (firstTokenMs || submitMs)) / 1000;
    const total = (now - submitMs) / 1000;
    if (gen <= 0) return;
    const tps = outTokens > 0 ? ` · ${(outTokens / gen).toFixed(1)} tok/s` : "";
    ctx.ui.setStatus(KEY, `[ ${ttft.toFixed(1)}s ttft${tps} · ${total.toFixed(1)}s total ]`);
  });
}
