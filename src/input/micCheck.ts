import { spawn } from "node:child_process";
import { microphoneInput } from "./audio";
import { WavWriter } from "../output/wav";

// `shchn mic`: records a few seconds while you speak and reports what arrives:
// the input format ffmpeg sees, whether audio arrives at real-time speed, and
// the level of each input channel. Saves the recording for a closer look.

const SAMPLE_RATE = 16_000;
const SPEECH_DB = -40; // a voice close to a working mic peaks well above this
const CLIP_DB = -1;

function decibels(value: number): number {
  return value > 0 ? 20 * Math.log10(value / 32768) : -96;
}

function meter(db: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(((db + 60) / 60) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

interface Recording {
  /** Interleaved 16 kHz, 16-bit, two channels. */
  audio: Buffer;
  /** Wall-clock time between the first and last audio arriving. */
  wallSeconds: number;
  inputFormat?: string;
}

/** Records for `seconds` of wall-clock time, so a wrong-speed input shows up as a mismatch. */
function record(device: string | undefined, seconds: number): Promise<Recording> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "info", "-nostdin", ...microphoneInput(device)].concat(
        ["-ac", "2", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"],
      ),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    let firstAt: number | undefined;
    let lastAt = 0;
    ffmpeg.stdout.on("data", (data: Buffer) => {
      firstAt ??= Date.now();
      lastAt = Date.now();
      chunks.push(data);
    });
    ffmpeg.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    const stop = setTimeout(() => ffmpeg.kill("SIGINT"), seconds * 1000);
    const giveUp = setTimeout(() => ffmpeg.kill("SIGKILL"), (seconds + 6) * 1000);
    ffmpeg.on("error", reject);
    ffmpeg.on("close", () => {
      clearTimeout(stop);
      clearTimeout(giveUp);
      const audio = Buffer.concat(chunks);
      if (audio.length === 0 || firstAt === undefined) {
        reject(new Error("No audio arrived. Check microphone access for this terminal's app."));
        return;
      }
      const inputFormat = /Stream #0:0[^:]*: Audio: (.+)/.exec(stderr)?.[1]?.trim();
      resolve({ audio, wallSeconds: (lastAt - firstAt) / 1000, inputFormat });
    });
  });
}

function channelStats(audio: Buffer, channel: number): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  let count = 0;
  for (let i = channel * 2; i + 1 < audio.length; i += 4) {
    const v = audio.readInt16LE(i);
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
    count++;
  }
  return { peak: decibels(peak), rms: decibels(Math.sqrt(sum / Math.max(count, 1))) };
}

function saveChannel(audio: Buffer, channel: number, path: string): void {
  const mono = Buffer.alloc(audio.length / 2);
  for (let i = channel * 2, o = 0; i + 1 < audio.length; i += 4, o += 2) mono.writeInt16LE(audio.readInt16LE(i), o);
  const wav = new WavWriter(path, SAMPLE_RATE);
  wav.write(mono);
  wav.close();
}

export async function micCheck(device: string | undefined, seconds = 8): Promise<number> {
  const name = device ? `input "${device}"` : "the default input";
  if (process.stdin.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    await prompt.question(`Press Enter, then count aloud from 1 to 10 at a normal pace (${name}, ${seconds} s). `);
    prompt.close();
  }
  process.stdout.write(`Recording ${seconds} s. Count now…\n`);
  const { audio, wallSeconds, inputFormat } = await record(device, seconds);
  const audioSeconds = audio.length / (SAMPLE_RATE * 2 * 2);
  const channels = [0, 1].map((c) => channelStats(audio, c));

  process.stdout.write(`  input format: ${inputFormat ?? "unknown"}\n`);
  process.stdout.write(`  received ${audioSeconds.toFixed(1)} s of audio in ${wallSeconds.toFixed(1)} s\n`);
  channels.forEach(({ peak, rms }, i) => {
    process.stdout.write(
      `  channel ${i + 1}  peak ${peak.toFixed(0).padStart(4)} dBFS   level ${rms.toFixed(0).padStart(4)} dBFS   ${meter(peak)}\n`,
    );
  });
  const loudest = channels[0] && channels[1] && channels[1].peak > channels[0].peak ? 1 : 0;
  const saved = "out/mic-check.wav";
  saveChannel(audio, loudest, saved);
  process.stdout.write(`  channel ${loudest + 1} saved to ${saved}\n`);

  const speed = audioSeconds / Math.max(wallSeconds, 0.1);
  const voiced = channels.map((c, i) => ({ ...c, n: i + 1 })).filter((c) => c.peak > SPEECH_DB);
  let advice: string;
  if (speed < 0.85 || speed > 1.15) {
    advice =
      `Audio arrives at ${speed.toFixed(2)}x real time, so speech is distorted. Set the input to 48 kHz ` +
      "(Audio MIDI Setup → your interface → Format) and run this check again.";
  } else if (voiced.length === 0) {
    advice =
      `Too quiet: nothing peaked above ${SPEECH_DB} dBFS. Turn up the gain on your mic's input ` +
      "(on the Scarlett: until the gain ring glows green when you speak), or pick another --device.";
  } else if (voiced.some((c) => c.peak > CLIP_DB)) {
    advice = "Clipping: your voice hits the maximum level. Turn the gain down a little.";
  } else if (voiced.length === 1) {
    advice = `Your voice is only on channel ${voiced[0]?.n}. Use: ./shchn live --view --channel ${voiced[0]?.n}`;
  } else {
    advice = "Speed and levels look fine: ./shchn live --view";
  }
  process.stdout.write(`${advice}\n`);
  return 0;
}
