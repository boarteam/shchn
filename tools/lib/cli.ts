import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Small shared bits for the debugging tools in tools/.

// `npm run debug:… | head` closes the pipe early; exit quietly instead of crashing.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

/** Loads .env from the current directory, like the shchn CLI does. */
export function loadEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** Decodes any audio file ffmpeg can read into 16 kHz mono 16-bit samples. */
export function decodeAudio(path: string, sampleRate = 16_000): Int16Array {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "pipe:1"],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  if (result.status !== 0) fail(`ffmpeg couldn't read ${path}: ${result.stderr.toString().trim()}`);
  const bytes = result.stdout;
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
}

/** The stream description ffprobe reports, e.g. "pcm_s16le, 16000 Hz, 1 ch, 9.2 s". */
export function describeAudio(path: string): string {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", path],
    { encoding: "utf8" },
  );
  try {
    const info = JSON.parse(result.stdout) as {
      streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>;
      format?: { duration?: string };
    };
    const s = info.streams?.[0];
    return `${s?.codec_name}, ${s?.sample_rate} Hz, ${s?.channels} ch, ${Number(info.format?.duration).toFixed(1)} s`;
  } catch {
    return "unknown format";
  }
}
