// Streams an audio file to speech-to-text in real time and logs when text comes back.
//
//   npm run debug:stt -- <audio file> [--stt soniox|deepgram] [--lang ru,en] [--channel 1]
//                         [--no-finalize] [--partials]
//
// For each confirmed ("final") piece of text it prints how long after the words
// were spoken it arrived. This found the ~4.7 s Soniox holds text back during
// continuous speech, and confirmed that finalizing at short pauses (what live
// mode does; --no-finalize turns it off) brings it to ~0.2 s.
// Costs speech-to-text time only (Soniox: $0.12/hour of audio). No Claude calls.

import { parseArgs } from "node:util";
import { captureAudio } from "../src/cli/audio";
import { sttProviderFromEnv } from "../src/cli/keys";
import { AudioClock } from "../src/core/input/audioClock";
import { PauseDetector } from "../src/core/input/pauses";
import type { SttName } from "../src/core/input/stt";
import { fail, loadEnv } from "./lib/cli";
import { percentile } from "./lib/audioStats";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    stt: { type: "string", default: "soniox" },
    lang: { type: "string", default: "ru,en" },
    channel: { type: "string" },
    finalize: { type: "boolean", default: true },
    partials: { type: "boolean", default: false },
  },
});
const file =
  positionals[0] ?? fail("usage: npm run debug:stt -- <audio file> [--stt soniox|deepgram] [--no-finalize] [--partials]");
if (values.stt !== "soniox" && values.stt !== "deepgram") fail("--stt must be soniox or deepgram");
loadEnv();

const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(2).padStart(6)}s`;
const clock = new AudioClock();
const lags: number[] = [];
let lastPartial = "";

const stt = await sttProviderFromEnv(values.stt as SttName).connect(
  { sampleRate: 16_000, languages: values.lang.split(","), terms: [] },
  {
    partial(text) {
      if (values.partials && text && text !== lastPartial) console.log(`${at()} partial   ${JSON.stringify(text.slice(-50))}`);
      lastPartial = text;
    },
    final(text, endMs) {
      const spokenAt = endMs !== undefined ? clock.wallTime(endMs) : undefined;
      const lag = spokenAt !== undefined ? (Date.now() - spokenAt) / 1000 : undefined;
      if (lag !== undefined) lags.push(lag);
      console.log(`${at()} FINAL     lag ${lag?.toFixed(2) ?? "?"} s   ${JSON.stringify(text)}`);
    },
    endpoint: () => console.log(`${at()} ENDPOINT`),
    error: (error) => console.log(`${at()} ERROR     ${error.message}`),
  },
);

const pauses = new PauseDetector(16_000, () => {
  console.log(`${at()} pause → finalize`);
  stt.finalize();
});
const capture = captureAudio(
  { file, sampleRate: 16_000, channel: values.channel ? Number(values.channel) : undefined },
  (frame) => {
    clock.frame(frame.length / 32);
    stt.sendAudio(frame);
    if (values.finalize) pauses.push(frame);
  },
);
await capture.done;
console.log(`${at()} audio ended`);
await stt.finish();

if (lags.length > 0) {
  console.log(
    `\nfinal text arrived after the words were spoken: median ${percentile(lags, 0.5).toFixed(2)} s, ` +
      `slowest ${Math.max(...lags).toFixed(2)} s (${lags.length} pieces)`,
  );
}
process.exit(0);
