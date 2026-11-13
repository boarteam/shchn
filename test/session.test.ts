import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { CallStats, OpsSource } from "../src/core/extract/claude";
import type { SttProvider } from "../src/core/input/stt/types";
import type { Op } from "../src/core/model/ops";
import { ModelStore } from "../src/core/model/store";
import { type AudioSource, type LiveInput, type Reporter, type SessionOptions, runSession } from "../src/core/session";

// The core session with every platform piece faked: Claude, the microphone and
// speech-to-text. This is the flow the CLI and the web app both run.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await sleep(5);
  }
}

/** Stands in for Claude: every call adds the entity named in `ops`. */
class FakeSource implements OpsSource {
  readonly messages: string[] = [];

  constructor(private readonly ops: Op[] = []) {}

  async run(message: string, onOp: (op: Op) => void): Promise<CallStats> {
    this.messages.push(message);
    await sleep(5);
    for (const op of this.ops) onOp(op);
    return { model: "fake", stopReason: "end_turn", totalMs: 5, ops: this.ops.length, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
}

function recordingReporter() {
  const seen = { infos: [] as string[], warnings: [] as string[], edits: [] as string[] };
  const reporter: Reporter = {
    changes: (lines) => seen.edits.push(...lines),
    batchStart() {},
    batchEnd() {},
    heard() {},
    info: (message) => seen.infos.push(message),
    warn: (message) => seen.warnings.push(message),
  };
  return { reporter, ...seen };
}

/** A test signal: 100 ms frames every 10 ms until stopped. */
function fakeAudio() {
  const state = { started: 0, stopped: 0 };
  const source: AudioSource = {
    description: "a test signal",
    microphone: false,
    start(sampleRate, onFrame) {
      state.started++;
      let timer: ReturnType<typeof setInterval>;
      let end = () => {};
      const done = new Promise<void>((resolve) => {
        timer = setInterval(() => onFrame(new Uint8Array((sampleRate * 2) / 10).fill(1)), 10);
        end = resolve;
      });
      return {
        stop() {
          state.stopped++;
          clearInterval(timer);
          end();
        },
        done,
      };
    },
    advice: (problem) => problem,
  };
  return Object.assign(state, { source });
}

/** "Recognizes" the next phrase with every 300 ms of audio; or fails on the first audio. */
function fakeStt(phrases: string[] = [], error?: Error) {
  const state = { connected: false, finished: false, terms: [] as string[] };
  const provider: SttProvider = {
    name: "fake",
    async connect(options, events) {
      state.connected = true;
      state.terms = options.terms;
      const queue = [...phrases];
      let bytes = 0;
      let failed = false;
      return {
        sendAudio(chunk) {
          if (error && !failed) {
            failed = true;
            events.error(error);
          }
          bytes += chunk.length;
          const phrase = bytes >= 9600 ? queue.shift() : undefined;
          if (phrase !== undefined) {
            bytes = 0;
            events.final(phrase);
          }
        },
        finalize() {},
        async finish() {
          state.finished = true;
        },
      };
    },
  };
  return Object.assign(state, { provider });
}

function sessionOptions(input: SessionOptions["input"], overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    input,
    store: new ModelStore(),
    client: {} as Anthropic, // unused: `source` replaces the Claude calls
    claude: { model: "fake", effort: "low", thinking: "auto", fast: false },
    review: { enabled: false, everySeconds: 45, effort: "medium" },
    source: new FakeSource(),
    reporter: recordingReporter().reporter,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function liveInput(audio: AudioSource, stt: SttProvider, overrides: Partial<LiveInput> = {}): LiveInput {
  return { type: "live", audio, stt, languages: ["en"], terms: [], pauseAfterSeconds: 0, ...overrides };
}

describe("runSession", () => {
  it("reads documents as one text with file names, and reports and logs each edit", async () => {
    const source = new FakeSource([{ op: "upsert_entity", entity: "User" }]);
    const seen = recordingReporter();
    const records: Array<Record<string, unknown>> = [];
    let modelChanges = 0;
    const store = new ModelStore();
    const files = [
      { name: "notes.md", text: "Users sign up with an email." },
      { name: "user.ts", text: "class User {}" },
    ];

    const result = await runSession(
      sessionOptions(
        { type: "documents", files },
        {
          store,
          source,
          reporter: seen.reporter,
          onModelChange: () => modelChanges++,
          onLogRecord: (record) => records.push(record),
        },
      ),
    );

    expect(source.messages).toHaveLength(1);
    expect(source.messages[0]).toContain(
      '<new kind="document">\n=== notes.md ===\nUsers sign up with an email.\n\n=== user.ts ===\nclass User {}',
    );
    expect(store.stats().entities).toBe(1);
    expect(seen.edits).toEqual(["+ User"]);
    expect(modelChanges).toBe(1);
    expect(records.map((r) => [r.type, r.status ?? r.kind])).toEqual([
      ["edit", "applied"],
      ["batch", "extract"],
    ]);
    expect(result.batches).toHaveLength(1);
  });

  it("treats a set of source files as code", async () => {
    const source = new FakeSource();
    await runSession(sessionOptions({ type: "documents", files: [{ name: "a.ts", text: "class A {}" }] }, { source }));
    expect(source.messages[0]).toContain('<new kind="code">\nclass A {}');
  });

  it("listens after the speaker is ready, sends what was recognized, and stops cleanly", async () => {
    const audio = fakeAudio();
    const stt = fakeStt(["A user has an email. "]);
    const source = new FakeSource([{ op: "upsert_entity", entity: "User" }]);
    const seen = recordingReporter();
    const asked: string[] = [];
    const stop = new AbortController();
    const store = new ModelStore();
    store.apply({ op: "upsert_entity", entity: "Order" }); // a resumed model

    const session = runSession(
      sessionOptions(
        liveInput(audio.source, stt.provider, {
          terms: ["SKU"],
          waitForSpeaker: async (reason) => {
            asked.push(reason);
            return true;
          },
        }),
        { store, source, reporter: seen.reporter, signal: stop.signal, hints: { stop: "press Stop" } },
      ),
    );
    await until(() => source.messages.length > 0);
    stop.abort();
    const result = await session;

    expect(asked).toEqual(["start"]);
    expect(stt.terms).toEqual(["SKU", "Order"]); // names in the model help recognition
    expect(seen.infos).toContain("listening to a test signal via fake (en); press Stop");
    expect(result.transcript).toBe("A user has an email.");
    expect(store.stats().entities).toBe(2);
    expect(audio.stopped).toBe(1);
    expect(stt.finished).toBe(true);
  });

  it("doesn't connect when stopped before the speaker started", async () => {
    const audio = fakeAudio();
    const stt = fakeStt();
    const result = await runSession(
      sessionOptions(liveInput(audio.source, stt.provider, { waitForSpeaker: async () => false })),
    );
    expect(stt.connected).toBe(false);
    expect(audio.started).toBe(0);
    expect(result.batches).toEqual([]);
  });

  it("turns the microphone off after silence and on again when the speaker is back", async () => {
    const audio = fakeAudio();
    const stt = fakeStt();
    const seen = recordingReporter();
    const asked: string[] = [];
    await runSession(
      sessionOptions(
        liveInput(audio.source, stt.provider, {
          pauseAfterSeconds: 0.3,
          // Comes back once, then leaves.
          waitForSpeaker: async (reason) => {
            asked.push(reason);
            return asked.length < 3;
          },
        }),
        { reporter: seen.reporter },
      ),
    );
    expect(asked).toEqual(["start", "resume", "resume"]);
    expect(audio.started).toBe(2);
    expect(audio.stopped).toBe(2);
    expect(seen.infos).toContain("listening again via fake");
    expect(stt.finished).toBe(true);
  });

  it("fails on a speech-to-text error and stops the capture", async () => {
    const audio = fakeAudio();
    const stt = fakeStt([], new Error("bad key"));
    await expect(runSession(sessionOptions(liveInput(audio.source, stt.provider)))).rejects.toThrow("bad key");
    await until(() => audio.stopped > 0);
  });
});
