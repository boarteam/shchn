import Anthropic from "@anthropic-ai/sdk";
import { createSttProvider } from "../core/input/stt";
import { ModelStore } from "../core/model/store";
import { parseModelYaml, toYaml } from "../core/model/yaml";
import { describeBatch, snippet, summarize } from "../core/report";
import { type LiveInput, type Reporter, type SessionInput, describeError, runSession } from "../core/session";
import { MicrophoneAudio, RecordingAudio } from "./audioSources";
import type { FromWorker, LiveRequest, StartRequest, ToWorker } from "./protocol";

// Runs one session off the page's main thread. Chrome slows timers in a hidden
// tab to once a second or less; a dedicated worker's timers keep their pace, so
// batching and the review pass keep working while you look at another window.
// Microphone frames come straight from the audio worklet through a port, so they
// don't wait for the page either. The page starts a new worker for each session.

interface WorkerScope {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const post = (message: FromWorker) => scope.postMessage(message);
const KEY_HINT = "Check the Anthropic API key in Settings.";

let stop: AbortController | undefined;
let microphone: MicrophoneAudio | undefined;

scope.onmessage = ({ data }) => {
  switch (data.type) {
    case "start":
      if (!stop) void run(data);
      return;
    case "stop":
      stop?.abort();
      return;
    case "resume":
      microphone?.supply(data.frames);
      return;
    case "microphone-lost":
      if (!microphone) return;
      post({ type: "warn", message: "the microphone was disconnected; finishing what was said" });
      microphone.lost();
      return;
  }
};

function liveInput(request: LiveRequest): LiveInput {
  const name = request.stt === "deepgram" ? "Deepgram" : "Soniox";
  const stt = createSttProvider(request.stt, request.sttKey, `Check the ${name} key and the languages in Settings, and the network.`);
  const common = { type: "live" as const, stt, languages: request.languages, terms: request.terms };
  const { audio } = request;
  if (audio.kind === "recording") {
    return { ...common, audio: new RecordingAudio(`the recording ${audio.name}`, new Uint8Array(audio.pcm)), pauseAfterSeconds: 0 };
  }
  const source = new MicrophoneAudio(audio.label, audio.frames, () => post({ type: "microphone-off" }));
  microphone = source;
  return {
    ...common,
    audio: source,
    pauseAfterSeconds: request.pauseAfterSeconds,
    // Start was the go-ahead; after a pause for silence, wait for Resume.
    waitForSpeaker(reason, signal) {
      if (reason === "start") return Promise.resolve(!signal.aborted);
      post({ type: "paused", seconds: request.pauseAfterSeconds });
      return source.waitForPort(signal);
    },
  };
}

async function run(request: StartRequest): Promise<void> {
  stop = new AbortController();
  const store = request.resumeYaml ? ModelStore.fromView(parseModelYaml(request.resumeYaml)) : new ModelStore();
  const input: SessionInput = request.input.type === "live" ? liveInput(request.input) : request.input;

  // Edits stream in one by one; send the model once per burst.
  let scheduled = false;
  const publish = () => {
    scheduled = false;
    post({ type: "model", yaml: toYaml(store.view()), stats: store.stats() });
  };
  publish();

  const reporter: Reporter = {
    changes: (lines, fromReview) => post({ type: "changes", lines, fromReview }),
    batchStart: (batch) =>
      post({
        type: "status",
        text: batch.kind === "review" ? "reviewing the whole transcript…" : `extracting: ${snippet(batch.text)}`,
      }),
    batchEnd: (batch) => post({ type: "batch", text: describeBatch(batch) }),
    heard: (text) => post({ type: "heard", text }),
    info: (message) => post({ type: "info", message }),
    warn: (message) => post({ type: "warn", message }),
  };

  try {
    const result = await runSession({
      input,
      store,
      // A worker isn't detected as a browser, but the flag also sends the header that allows direct calls.
      client: new Anthropic({ apiKey: request.apiKey, dangerouslyAllowBrowser: true }),
      claude: request.claude,
      review: request.review,
      reporter,
      onModelChange() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(publish, 0);
      },
      signal: stop.signal,
      hints: { auth: KEY_HINT },
    });
    publish();
    post({
      type: "done",
      summary: summarize(result.batches, store, request.claude),
      transcript: input.type === "live" ? result.transcript : undefined,
    });
  } catch (error) {
    publish();
    post({ type: "failed", message: describeError(error, KEY_HINT) });
  }
}
