import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AudioCapture } from "../core/session";

// Captures audio with ffmpeg as 16-bit mono PCM, in 100 ms frames. With a file
// it streams at real-time speed (-re), which makes live mode testable without
// speaking.

export interface AudioOptions {
  /** Stream this file instead of the microphone. */
  file?: string;
  /** Microphone device; macOS avfoundation name or index, Linux PulseAudio source. */
  device?: string;
  sampleRate: number;
  /** Use one input channel (1-based) instead of mixing them all, e.g. the mic input of an audio interface. */
  channel?: number;
  /** "auto" picks the native helper for the default macOS mic; "ffmpeg" forces ffmpeg (for comparisons). */
  backend?: "auto" | "ffmpeg";
}

export function microphoneInput(device?: string): string[] {
  switch (process.platform) {
    case "darwin":
      return ["-fflags", "nobuffer", "-f", "avfoundation", "-i", `:${device ?? "default"}`];
    case "linux":
      return ["-fflags", "nobuffer", "-f", "pulse", "-i", device ?? "default"];
    case "win32":
      if (!device) throw new Error('On Windows pass --device "<microphone name>" (see ffmpeg -list_devices true -f dshow -i dummy)');
      return ["-f", "dshow", "-i", `audio=${device}`];
    default:
      throw new Error(`Microphone capture isn't set up for ${process.platform}; use --audio <file>`);
  }
}

const HELPER_SOURCE = fileURLToPath(new URL("../../native/mic-capture.swift", import.meta.url));
const HELPER_BINARY = fileURLToPath(new URL("../../.build/mic-capture", import.meta.url));

/**
 * The macOS microphone helper (native/mic-capture.swift), compiled on first use.
 * ffmpeg's avfoundation input loses ~6% of the audio, so a live session would fall
 * further behind the longer it runs. Returns undefined if it can't be built.
 */
export function macMicrophoneHelper(): string | undefined {
  if (existsSync(HELPER_BINARY) && statSync(HELPER_BINARY).mtimeMs >= statSync(HELPER_SOURCE).mtimeMs) return HELPER_BINARY;
  process.stderr.write("Building the microphone helper (first run only)…\n");
  mkdirSync(fileURLToPath(new URL("../../.build/", import.meta.url)), { recursive: true });
  const build = spawnSync("swiftc", ["-O", "-o", HELPER_BINARY, HELPER_SOURCE], { encoding: "utf8" });
  if (build.status === 0) return HELPER_BINARY;
  process.stderr.write(`Couldn't build it (${(build.stderr || build.error?.message || "").trim().split("\n")[0]}); using ffmpeg.\n`);
  return undefined;
}

function captureCommand(options: AudioOptions): [string, string[]] {
  const native = process.platform === "darwin" && !options.file && !options.device && options.backend !== "ffmpeg";
  const helper = native ? macMicrophoneHelper() : undefined;
  if (helper) return [helper, [String(options.sampleRate), String(options.channel ?? 0)]];
  const input = options.file ? ["-re", "-i", options.file] : microphoneInput(options.device);
  return [
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-nostdin", ...input]
      .concat(options.channel ? ["-af", `pan=mono|c0=c${options.channel - 1}`] : ["-ac", "1"])
      .concat(["-ar", String(options.sampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"]),
  ];
}

export function captureAudio(options: AudioOptions, onFrame: (frame: Buffer) => void): AudioCapture {
  const [command, args] = captureCommand(options);
  const ffmpeg = spawn(
    command,
    args,
    // Its own process group: Ctrl+C goes to shchn alone, which then stops ffmpeg in order.
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  const killOnExit = () => ffmpeg.kill("SIGKILL");
  process.once("exit", killOnExit);

  const frameBytes = (options.sampleRate * 2) / 10;
  let buffer = Buffer.alloc(0);
  ffmpeg.stdout.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= frameBytes) {
      onFrame(buffer.subarray(0, frameBytes));
      buffer = buffer.subarray(frameBytes);
    }
  });
  let stderr = "";
  ffmpeg.stderr.on("data", (data: Buffer) => (stderr += data.toString()));

  let stopped = false;
  const done = new Promise<void>((resolve, reject) => {
    ffmpeg.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new Error(`${command} not found${command === "ffmpeg" ? "; install it (macOS: brew install ffmpeg)" : ""}`) : error),
    );
    ffmpeg.on("close", (code) => {
      process.off("exit", killOnExit);
      if (buffer.length > 0) onFrame(buffer);
      if (code === 0 || stopped) resolve();
      else reject(new Error(`audio capture exited with code ${code}: ${stderr.trim() || "no details"}`));
    });
  });

  return {
    stop() {
      stopped = true;
      ffmpeg.kill("SIGINT");
    },
    done,
  };
}
