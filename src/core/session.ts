import Anthropic from "@anthropic-ai/sdk";
import { type BatchRecord, Engine, type EngineOptions } from "./engine/engine";
import { type ClaudeConfig, ClaudeOpsSource, type OpsSource } from "./extract/claude";
import type { Effort } from "./extract/models";
import type { InputKind } from "./extract/prompt";
import { AudioClock } from "./input/audioClock";
import { PauseDetector } from "./input/pauses";
import { replay } from "./input/replay";
import type { SttProvider } from "./input/stt/types";
import type { ModelStore } from "./model/store";
import { unref } from "./timers";

// One session, the same on every platform: text or audio in, edits out, the
// model kept up to date. The platform (the CLI, later the web app) supplies what
// differs: where text and audio come from, the Claude client and the
// speech-to-text key, where the model and the edit log are kept, how progress is
// shown, and how the speaker starts and stops.

/** 16 kHz: the rate audio sources deliver and speech-to-text receives. */
export const SAMPLE_RATE = 16_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // 16-bit mono

const CODE_EXTENSIONS = new Set(
  ".ts .tsx .js .jsx .mjs .py .java .kt .go .rs .rb .cs .php .sql .prisma .graphql .gql .proto .swift .scala .ex .c .cpp .h .hpp .dart .json .yaml .yml .xml".split(
    " ",
  ),
);

/** How a session shows its progress. */
export interface Reporter {
  /** Applied edits, one line each ("+ Order.total"). */
  changes(lines: string[], fromReview: boolean): void;
  batchStart(batch: BatchRecord): void;
  batchEnd(batch: BatchRecord): void;
  /** The latest recognized speech. */
  heard(text: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface ReviewSettings {
  enabled: boolean;
  /** Seconds between review passes during live input. */
  everySeconds: number;
  effort: Effort;
}

export interface AudioCapture {
  stop(): void;
  /** Resolves when capture ends (end of a recording, or stop()). */
  done: Promise<void>;
}

export type AudioProblem = "no-audio" | "silent" | "slow";

/** A microphone or a recording, delivering 16-bit mono PCM. */
export interface AudioSource {
  /** Shown as "listening to <description>". */
  readonly description: string;
  /** A live microphone, which is checked for audio arriving slower than real time. */
  readonly microphone: boolean;
  /** Starts capturing at `sampleRate`, in frames of about 100 ms. */
  start(sampleRate: number, onFrame: (frame: Uint8Array) => void): AudioCapture;
  /** What to tell the user about a problem; `speed` is audio received per second of real time. */
  advice(problem: AudioProblem, speed: number): string;
}

export interface LiveInput {
  type: "live";
  audio: AudioSource;
  stt: SttProvider;
  /** Language hints, e.g. ["ru", "en"]. */
  languages: string[];
  /** Vocabulary hints. Entity names already in the model are added. */
  terms: string[];
  /**
   * Waits for the speaker before listening ("start"), and after the microphone
   * was turned off for silence ("resume"). Resolves false if the session is
   * stopped first. Without it, listening starts at once and never pauses.
   */
  waitForSpeaker?(reason: "start" | "resume", signal: AbortSignal): Promise<boolean>;
  /** Turn the microphone off after this many seconds without speech (needs waitForSpeaker); 0 = never. */
  pauseAfterSeconds: number;
}

export type SessionInput =
  /** Requirements or code, all at once. `name` is a file name: it picks code or document handling. */
  | { type: "documents"; files: Array<{ name: string; text: string }> }
  /** Text as it arrives, e.g. from another transcriber. */
  | { type: "stream"; chunks: AsyncIterable<string> }
  /** A transcript played at speaking speed, to simulate a live session. */
  | { type: "replay"; text: string; wordsPerMinute: number }
  | LiveInput;

export interface SessionOptions {
  input: SessionInput;
  /** The model to update: empty, or loaded to resume an earlier session. */
  store: ModelStore;
  /** Configured with a key by the platform. */
  client: Anthropic;
  claude: ClaudeConfig;
  /** Makes the extraction calls instead of Claude: a fake in tests, or an experiment. */
  source?: OpsSource;
  review: ReviewSettings;
  reporter: Reporter;
  /** The model changed. Comes once per applied edit, so coalesce saves. */
  onModelChange?(): void;
  /** One record of the edit log, one per edit and one per call (the `.ops.jsonl` format). */
  onLogRecord?(record: Record<string, unknown>): void;
  /** Stops the input. What was already said is still processed before the session ends. */
  signal: AbortSignal;
  /** Platform wording: how to stop ("Ctrl+C to stop"), and what to do about rejected Claude credentials. */
  hints?: { stop?: string; auth?: string };
}

export interface SessionResult {
  /** All text sent for extraction; for live and stream input, the transcript. */
  transcript: string;
  batches: readonly BatchRecord[];
}

/** Errors that will repeat on every call: stop instead of retrying forever. */
export function isFatal(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.RateLimitError) return false;
  if (error instanceof Anthropic.APIError) return error.status === undefined || error.status < 500;
  return true;
}

/** A message for the user; `authHint` says how to fix missing or rejected Claude credentials. */
export function describeError(error: unknown, authHint?: string): string {
  const hint = authHint ? ` ${authHint}` : "";
  if (error instanceof Anthropic.AuthenticationError) return `Claude API authentication failed.${hint}`;
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication method/i.test(message)) return `No Claude API credentials.${hint}`;
  return message;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function inputKind(input: SessionInput): InputKind {
  if (input.type !== "documents") return "speech";
  return input.files.every((f) => CODE_EXTENSIONS.has(extension(f.name))) ? "code" : "document";
}

function engineOptions(kind: InputKind, review: ReviewSettings): EngineOptions {
  const live = kind === "speech";
  return {
    kind,
    maxBatchChars: live ? 1500 : 6000,
    contextChars: 1500,
    idleFlushMs: live ? 1500 : 0,
    review: {
      enabled: review.enabled,
      everyMs: review.everySeconds * 1000,
      effort: review.effort,
      maxChars: 60_000,
    },
  };
}

/** True when a frame is exact zeros: what a blocked or muted input delivers. */
function isDigitalSilence(frame: Uint8Array): boolean {
  for (let i = 0; i + 1 < frame.length; i += 2) if (frame[i] !== 0 || frame[i + 1] !== 0) return false;
  return true;
}

/**
 * Runs a session to the end: until the input ends or `signal` stops it, and
 * every call it led to has finished. Rejects on an error that would repeat on
 * every call (a bad key, a lost microphone); edits applied so far stay in `store`.
 */
export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const { input, store, reporter, signal } = options;
  const hints = options.hints ?? {};
  const stopHint = hints.stop ? `; ${hints.stop}` : "";
  const log = (record: Record<string, unknown>) => options.onLogRecord?.(record);

  let failFatal: (error: unknown) => void = () => {};
  const fatal = new Promise<never>((_, reject) => (failFatal = reject));
  fatal.catch(() => {});

  const claudeSource = () => {
    const claude = new ClaudeOpsSource(options.client, options.claude, (m) => reporter.warn(m));
    for (const warning of claude.warnings) reporter.warn(warning);
    return claude;
  };
  const source = options.source ?? claudeSource();
  let fallbackNoted = false;

  const engine = new Engine(store, source, engineOptions(inputKind(input), options.review), {
    batchStart: (batch) => reporter.batchStart(batch),
    op(applied) {
      const { result } = applied;
      if (result.status === "applied") {
        reporter.changes(result.changes, applied.kind === "review");
        options.onModelChange?.();
      } else if (result.status === "rejected") {
        reporter.warn(`skipped ${applied.op.op}: ${result.reason}`);
      }
      log({ type: "edit", at: new Date(applied.at).toISOString(), batch: applied.batch, ...result, op: applied.op });
    },
    batchEnd(batch) {
      reporter.batchEnd(batch);
      const stats = batch.stats;
      if (stats?.stopReason === "refusal") reporter.warn(`call #${batch.id} was declined (refusal); some edits may be missing`);
      if (stats?.stopReason === "max_tokens") reporter.warn(`call #${batch.id} hit max_tokens; some edits may be missing`);
      if (stats && stats.model !== options.claude.model && !fallbackNoted) {
        fallbackNoted = true;
        reporter.warn(`a call was served by the fallback model ${stats.model}`);
      }
      log({
        type: "batch",
        id: batch.id,
        kind: batch.kind,
        text: batch.text,
        sent_at: new Date(batch.sentAt).toISOString(),
        latency_ms: batch.latencyMs,
        stats: batch.stats,
        error: batch.error === undefined ? undefined : describeError(batch.error, hints.auth),
      });
    },
    error(error, batch) {
      if (isFatal(error)) failFatal(error);
      else reporter.warn(`call #${batch.id} failed: ${describeError(error, hints.auth)}`);
    },
  });

  // What's been "heard" so far, for display.
  let heard = "";
  const hear = (text: string) => {
    heard = (heard + text).slice(-500);
    reporter.heard(heard.slice(-100));
  };

  async function listen(live: LiveInput): Promise<void> {
    const { audio, waitForSpeaker } = live;
    // With someone at the microphone, start only when they're ready.
    if (waitForSpeaker && !(await waitForSpeaker("start", signal))) return;
    const clock = new AudioClock();
    let partial = "";
    // When speech was last recognized, for the auto-pause safety catch.
    let lastSpeechAt = Date.now();
    // Names already in a resumed model help recognition of the same words.
    const terms = [...new Set([...live.terms, ...store.view().entities.map((e) => e.name)])];
    const stt = await live.stt.connect(
      { sampleRate: SAMPLE_RATE, languages: live.languages, terms },
      {
        partial(text) {
          partial = text;
          if (text.trim()) lastSpeechAt = Date.now();
          reporter.heard(`${heard.slice(-80)}${partial}`);
        },
        final(text, endMs) {
          if (text.trim()) lastSpeechAt = Date.now();
          hear(text);
          engine.push(text, (endMs !== undefined ? clock.wallTime(endMs) : undefined) ?? Date.now());
        },
        endpoint: () => engine.pause(),
        // Once stopping, a complaint like "No audio received" shouldn't hide the summary.
        error: (error) => (signal.aborted ? reporter.warn(error.message) : failFatal(error)),
      },
    );
    reporter.info(`listening to ${audio.description} via ${live.stt.name} (${live.languages.join(", ")})${stopHint}`);
    // At each short pause, ask speech-to-text to confirm what it heard instead of
    // holding it back for seconds.
    const pauses = new PauseDetector(SAMPLE_RATE, () => stt.finalize());
    let frames = 0;
    let audibleFrames = 0;
    let audioMs = 0;
    const stopped = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const pauseAfterMs = live.pauseAfterSeconds * 1000;
    let firstCapture = true;

    // One pass per stretch of listening; a long silence ends it and waits for the speaker.
    for (;;) {
      clock.restart();
      const capture = audio.start(SAMPLE_RATE, (frame) => {
        const frameMs = frame.length / BYTES_PER_MS;
        clock.frame(frameMs);
        frames++;
        audioMs += frameMs;
        if (!isDigitalSilence(frame)) audibleFrames++;
        stt.sendAudio(frame);
        pauses.push(frame);
      });
      fatal.catch(() => capture.stop());
      let audioCheck: ReturnType<typeof setTimeout> | undefined;
      if (firstCapture) {
        // A microphone the OS won't open sends nothing, or exact zeros, without any error.
        const captureStarted = Date.now();
        audioCheck = setTimeout(() => {
          const speed = audioMs / (Date.now() - captureStarted);
          if (frames === 0) reporter.warn(audio.advice("no-audio", speed));
          else if (audibleFrames === 0) reporter.warn(audio.advice("silent", speed));
          else if (audio.microphone && speed < 0.85) reporter.warn(audio.advice("slow", speed));
        }, 5000);
        unref(audioCheck);
        firstCapture = false;
      }
      // Safety catch: nobody has spoken for a while, maybe the speaker left.
      lastSpeechAt = Date.now();
      let silenceTimer: ReturnType<typeof setInterval> | undefined;
      const silence = new Promise<"silence">((resolve) => {
        if (!waitForSpeaker || pauseAfterMs <= 0) return;
        silenceTimer = setInterval(() => {
          if (Date.now() - lastSpeechAt >= pauseAfterMs) resolve("silence");
        }, 500);
      });
      let outcome: "silence" | "ended";
      try {
        outcome = await Promise.race([capture.done.then(() => "ended" as const), stopped.then(() => "ended" as const), silence]);
      } finally {
        clearTimeout(audioCheck);
        clearInterval(silenceTimer);
        capture.stop();
      }
      if (outcome === "ended") break;

      // Paused: the microphone is off and nothing is sent. Finish what was said first.
      stt.finalize();
      engine.flush();
      if (!waitForSpeaker || !(await waitForSpeaker("resume", signal))) break;
      reporter.info(`listening again via ${live.stt.name}${stopHint}`);
    }
    await stt.finish();
  }

  async function feed(): Promise<void> {
    switch (input.type) {
      case "documents": {
        const { files } = input;
        const text =
          files.length === 1 ? (files[0]?.text ?? "") : files.map((f) => `=== ${f.name} ===\n${f.text}`).join("\n\n");
        engine.push(text);
        return;
      }
      case "stream": {
        try {
          for await (const chunk of input.chunks) {
            hear(chunk);
            engine.push(chunk, Date.now());
          }
        } catch (error) {
          if (!signal.aborted) throw error; // a platform may end the stream on stop by destroying it
        }
        return;
      }
      case "replay": {
        const sink = {
          push(word: string, spokenAt?: number) {
            hear(word);
            engine.push(word, spokenAt);
          },
          flush: () => engine.flush(),
        };
        await replay(input.text, sink, { wordsPerMinute: input.wordsPerMinute, signal });
        return;
      }
      case "live":
        return listen(input);
    }
  }

  await Promise.race([feed(), fatal]);
  await Promise.race([engine.drain(), fatal]);
  return { transcript: engine.transcript, batches: engine.batches };
}
