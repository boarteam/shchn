import { useCallback, useEffect, useReducer, useRef } from "react";
import type { FromWorker, ModelStats, StartRequest } from "./protocol";

// The page's side of a session: starts a worker for it and turns the worker's
// messages into what the page shows. Stop works like Ctrl+C in the terminal:
// the first finishes what was already said, the second ends at once.

export type FeedKind = "add" | "remove" | "change" | "batch" | "info" | "warn";

export interface FeedEntry {
  id: number;
  at: string;
  kind: FeedKind;
  text: string;
  fromReview?: boolean;
}

export interface SessionState {
  phase: "idle" | "running" | "stopping";
  yaml: string;
  stats: ModelStats;
  feed: FeedEntry[];
  /** What the current call is doing. */
  status: string;
  /** The latest words heard. */
  heard: string;
  /** The end-of-session summary. */
  summary: string[];
  error?: string;
}

type Action = FromWorker | { type: "begin" } | { type: "stopping" } | { type: "abandoned" } | { type: "clear" };

const EMPTY_YAML = "entities: {}\n";
const FEED_LIMIT = 300;

const initialState: SessionState = {
  phase: "idle",
  yaml: EMPTY_YAML,
  stats: { entities: 0, properties: 0, relations: 0 },
  feed: [],
  status: "",
  heard: "",
  summary: [],
};

let nextId = 1;

function entries(kind: FeedKind, texts: string[], fromReview?: boolean): FeedEntry[] {
  const at = new Date().toTimeString().slice(0, 8);
  return texts.map((text) => ({ id: nextId++, at, kind, text, fromReview }));
}

function changeKind(line: string): FeedKind {
  return line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "change";
}

function withFeed(state: SessionState, added: FeedEntry[]): SessionState {
  return { ...state, feed: [...state.feed, ...added].slice(-FEED_LIMIT) };
}

function reduce(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "begin":
      return { ...state, phase: "running", status: "starting…", heard: "", summary: [], error: undefined };
    case "stopping":
      return withFeed({ ...state, phase: "stopping" }, entries("warn", ["stopping: finishing what was already said (Stop again to end now)"]));
    case "abandoned":
      return withFeed({ ...state, phase: "idle", status: "" }, entries("warn", ["stopped without waiting for the last calls"]));
    case "clear":
      return { ...initialState, feed: state.feed };
    case "model":
      return { ...state, yaml: action.yaml, stats: action.stats };
    case "changes":
      return withFeed(state, action.lines.flatMap((line) => entries(changeKind(line), [line], action.fromReview)));
    case "status":
      return { ...state, status: action.text };
    case "batch":
      return withFeed({ ...state, status: action.text }, entries("batch", [action.text]));
    case "heard":
      return { ...state, heard: action.text };
    case "info":
      return withFeed({ ...state, status: action.message }, entries("info", [action.message]));
    case "warn":
      return withFeed(state, entries("warn", [action.message]));
    case "done":
      return { ...state, phase: "idle", status: "", summary: action.summary };
    case "failed":
      return { ...state, phase: "idle", status: "", error: action.message };
  }
}

export function useSession() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const worker = useRef<Worker | undefined>(undefined);

  const end = useCallback((w: Worker) => {
    w.terminate();
    if (worker.current === w) worker.current = undefined;
  }, []);

  const start = useCallback(
    (request: StartRequest) => {
      if (worker.current) end(worker.current);
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.current = w;
      w.onmessage = ({ data }: MessageEvent<FromWorker>) => {
        dispatch(data);
        if (data.type === "done" || data.type === "failed") end(w);
      };
      w.onerror = (event) => {
        dispatch({ type: "failed", message: event.message || "The session worker failed to start." });
        end(w);
      };
      dispatch({ type: "begin" });
      w.postMessage(request);
    },
    [end],
  );

  const stop = useCallback(() => {
    const w = worker.current;
    if (!w) return;
    if (state.phase === "stopping") {
      end(w);
      dispatch({ type: "abandoned" });
    } else {
      w.postMessage({ type: "stop" });
      dispatch({ type: "stopping" });
    }
  }, [state.phase, end]);

  const clear = useCallback(() => dispatch({ type: "clear" }), []);

  useEffect(() => () => worker.current?.terminate(), []);

  return { state, start, stop, clear };
}
