import type { BatchRecord } from "./engine/engine";
import type { ClaudeConfig } from "./extract/claude";
import { type TokenUsage, estimateCostUsd } from "./extract/models";
import type { ModelStore } from "./model/store";

// Plain-text descriptions of a session's progress and its end summary, the same
// in the terminal and in the browser.

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function snippet(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line per finished call: "#3 1.2 s · 2 edits · 0.9 s after speech · "…"". */
export function describeBatch(batch: BatchRecord): string {
  const edits = batch.ops.filter((o) => o.result.status === "applied").length;
  const time = batch.stats ? seconds(batch.stats.totalMs) : "failed";
  const label = batch.kind === "review" ? "review" : `#${batch.id}`;
  const latency = batch.latencyMs !== undefined ? ` · ${seconds(batch.latencyMs)} after speech` : "";
  const text = batch.kind === "extract" ? ` · "${snippet(batch.text)}"` : "";
  return `${label} ${time} · ${edits} edit${edits === 1 ? "" : "s"}${latency}${text}`;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

function thousands(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * The end-of-session summary: calls and edits, the model's size, how quickly
 * speech turned into model updates, tokens and approximate cost.
 * `destination` names where the model was saved, if anywhere.
 */
export function summarize(
  batches: readonly BatchRecord[],
  store: ModelStore,
  claude: ClaudeConfig,
  destination?: string,
): string[] {
  const extract = batches.filter((b) => b.kind === "extract");
  const reviews = batches.filter((b) => b.kind === "review");
  const failed = batches.filter((b) => b.error !== undefined).length;
  const ops = batches.flatMap((b) => b.ops);
  const applied = ops.filter((o) => o.result.status === "applied").length;
  const skipped = ops.filter((o) => o.result.status === "rejected").length;
  const stats = store.stats();
  const lines = [
    `${extract.length} extraction calls, ${reviews.length} reviews${failed ? `, ${failed} failed` : ""}; ` +
      `${applied} edits applied${skipped ? `, ${skipped} skipped` : ""}`,
    `model: ${stats.entities} entities, ${stats.properties} properties, ${stats.relations} relations` +
      (destination ? ` → ${destination}` : ""),
  ];

  // Calls that changed the model: from the end of the last words they carried to the update.
  const latencies = extract.flatMap((b) =>
    b.latencyMs !== undefined && b.ops.some((o) => o.result.status === "applied") ? [b.latencyMs] : [],
  );
  if (latencies.length > 0) {
    lines.push(
      `end of speech → model updated: median ${seconds(percentile(latencies, 0.5))}, ` +
        `slowest 10% ${seconds(percentile(latencies, 0.9))} (${latencies.length} updates)`,
    );
  }
  const callMs = extract.flatMap((b) => (b.stats ? [b.stats.totalMs] : []));
  const firstOpMs = extract.flatMap((b) => (b.stats?.firstOpMs !== undefined ? [b.stats.firstOpMs] : []));
  if (callMs.length > 0) {
    const firstEdit = firstOpMs.length > 0 ? `, first edit after ${seconds(percentile(firstOpMs, 0.5))}` : "";
    lines.push(`extraction call: median ${seconds(percentile(callMs, 0.5))}${firstEdit}`);
  }

  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const b of batches) {
    if (!b.stats) continue;
    usage.input += b.stats.usage.input;
    usage.output += b.stats.usage.output;
    usage.cacheRead += b.stats.usage.cacheRead;
    usage.cacheWrite += b.stats.usage.cacheWrite;
  }
  const cost = estimateCostUsd(claude.model, usage, claude.fast);
  lines.push(
    `tokens: ${thousands(usage.input + usage.cacheRead + usage.cacheWrite)} in (${thousands(usage.cacheRead)} cached), ` +
      `${thousands(usage.output)} out${cost !== undefined ? ` · about $${cost.toFixed(2)}` : ""}`,
  );
  return lines;
}
