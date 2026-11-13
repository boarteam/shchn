import { readFileSync } from "node:fs";
import { basename } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { formatScore, scoreModel } from "../core/eval/score";
import type { ClaudeConfig } from "../core/extract/claude";
import { ModelStore } from "../core/model/store";
import { parseModelYaml, toYaml } from "../core/model/yaml";
import { describeBatch, snippet, summarize } from "../core/report";
import {
  type AudioProblem,
  type AudioSource,
  type Reporter,
  type ReviewSettings,
  SAMPLE_RATE,
  type SessionInput,
  type SessionResult,
  describeError,
  runSession,
} from "../core/session";
import { captureAudio } from "./audio";
import { CoalescedWriter, JsonlLog, writeAtomic } from "./files";
import { CLAUDE_KEY_HINT, sttProviderFromEnv } from "./keys";
import { TerminalView } from "./view";
import { WavWriter } from "./wav";

// Runs one CLI command (file, stdin, replay, live) as a core session, with what
// only the terminal has: files on disk, stdin, the microphone through ffmpeg or
// the native helper, Enter to start, Ctrl+C to stop, and the terminal view.

export type Command = "file" | "stdin" | "replay" | "live";

export interface SessionConfig {
  command: Command;
  inputs: string[];
  out: string;
  log: string | null;
  view: boolean;
  /** Start from the model already in `out` instead of an empty one. */
  resume: boolean;
  claude: ClaudeConfig;
  review: ReviewSettings;
  wordsPerMinute: number;
  expect?: string;
  stt: "soniox" | "deepgram";
  languages: string[];
  terms: string[];
  audio?: string;
  device?: string;
  /** One input channel (1-based) instead of a mix of all of them. */
  channel?: number;
  /** Keep the session's audio as <out>.audio.wav. */
  saveAudio?: boolean;
  /** Pause the microphone after this long without speech, until Enter; 0 turns it off. */
  pauseAfterSeconds: number;
}

// ---------------------------------------------------------------- reporting

const paint = (code: number) => (text: string) => (process.stderr.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);

interface TerminalReporter extends Reporter {
  /** The session is over: draw the final state. */
  close(): void;
}

function logReporter(): TerminalReporter {
  const write = (line: string) => process.stderr.write(`${line}\n`);
  return {
    changes(lines, fromReview) {
      for (const line of lines) {
        const painted = line.startsWith("+") ? green(line) : line.startsWith("-") ? red(line) : line;
        write(`  ${fromReview ? dim("review ") : ""}${painted}`);
      }
    },
    batchStart() {},
    batchEnd(batch) {
      write(dim(describeBatch(batch)));
    },
    heard() {},
    info(message) {
      write(dim(message));
    },
    warn(message) {
      write(yellow(`! ${message}`));
    },
    close() {},
  };
}

function viewReporter(view: TerminalView): TerminalReporter {
  return {
    changes(lines, fromReview) {
      view.addChanges(fromReview ? lines.map((l) => `review: ${l}`) : lines);
    },
    batchStart(batch) {
      view.setStatus(batch.kind === "review" ? "reviewing the whole transcript…" : `extracting: ${snippet(batch.text)}`);
    },
    batchEnd(batch) {
      view.setStatus(describeBatch(batch));
    },
    heard(text) {
      view.setHeard(text);
    },
    info(message) {
      view.setStatus(message);
    },
    warn(message) {
      view.addChanges([`! ${message}`]);
    },
    close() {
      view.render();
    },
  };
}

// ---------------------------------------------------------------- input

const NO_AUDIO_HINT =
  "No audio from the microphone after 4 s. On macOS, the app running this terminal needs microphone access: " +
  "System Settings → Privacy & Security → Microphone (for this app's terminal, that's Claude Code). " +
  "Or run shchn from Terminal or iTerm.";
const SILENT_AUDIO_HINT =
  "The microphone sends only silence. Check it isn't muted, pick another input with --device, " +
  "and check this terminal's app has microphone access (System Settings → Privacy & Security → Microphone).";

function audioAdvice(problem: AudioProblem, speed: number): string {
  switch (problem) {
    case "no-audio":
      return NO_AUDIO_HINT;
    case "silent":
      return SILENT_AUDIO_HINT;
    case "slow":
      return (
        `Audio arrives at ${speed.toFixed(2)}x real time, so speech is distorted and recognition fails. ` +
        "Set your input to 48 kHz (Audio MIDI Setup → your interface → Format), then restart."
      );
  }
}

/** Waits for Enter. Resolves false if the session is stopped (Ctrl+C) first. */
function waitForEnter(signal: AbortSignal, reporter: Reporter, message: string): Promise<boolean> {
  reporter.info(message);
  return new Promise((resolve) => {
    const done = (started: boolean) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      signal.removeEventListener("abort", onAbort);
      resolve(started);
    };
    const onData = (chunk: Buffer | string) => {
      if (String(chunk).includes("\n") || String(chunk).includes("\r")) done(true);
    };
    const onAbort = () => done(false);
    process.stdin.on("data", onData);
    process.stdin.resume();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The microphone (or --audio file) through ffmpeg or the native helper, each frame also passed to `saveFrame`. */
function audioSource(config: SessionConfig, saveFrame?: (frame: Buffer) => void): AudioSource {
  return {
    description: config.audio ? `file ${config.audio}` : "the microphone",
    microphone: !config.audio,
    start: (sampleRate, onFrame) =>
      captureAudio({ file: config.audio, device: config.device, channel: config.channel, sampleRate }, (frame) => {
        onFrame(frame);
        saveFrame?.(frame);
      }),
    advice: audioAdvice,
  };
}

function sessionInput(
  config: SessionConfig,
  signal: AbortSignal,
  reporter: Reporter,
  saveFrame?: (frame: Buffer) => void,
): SessionInput {
  switch (config.command) {
    case "file":
      return {
        type: "documents",
        files: config.inputs.map((path) => ({ name: basename(path), text: readFileSync(path, "utf8") })),
      };
    case "stdin":
      process.stdin.setEncoding("utf8");
      signal.addEventListener("abort", () => process.stdin.destroy(), { once: true });
      return { type: "stream", chunks: process.stdin as AsyncIterable<string> };
    case "replay":
      return { type: "replay", text: readFileSync(config.inputs[0] ?? "", "utf8"), wordsPerMinute: config.wordsPerMinute };
    case "live": {
      // Someone at a microphone presses Enter to start, and again after a pause for silence.
      const microphone = !config.audio && process.stdin.isTTY;
      const seconds = Math.round(config.pauseAfterSeconds);
      return {
        type: "live",
        audio: audioSource(config, saveFrame),
        stt: sttProviderFromEnv(config.stt),
        languages: config.languages,
        terms: config.terms,
        pauseAfterSeconds: config.pauseAfterSeconds,
        waitForSpeaker: microphone
          ? (reason, stop) =>
              waitForEnter(
                stop,
                reporter,
                reason === "start"
                  ? "Press Enter to start listening (Ctrl+C to quit)"
                  : `Paused: no speech for ${seconds} s, microphone off. Press Enter to continue (Ctrl+C to stop)`,
              )
          : undefined,
      };
    }
  }
}

// ---------------------------------------------------------------- session

function sideFile(out: string, suffix: string): string {
  return out.replace(/\.ya?ml$/i, "") + suffix;
}

export function sideLogPath(out: string): string {
  return sideFile(out, ".ops.jsonl");
}

function loadModel(path: string): ModelStore {
  try {
    return ModelStore.fromView(parseModelYaml(readFileSync(path, "utf8")));
  } catch {
    return new ModelStore(); // nothing to resume from
  }
}

export async function runCommand(config: SessionConfig): Promise<number> {
  const store = config.resume ? loadModel(config.out) : new ModelStore();

  const writer = new CoalescedWriter(config.out, () => toYaml(store.view()));
  writer.flush();
  const log = new JsonlLog(config.log);

  const view = config.view && process.stdout.isTTY ? new TerminalView(process.stdout, header, () => toYaml(store.view())) : undefined;
  const reporter = view ? viewReporter(view) : logReporter();
  function header(): string {
    const s = store.stats();
    return `shchn · ${config.command} · ${config.claude.model} (effort ${config.claude.effort}) · ${s.entities} entities · ${s.properties} properties · ${s.relations} relations`;
  }

  // --save-audio: the file is created with the first frame, so a session that never got audio leaves none.
  let recording: WavWriter | undefined;
  const saveFrame = config.saveAudio
    ? (frame: Buffer) => (recording ??= new WavWriter(sideFile(config.out, ".audio.wav"), SAMPLE_RATE)).write(frame)
    : undefined;
  const finishRecording = () => {
    if (!recording) return;
    recording.close();
    reporter.info(`audio saved to ${recording.path}`);
  };

  const stop = new AbortController();
  let interrupts = 0;
  const onInterrupt = () => {
    if (++interrupts > 1) {
      writer.flush();
      process.exit(130);
    }
    reporter.warn("stopping: finishing what was already said (Ctrl+C again to quit now)");
    stop.abort();
  };
  process.on("SIGINT", onInterrupt);

  let result: SessionResult;
  try {
    view?.clear();
    view?.render();
    result = await runSession({
      input: sessionInput(config, stop.signal, reporter, saveFrame),
      store,
      client: new Anthropic(),
      claude: config.claude,
      review: config.review,
      reporter,
      onModelChange() {
        writer.schedule();
        view?.schedule();
      },
      onLogRecord: (record) => log.append(record),
      signal: stop.signal,
      hints: { stop: "Ctrl+C to stop", auth: CLAUDE_KEY_HINT },
    });
  } catch (error) {
    finishRecording();
    writer.flush();
    reporter.close();
    process.stderr.write(`${red(`error: ${describeError(error, CLAUDE_KEY_HINT)}`)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onInterrupt);
  }

  finishRecording();
  writer.flush();
  reporter.close();
  if (config.command === "live" || config.command === "stdin") {
    const transcriptPath = sideFile(config.out, ".transcript.txt");
    writeAtomic(transcriptPath, result.transcript);
    process.stderr.write(dim(`transcript saved to ${transcriptPath}; replay it with: ./shchn replay ${transcriptPath}`) + "\n");
  }
  process.stderr.write(`\n${summarize(result.batches, store, config.claude, config.out).join("\n")}\n`);
  if (config.expect) {
    const score = scoreModel(store.view(), parseModelYaml(readFileSync(config.expect, "utf8")));
    process.stderr.write(`\nscore against ${config.expect}:\n${formatScore(score)}\n`);
  }
  return 0;
}
