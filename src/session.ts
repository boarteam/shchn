import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { type BatchRecord, Engine, type EngineOptions } from "./engine/engine";
import { formatScore, scoreModel } from "./eval/score";
import { type ClaudeConfig, ClaudeOpsSource } from "./extract/claude";
import { type Effort, type TokenUsage, estimateCostUsd } from "./extract/models";
import type { InputKind } from "./extract/prompt";
import { captureAudio } from "./input/audio";
import { AudioClock } from "./input/audioClock";
import { PauseDetector } from "./input/pauses";
import { replay } from "./input/replay";
import { createSttProvider } from "./input/stt";
import { ModelStore } from "./model/store";
import { parseModelYaml, toYaml } from "./model/yaml";
import { CoalescedWriter, JsonlLog, writeAtomic } from "./output/files";
import { TerminalView } from "./output/view";
import { WavWriter } from "./output/wav";

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
  review: { enabled: boolean; everySeconds: number; effort: Effort };
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

const SAMPLE_RATE = 16_000;
const CODE_EXTENSIONS = new Set(
  ".ts .tsx .js .jsx .mjs .py .java .kt .go .rs .rb .cs .php .sql .prisma .graphql .gql .proto .swift .scala .ex .c .cpp .h .hpp .dart .json .yaml .yml .xml".split(
    " ",
  ),
);

// ---------------------------------------------------------------- reporting

const paint = (code: number) => (text: string) => (process.stderr.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function snippet(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeBatch(batch: BatchRecord): string {
  const edits = batch.ops.filter((o) => o.result.status === "applied").length;
  const time = batch.stats ? seconds(batch.stats.totalMs) : "failed";
  const label = batch.kind === "review" ? "review" : `#${batch.id}`;
  const latency = batch.latencyMs !== undefined ? ` · ${seconds(batch.latencyMs)} after speech` : "";
  const text = batch.kind === "extract" ? ` · "${snippet(batch.text)}"` : "";
  return `${label} ${time} · ${edits} edit${edits === 1 ? "" : "s"}${latency}${text}`;
}

interface Reporter {
  changes(lines: string[], fromReview: boolean): void;
  batchStart(batch: BatchRecord): void;
  batchEnd(batch: BatchRecord): void;
  heard(text: string): void;
  info(message: string): void;
  warn(message: string): void;
  close(): void;
}

function logReporter(): Reporter {
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

function viewReporter(view: TerminalView): Reporter {
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

// ---------------------------------------------------------------- summary

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

function thousands(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function summarize(engine: Engine, store: ModelStore, config: SessionConfig): string[] {
  const extract = engine.batches.filter((b) => b.kind === "extract");
  const reviews = engine.batches.filter((b) => b.kind === "review");
  const failed = engine.batches.filter((b) => b.error !== undefined).length;
  const ops = engine.batches.flatMap((b) => b.ops);
  const applied = ops.filter((o) => o.result.status === "applied").length;
  const skipped = ops.filter((o) => o.result.status === "rejected").length;
  const stats = store.stats();
  const lines = [
    `${extract.length} extraction calls, ${reviews.length} reviews${failed ? `, ${failed} failed` : ""}; ` +
      `${applied} edits applied${skipped ? `, ${skipped} skipped` : ""}`,
    `model: ${stats.entities} entities, ${stats.properties} properties, ${stats.relations} relations → ${config.out}`,
  ];

  // Calls that changed the model: from the end of the last words they carried to the update.
  const latencies = extract.flatMap((b) =>
    b.latencyMs !== undefined && b.ops.some((o) => o.result.status === "applied") ? [b.latencyMs] : [],
  );
  if (latencies.length > 0) {
    lines.push(
      `end of speech → model updated: median ${seconds(percentile(latencies, 0.5))}, ` +
        `slowest 10% ${seconds(percentile(latencies, 0.9))} (${latencies.length} updates)`,
    );
  }
  const callMs = extract.flatMap((b) => (b.stats ? [b.stats.totalMs] : []));
  const firstOpMs = extract.flatMap((b) => (b.stats?.firstOpMs !== undefined ? [b.stats.firstOpMs] : []));
  if (callMs.length > 0) {
    const firstEdit = firstOpMs.length > 0 ? `, first edit after ${seconds(percentile(firstOpMs, 0.5))}` : "";
    lines.push(`extraction call: median ${seconds(percentile(callMs, 0.5))}${firstEdit}`);
  }

  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const b of engine.batches) {
    if (!b.stats) continue;
    usage.input += b.stats.usage.input;
    usage.output += b.stats.usage.output;
    usage.cacheRead += b.stats.usage.cacheRead;
    usage.cacheWrite += b.stats.usage.cacheWrite;
  }
  const cost = estimateCostUsd(config.claude.model, usage, config.claude.fast);
  lines.push(
    `tokens: ${thousands(usage.input + usage.cacheRead + usage.cacheWrite)} in (${thousands(usage.cacheRead)} cached), ` +
      `${thousands(usage.output)} out${cost !== undefined ? ` · about $${cost.toFixed(2)}` : ""}`,
  );
  return lines;
}

// ---------------------------------------------------------------- session

function engineOptions(kind: InputKind, config: SessionConfig): EngineOptions {
  const live = kind === "speech";
  return {
    kind,
    maxBatchChars: live ? 1500 : 6000,
    contextChars: 1500,
    idleFlushMs: live ? 1500 : 0,
    review: {
      enabled: config.review.enabled,
      everyMs: config.review.everySeconds * 1000,
      effort: config.review.effort,
      maxChars: 60_000,
    },
  };
}

const NO_AUDIO_HINT =
  "No audio from the microphone after 4 s. On macOS, the app running this terminal needs microphone access: " +
  "System Settings → Privacy & Security → Microphone (for this app's terminal, that's Claude Code). " +
  "Or run shchn from Terminal or iTerm.";
const SILENT_AUDIO_HINT =
  "The microphone sends only silence. Check it isn't muted, pick another input with --device, " +
  "and check this terminal's app has microphone access (System Settings → Privacy & Security → Microphone).";

function slowAudioHint(speed: number): string {
  return (
    `Audio arrives at ${speed.toFixed(2)}x real time, so speech is distorted and recognition fails. ` +
    "Set your input to 48 kHz (Audio MIDI Setup → your interface → Format), then restart."
  );
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

/** True when a frame is exact zeros: what a blocked or muted input delivers. */
function isDigitalSilence(frame: Buffer): boolean {
  for (let i = 0; i + 1 < frame.length; i += 2) if (frame.readInt16LE(i) !== 0) return false;
  return true;
}

/** Errors that will repeat on every call: stop instead of retrying forever. */
function isFatal(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.RateLimitError) return false;
  if (error instanceof Anthropic.APIError) return error.status === undefined || error.status < 500;
  return true;
}

function errorMessage(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Claude API authentication failed. Set ANTHROPIC_API_KEY in .env (see .env.example).";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication method/i.test(message)) {
    return "No Claude API credentials. Set ANTHROPIC_API_KEY in .env (see .env.example).";
  }
  return message;
}

function sideFile(out: string, suffix: string): string {
  return out.replace(/\.ya?ml$/i, "") + suffix;
}

function loadModel(path: string): ModelStore {
  try {
    return ModelStore.fromView(parseModelYaml(readFileSync(path, "utf8")));
  } catch {
    return new ModelStore(); // nothing to resume from
  }
}

export async function runSession(config: SessionConfig): Promise<number> {
  const store = config.resume ? loadModel(config.out) : new ModelStore();

  const kind: InputKind =
    config.command === "file"
      ? config.inputs.every((p) => CODE_EXTENSIONS.has(extname(p).toLowerCase()))
        ? "code"
        : "document"
      : "speech";

  const writer = new CoalescedWriter(config.out, () => toYaml(store.view()));
  writer.flush();
  const log = new JsonlLog(config.log);

  const view = config.view && process.stdout.isTTY ? new TerminalView(process.stdout, header, () => toYaml(store.view())) : undefined;
  const reporter = view ? viewReporter(view) : logReporter();
  function header(): string {
    const s = store.stats();
    return `shchn · ${config.command} · ${config.claude.model} (effort ${config.claude.effort}) · ${s.entities} entities · ${s.properties} properties · ${s.relations} relations`;
  }

  let failFatal: (error: unknown) => void = () => {};
  const fatal = new Promise<never>((_, reject) => (failFatal = reject));
  fatal.catch(() => {});

  const source = new ClaudeOpsSource(new Anthropic(), config.claude, (m) => reporter.warn(m));
  for (const warning of source.warnings) reporter.warn(warning);
  let fallbackNoted = false;

  const engine = new Engine(store, source, engineOptions(kind, config), {
    batchStart: (batch) => reporter.batchStart(batch),
    op(applied) {
      const { result } = applied;
      if (result.status === "applied") {
        reporter.changes(result.changes, applied.kind === "review");
        writer.schedule();
        view?.schedule();
      } else if (result.status === "rejected") {
        reporter.warn(`skipped ${applied.op.op}: ${result.reason}`);
      }
      log.append({ type: "edit", at: new Date(applied.at).toISOString(), batch: applied.batch, ...result, op: applied.op });
    },
    batchEnd(batch) {
      reporter.batchEnd(batch);
      const stats = batch.stats;
      if (stats?.stopReason === "refusal") reporter.warn(`call #${batch.id} was declined (refusal); some edits may be missing`);
      if (stats?.stopReason === "max_tokens") reporter.warn(`call #${batch.id} hit max_tokens; some edits may be missing`);
      if (stats && stats.model !== config.claude.model && !fallbackNoted) {
        fallbackNoted = true;
        reporter.warn(`a call was served by the fallback model ${stats.model}`);
      }
      log.append({
        type: "batch",
        id: batch.id,
        kind: batch.kind,
        text: batch.text,
        sent_at: new Date(batch.sentAt).toISOString(),
        latency_ms: batch.latencyMs,
        stats: batch.stats,
        error: batch.error === undefined ? undefined : errorMessage(batch.error),
      });
    },
    error(error, batch) {
      if (isFatal(error)) failFatal(error);
      else reporter.warn(`call #${batch.id} failed: ${errorMessage(error)}`);
    },
  });

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

  // What's been "heard" so far, for the view.
  let heard = "";
  const hear = (text: string) => {
    heard = (heard + text).slice(-500);
    reporter.heard(heard.slice(-100));
  };

  async function feed(): Promise<void> {
    switch (config.command) {
      case "file": {
        const files = config.inputs.map((path) => ({ path, text: readFileSync(path, "utf8") }));
        const text =
          files.length === 1
            ? (files[0]?.text ?? "")
            : files.map((f) => `=== ${basename(f.path)} ===\n${f.text}`).join("\n\n");
        engine.push(text);
        return;
      }
      case "stdin": {
        process.stdin.setEncoding("utf8");
        stop.signal.addEventListener("abort", () => process.stdin.destroy(), { once: true });
        try {
          for await (const chunk of process.stdin) {
            hear(chunk as string);
            engine.push(chunk as string, Date.now());
          }
        } catch (error) {
          if (!stop.signal.aborted) throw error; // closing stdin on Ctrl+C ends the loop this way
        }
        return;
      }
      case "replay": {
        const text = readFileSync(config.inputs[0] ?? "", "utf8");
        const sink = {
          push(word: string, spokenAt?: number) {
            hear(word);
            engine.push(word, spokenAt);
          },
          flush: () => engine.flush(),
        };
        await replay(text, sink, { wordsPerMinute: config.wordsPerMinute, signal: stop.signal });
        return;
      }
      case "live": {
        const provider = createSttProvider(config.stt);
        const microphone = !config.audio && process.stdin.isTTY;
        // With a microphone, start only when the speaker is ready.
        if (microphone && !(await waitForEnter(stop.signal, reporter, "Press Enter to start listening (Ctrl+C to quit)"))) return;
        const clock = new AudioClock();
        let partial = "";
        // When speech was last recognized, for the auto-pause safety catch.
        let lastSpeechAt = Date.now();
        // Names already in a resumed model help recognition of the same words.
        const terms = [...new Set([...config.terms, ...store.view().entities.map((e) => e.name)])];
        const stt = await provider.connect(
          { sampleRate: SAMPLE_RATE, languages: config.languages, terms },
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
            error: (error) => (stop.signal.aborted ? reporter.warn(error.message) : failFatal(error)),
          },
        );
        const source = config.audio ? `file ${config.audio}` : "the microphone";
        reporter.info(`listening to ${source} via ${provider.name} (${config.languages.join(", ")}); Ctrl+C to stop`);
        // At each short pause, ask speech-to-text to confirm what it heard instead of
        // holding it back for seconds.
        const pauses = new PauseDetector(SAMPLE_RATE, () => stt.finalize());
        let frames = 0;
        let audibleFrames = 0;
        const recording = config.saveAudio ? new WavWriter(sideFile(config.out, ".audio.wav"), SAMPLE_RATE) : undefined;
        const stopped = new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
        const pauseAfterMs = config.pauseAfterSeconds * 1000;
        let firstCapture = true;

        try {
          // One pass per stretch of listening; a long silence ends it and waits for Enter.
          for (;;) {
            clock.restart();
            const capture = captureAudio(
              { file: config.audio, device: config.device, channel: config.channel, sampleRate: SAMPLE_RATE },
              (frame) => {
                clock.frame(frame.length / 32); // 32 bytes per ms of 16 kHz, 16-bit mono audio
                frames++;
                if (!isDigitalSilence(frame)) audibleFrames++;
                stt.sendAudio(frame);
                pauses.push(frame);
                recording?.write(frame);
              },
            );
            fatal.catch(() => capture.stop());
            let audioCheck: ReturnType<typeof setTimeout> | undefined;
            if (firstCapture) {
              // A microphone the OS won't open sends nothing, or exact zeros, without any error.
              const captureStarted = Date.now();
              audioCheck = setTimeout(() => {
                const speed = (frames * 100) / (Date.now() - captureStarted); // a frame is 100 ms
                if (frames === 0) reporter.warn(NO_AUDIO_HINT);
                else if (audibleFrames === 0) reporter.warn(SILENT_AUDIO_HINT);
                else if (!config.audio && speed < 0.85) reporter.warn(slowAudioHint(speed));
              }, 5000);
              audioCheck.unref?.();
              firstCapture = false;
            }
            // Safety catch: nobody has spoken for a while, maybe the speaker left.
            lastSpeechAt = Date.now();
            let silenceTimer: ReturnType<typeof setInterval> | undefined;
            const silence = new Promise<"silence">((resolve) => {
              if (!microphone || pauseAfterMs <= 0) return;
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
            const seconds = Math.round(pauseAfterMs / 1000);
            if (!(await waitForEnter(stop.signal, reporter, `Paused: no speech for ${seconds} s, microphone off. Press Enter to continue (Ctrl+C to stop)`))) break;
            reporter.info(`listening again via ${provider.name}; Ctrl+C to stop`);
          }
        } finally {
          if (recording) {
            recording.close();
            reporter.info(`audio saved to ${recording.path}`);
          }
        }
        await stt.finish();
        return;
      }
    }
  }

  try {
    view?.clear();
    view?.render();
    await Promise.race([feed(), fatal]);
    await Promise.race([engine.drain(), fatal]);
  } catch (error) {
    writer.flush();
    reporter.close();
    process.stderr.write(`${red(`error: ${errorMessage(error)}`)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onInterrupt);
  }

  writer.flush();
  reporter.close();
  if (config.command === "live" || config.command === "stdin") {
    const transcriptPath = sideFile(config.out, ".transcript.txt");
    writeAtomic(transcriptPath, engine.transcript);
    process.stderr.write(dim(`transcript saved to ${transcriptPath}; replay it with: ./shchn replay ${transcriptPath}`) + "\n");
  }
  process.stderr.write(`\n${summarize(engine, store, config).join("\n")}\n`);
  if (config.expect) {
    const score = scoreModel(store.view(), parseModelYaml(readFileSync(config.expect, "utf8")));
    process.stderr.write(`\nscore against ${config.expect}:\n${formatScore(score)}\n`);
  }
  return 0;
}

export function sideLogPath(out: string): string {
  return sideFile(out, ".ops.jsonl");
}
