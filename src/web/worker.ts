import Anthropic from "@anthropic-ai/sdk";
import { ModelStore } from "../core/model/store";
import { parseModelYaml, toYaml } from "../core/model/yaml";
import { describeBatch, snippet, summarize } from "../core/report";
import { type Reporter, describeError, runSession } from "../core/session";
import type { FromWorker, StartRequest, ToWorker } from "./protocol";

// Runs one session off the page's main thread. Chrome slows timers in a hidden
// tab to once a second or less; a dedicated worker's timers keep their pace, so
// batching and the review pass keep working while you look at another window.
// The page starts a new worker for each session.

interface WorkerScope {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const post = (message: FromWorker) => scope.postMessage(message);
const KEY_HINT = "Check the Anthropic API key in Settings.";

let stop: AbortController | undefined;

scope.onmessage = ({ data }) => {
  if (data.type === "stop") stop?.abort();
  else if (data.type === "start" && !stop) void run(data);
};

async function run(request: StartRequest): Promise<void> {
  stop = new AbortController();
  const store = request.resumeYaml ? ModelStore.fromView(parseModelYaml(request.resumeYaml)) : new ModelStore();

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
      input: request.input,
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
    post({ type: "done", summary: summarize(result.batches, store, request.claude) });
  } catch (error) {
    publish();
    post({ type: "failed", message: describeError(error, KEY_HINT) });
  }
}
