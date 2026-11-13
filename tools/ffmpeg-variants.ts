// Tries several ffmpeg capture settings on the default macOS input and reports
// how close each gets to real time.
//
//   npm run debug:ffmpeg-variants -- [--seconds 10]
//
// Every variant measured ~0.93-0.94x on a Scarlett 2i2 at 48 kHz, including
// capture with no resampling at all, which is why live mode reads the mic
// through native/mic-capture.swift instead. Rerun it after an ffmpeg upgrade:
// if a variant reaches 1.00x, ffmpeg could be used again. macOS only; free.

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import "./lib/cli"; // quiet EPIPE when piped

const { values } = parseArgs({ options: { seconds: { type: "string", default: "10" } } });
const seconds = Number(values.seconds);

const to16k = ["-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"];
const variants: Array<{ name: string; args: string[]; bytesPerSecond: number }> = [
  { name: "as live mode used it (nobuffer, pan, resample)", args: ["-fflags", "nobuffer", "-f", "avfoundation", "-i", ":default", "-af", "pan=mono|c0=c0", "-ar", "16000", "-f", "s16le", "pipe:1"], bytesPerSecond: 32_000 },
  { name: "without -fflags nobuffer", args: ["-f", "avfoundation", "-i", ":default", ...to16k], bytesPerSecond: 32_000 },
  { name: "larger thread queue", args: ["-thread_queue_size", "4096", "-f", "avfoundation", "-i", ":default", ...to16k], bytesPerSecond: 32_000 },
  { name: "native rate, no resampling", args: ["-f", "avfoundation", "-i", ":default", "-ac", "1", "-f", "s16le", "pipe:1"], bytesPerSecond: 96_000 },
  { name: "wall-clock timestamps", args: ["-use_wallclock_as_timestamps", "1", "-f", "avfoundation", "-i", ":default", ...to16k], bytesPerSecond: 32_000 },
];

if (process.platform !== "darwin") {
  console.log("This compares macOS (avfoundation) capture settings; nothing to do on this system.");
  process.exit(0);
}

for (const variant of variants) {
  await new Promise<void>((resolve) => {
    const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...variant.args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let first: number | undefined;
    let last = 0;
    let bytes = 0;
    ffmpeg.stdout.on("data", (data: Buffer) => {
      first ??= Date.now();
      last = Date.now();
      bytes += data.length;
    });
    setTimeout(() => ffmpeg.kill("SIGINT"), seconds * 1000);
    // ffmpeg waiting for microphone access ignores SIGINT.
    const force = setTimeout(() => ffmpeg.kill("SIGKILL"), seconds * 1000 + 3000);
    ffmpeg.on("close", () => {
      clearTimeout(force);
      const wall = first === undefined ? 0 : (last - first) / 1000;
      const audio = bytes / variant.bytesPerSecond;
      const ratio = wall > 0 ? (audio / wall).toFixed(3) : "no audio";
      console.log(`${variant.name.padEnd(48)} ratio ${ratio}  (${audio.toFixed(1)} s in ${wall.toFixed(1)} s)`);
      resolve();
    });
  });
}
process.exit(0);
