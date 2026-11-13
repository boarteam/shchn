// Looks at a recording: format, levels over time, and silent gaps.
//
//   npm run debug:audio -- model.audio.wav [--window 0.5] [--thresholds 200,500,1000]
//
// Answers "is there speech in here at all?", "is it too quiet or clipping?",
// and "how long are the pauses?" (the pause detector needs ~200 ms gaps under
// RMS 200 to ask speech-to-text to finalize). Free: nothing leaves the machine.

import { parseArgs } from "node:util";
import { decodeAudio, describeAudio, fail } from "./lib/cli";
import { decibels, formatDb, levels, silentGaps } from "./lib/audioStats";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    window: { type: "string", default: "0.5" },
    thresholds: { type: "string", default: "200,500,1000" },
  },
});
const file = positionals[0] ?? fail("usage: npm run debug:audio -- <audio file> [--window 0.5] [--thresholds 200,500,1000]");

const RATE = 16_000;
const samples = decodeAudio(file, RATE);
let peak = 0;
let sum = 0;
let zeros = 0;
for (const v of samples) {
  peak = Math.max(peak, Math.abs(v));
  sum += v * v;
  if (v === 0) zeros++;
}

console.log(`${file}: ${describeAudio(file)}`);
console.log(
  `overall: peak ${formatDb(decibels(peak))} dBFS, level ${formatDb(decibels(Math.sqrt(sum / Math.max(samples.length, 1))))} dBFS, ` +
    `${Math.round((100 * zeros) / Math.max(samples.length, 1))}% exact zeros`,
);
if (zeros === samples.length) console.log("only digital silence: the input was blocked or muted");

console.log(`\nlevel per ${values.window} s (rms/peak dBFS; speech close to a mic peaks above about -40):`);
const timeline = levels(samples, RATE, Number(values.window) * 1000);
for (let i = 0; i < timeline.length; i += 8) {
  console.log(
    timeline
      .slice(i, i + 8)
      .map((l) => `${l.at.toFixed(1).padStart(5)}s ${formatDb(l.rmsDb).padStart(3)}/${formatDb(l.peakDb).padStart(3)}`)
      .join("  "),
  );
}

for (const threshold of values.thresholds.split(",").map(Number)) {
  const gaps = silentGaps(samples, RATE, threshold);
  console.log(`\ngaps of 100 ms or more below RMS ${threshold} (${gaps.length}):`);
  console.log(gaps.map((g) => `${g.at.toFixed(1)}s:${g.ms}ms`).join("  ") || "none");
}
