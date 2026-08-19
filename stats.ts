// Per-response latency and tokens/s footer stats.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEY = "stats";

export default function (pi: ExtensionAPI): void {
  let startMs = 0;

  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "assistant") startMs = performance.now();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || startMs === 0) return;
    const elapsed = (performance.now() - startMs) / 1000;
    startMs = 0;
    if (elapsed <= 0) return;
    const out = (event.message as { usage?: { output?: number } }).usage?.output ?? 0;
    const line = out > 0
      ? `${elapsed.toFixed(1)}s · ${(out / elapsed).toFixed(1)} tok/s`
      : `${elapsed.toFixed(1)}s`;
    ctx.ui.setStatus(KEY, line);
  });
}
