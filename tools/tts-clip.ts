// Makes a spoken test clip from a transcript with macOS text-to-speech.
//
//   npm run debug:tts -- examples/tracker.ru.txt [--paragraphs 2] [--voice Milena]
//                        [--out out/clip.aiff] [--left-only]
//
// Lets you test live mode end to end without speaking:
//   ./shchn live --audio out/clip.aiff
// --left-only also writes a stereo copy with speech only on the left channel,
// like a mic on input 1 of an audio interface, for testing --channel.
// Voices: `say -v '?'` (Milena and Yuri speak Russian). macOS only; free.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { describeAudio, fail } from "./lib/cli";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    paragraphs: { type: "string", default: "2" },
    voice: { type: "string", default: "Milena" },
    out: { type: "string", default: "out/clip.aiff" },
    "left-only": { type: "boolean", default: false },
  },
});
if (process.platform !== "darwin") fail("tts-clip uses macOS `say`; on other systems record a clip instead.");
const transcript = positionals[0] ?? fail("usage: npm run debug:tts -- <transcript.txt> [--paragraphs 2] [--voice Milena]");

const text = readFileSync(transcript, "utf8")
  .split(/\n\s*\n/)
  .map((p) => p.trim())
  .filter(Boolean)
  .slice(0, Number(values.paragraphs))
  .join("\n\n");
mkdirSync(dirname(values.out), { recursive: true });
const textFile = `${values.out}.txt`;
writeFileSync(textFile, text);
const say = spawnSync("say", ["-v", values.voice, "-f", textFile, "-o", values.out], { encoding: "utf8" });
if (say.status !== 0) fail(`say failed: ${say.stderr}`);
console.log(`${values.out}: ${describeAudio(values.out)} (text in ${textFile})`);

if (values["left-only"]) {
  const stereo = values.out.replace(/\.\w+$/, "") + ".left-only.wav";
  const ffmpeg = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", values.out, "-af", "pan=stereo|c0=c0|c1=0*c0", stereo],
    { encoding: "utf8" },
  );
  if (ffmpeg.status !== 0) fail(`ffmpeg failed: ${ffmpeg.stderr}`);
  console.log(`${stereo}: ${describeAudio(stereo)} (speech on channel 1 only; try --channel 1)`);
}
