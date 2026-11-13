// Measures whether microphone audio arrives at real-time speed.
//
//   npm run debug:capture -- [--seconds 30] [--channel 1] [--device <name>] [--ffmpeg]
//
// Reports audio received vs. wall-clock time every 5 s. A ratio below 1.0 means
// audio is lost or arrives late, so a live session falls further behind the
// longer it runs. This is how ffmpeg's macOS capture was caught at ~0.94x (and
// a 192 kHz interface at 0.24x). --ffmpeg forces the ffmpeg path to compare it
// with the native helper. No speaking needed; free.

import { parseArgs } from "node:util";
import "./lib/cli"; // quiet EPIPE when piped
import { captureAudio } from "../src/cli/audio";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "30" },
    channel: { type: "string" },
    device: { type: "string" },
    ffmpeg: { type: "boolean", default: false },
  },
});

const seconds = Number(values.seconds);
let first: number | undefined;
let bytes = 0;
let zeros = true;

const row = () => {
  if (first === undefined) return "no audio yet (microphone access? device busy?)";
  const wall = (Date.now() - first) / 1000;
  const audio = bytes / 32_000; // 16 kHz, 16-bit mono
  return `wall ${wall.toFixed(1).padStart(5)} s   audio ${audio.toFixed(1).padStart(5)} s   ratio ${(audio / wall).toFixed(3)}   behind ${(wall - audio).toFixed(2)} s`;
};

console.log(`capturing ${seconds} s via ${values.ffmpeg ? "ffmpeg" : "the default backend"} (no need to speak)…`);
const capture = captureAudio(
  {
    sampleRate: 16_000,
    channel: values.channel ? Number(values.channel) : undefined,
    device: values.device,
    backend: values.ffmpeg ? "ffmpeg" : "auto",
  },
  (frame) => {
    first ??= Date.now();
    bytes += frame.length;
    if (zeros) for (let i = 0; i + 1 < frame.length; i += 2) if (frame.readInt16LE(i) !== 0) zeros = false;
  },
);
const timer = setInterval(() => console.log(row()), 5000);
setTimeout(() => {
  clearInterval(timer);
  console.log(row());
  if (first !== undefined && zeros) console.log("note: only exact zeros arrived; the microphone is blocked or muted");
  capture.stop();
}, seconds * 1000 + 300);
await capture.done;
process.exit(0);
