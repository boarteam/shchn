// Reads a session's edit log (model.ops.jsonl) and prints a call-by-call timeline.
//
//   npm run debug:session -- [model.ops.jsonl] [--session last|all|<n>] [--edits]
//
// One line per Claude call: when it was sent, how long it took, how long after
// the speaker's last words the model updated, how many edits it made, and the
// text it carried. Use it to see where the time goes, which calls were wasted on
// fragments, and what each phrase did to the model. A log can hold several
// sessions (it's appended to); --session picks one. Free: reads a local file.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { estimateCostUsd } from "../src/extract/models";
import { percentile } from "./lib/audioStats";
import { fail } from "./lib/cli";

interface BatchLine {
  type: "batch";
  id: number;
  kind: "extract" | "review";
  text: string;
  sent_at: string;
  latency_ms?: number;
  error?: string;
  stats?: { model: string; totalMs: number; firstOpMs?: number; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } };
}
interface EditLine {
  type: "edit";
  batch: number;
  status: "applied" | "noop" | "rejected";
  changes?: string[];
  reason?: string;
}
type Line = BatchLine | EditLine;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { session: { type: "string", default: "last" }, edits: { type: "boolean", default: false } },
});
const path = positionals[0] ?? "model.ops.jsonl";
let lines: Line[];
try {
  lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
} catch (error) {
  fail(`can't read ${path}: ${(error as Error).message}`);
}

// Each session's first call is extraction #1 (reviews finish out of order, so ids
// alone don't mark a boundary). Edits are logged before their batch.
const sessions: Array<Array<{ batch: BatchLine; edits: EditLine[] }>> = [];
let current: Array<{ batch: BatchLine; edits: EditLine[] }> = [];
let pendingEdits: EditLine[] = [];
for (const line of lines) {
  if (line.type === "edit") {
    pendingEdits.push(line);
    continue;
  }
  if (line.kind === "extract" && line.id === 1 && current.length > 0) {
    sessions.push(current);
    current = [];
  }
  current.push({ batch: line, edits: pendingEdits.filter((e) => e.batch === line.id) });
  pendingEdits = pendingEdits.filter((e) => e.batch !== line.id);
}
if (current.length > 0) sessions.push(current);
if (sessions.length === 0) fail(`no calls in ${path}`);

const picked =
  values.session === "all"
    ? sessions
    : values.session === "last"
      ? [sessions[sessions.length - 1]!]
      : [sessions[Number(values.session) - 1] ?? fail(`there are ${sessions.length} sessions in ${path}`)];

for (const session of picked) {
  const index = sessions.indexOf(session) + 1;
  console.log(`\nsession ${index} of ${sessions.length}`);
  for (const { batch, edits } of session) {
    const applied = edits.filter((e) => e.status === "applied");
    const time = new Date(batch.sent_at).toLocaleTimeString();
    const call = batch.stats ? `${(batch.stats.totalMs / 1000).toFixed(1)} s` : `ERR ${batch.error ?? ""}`;
    const latency = batch.latency_ms !== undefined ? ` · ${(batch.latency_ms / 1000).toFixed(1)} s after speech` : "";
    const label = batch.kind === "review" ? "review" : `#${batch.id}`;
    console.log(`${time} ${label.padEnd(6)} ${call.padStart(6)}${latency} · ${applied.length} edits · ${JSON.stringify(batch.text.trim()).slice(0, 80)}`);
    if (values.edits) {
      for (const e of edits.filter((x) => x.status !== "noop")) {
        console.log(`        ${e.status === "rejected" ? `skipped (${e.reason})` : (e.changes ?? []).join("; ")}`);
      }
    }
  }

  const extract = session.filter((s) => s.batch.kind === "extract");
  const latencies = extract
    .filter((s) => s.edits.some((e) => e.status === "applied") && s.batch.latency_ms !== undefined)
    .map((s) => s.batch.latency_ms! / 1000);
  const calls = extract.flatMap((s) => (s.batch.stats ? [s.batch.stats.totalMs / 1000] : []));
  const empty = extract.filter((s) => !s.edits.some((e) => e.status === "applied")).length;
  console.log(`\n${extract.length} calls (${empty} changed nothing), ${session.length - extract.length} reviews`);
  if (latencies.length) {
    console.log(`end of speech → model updated: median ${percentile(latencies, 0.5).toFixed(1)} s, slowest 10% ${percentile(latencies, 0.9).toFixed(1)} s`);
  }
  if (calls.length) console.log(`call time: median ${percentile(calls, 0.5).toFixed(1)} s`);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let model = "";
  for (const { batch } of session) {
    if (!batch.stats) continue;
    model = batch.stats.model;
    for (const k of Object.keys(usage) as Array<keyof typeof usage>) usage[k] += batch.stats.usage[k];
  }
  const cost = estimateCostUsd(model, usage, false);
  console.log(`tokens: ${usage.input + usage.cacheRead + usage.cacheWrite} in, ${usage.output} out${cost !== undefined ? ` · about $${cost.toFixed(2)}` : ""}`);
}
