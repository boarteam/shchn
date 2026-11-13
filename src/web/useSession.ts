import { useCallback, useEffect, useReducer, useRef } from "react";
import { type Microphone, decodeRecording, micLevel, microphoneProblem, openMicrophone } from "./microphone";
import type { FromWorker, LiveRequest, ModelStats, StartRequest, TextInput } from "./protocol";

// The page's side of a session: starts a worker for it and turns the worker's
// messages into what the page shows. Stop works like Ctrl+C in the terminal:
// the first finishes what was already said, the second ends at once. For speech
// the page also owns the microphone (workers can't open one): it opens it at
// Start and on Resume, and closes it whenever the worker stops listening.

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
  /** Seconds of silence after which the microphone was turned off; set while paused. */
  paused?: number;
  /** The end-of-session summary. */
  summary: string[];
  /** What was heard in the last speech session. */
  transcript: string;
  error?: string;
}

/** What to start: like a StartRequest, but the page still has to open the microphone or decode the recording. */
export type SessionSpec = Omit<StartRequest, "type" | "input"> & {
  input:
    | TextInput
    | (Omit<LiveRequest, "audio"> & {
        audio: { kind: "microphone"; deviceId: string } | { kind: "recording"; file: File };
      });
};

type Action =
  | FromWorker
  | { type: "begin" }
  | { type: "stopping" }
  | { type: "abandoned" }
  | { type: "cancelled" }
  | { type: "resumed" }
  | { type: "clear" };

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
  transcript: "",
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
      return { ...state, phase: "running", status: "starting…", heard: "", paused: undefined, summary: [], error: undefined };
    case "stopping":
      return withFeed(
        { ...state, phase: "stopping", paused: undefined },
        entries("warn", ["stopping: finishing what was already said (Stop again to end now)"]),
      );
    case "abandoned":
      return withFeed({ ...state, phase: "idle", status: "" }, entries("warn", ["stopped without waiting for the last calls"]));
    case "cancelled":
      return { ...state, phase: "idle", status: "" };
    case "resumed":
      return { ...state, paused: undefined, status: "listening again…" };
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
    case "microphone-off":
      return state;
    case "paused":
      return withFeed(
        { ...state, paused: action.seconds, status: "paused, microphone off" },
        entries("info", [`paused: no speech for ${action.seconds} s, microphone off`]),
      );
    case "done":
      return { ...state, phase: "idle", status: "", paused: undefined, summary: action.summary, transcript: action.transcript ?? "" };
    case "failed":
      return { ...state, phase: "idle", status: "", paused: undefined, error: action.message };
  }
}

export function useSession() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const worker = useRef<Worker | undefined>(undefined);
  /** The worker whose start request waits for the microphone or the recording. */
  const preparing = useRef<Worker | undefined>(undefined);
  const microphone = useRef<{ device: Microphone | undefined; deviceId: string } | undefined>(undefined);

  const closeMicrophone = useCallback(() => {
    microphone.current?.device?.close();
    if (microphone.current) microphone.current.device = undefined;
  }, []);

  const openFor = useCallback(async (w: Worker, deviceId: string): Promise<Microphone> => {
    const device = await openMicrophone(deviceId, {
      level: micLevel.set,
      ended: () => w.postMessage({ type: "microphone-lost" }),
    });
    microphone.current = { device, deviceId };
    return device;
  }, []);

  const end = useCallback(
    (w: Worker) => {
      w.terminate();
      if (worker.current !== w) return;
      worker.current = undefined;
      closeMicrophone();
      microphone.current = undefined;
    },
    [closeMicrophone],
  );

  const start = useCallback(
    async (spec: SessionSpec) => {
      if (worker.current) end(worker.current);
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.current = w;
      w.onmessage = ({ data }: MessageEvent<FromWorker>) => {
        dispatch(data);
        if (data.type === "microphone-off") closeMicrophone();
        if (data.type === "done" || data.type === "failed") end(w);
      };
      w.onerror = (event) => {
        dispatch({ type: "failed", message: event.message || "The session worker failed to start." });
        end(w);
      };
      dispatch({ type: "begin" });

      const { input, ...rest } = spec;
      let request: StartRequest;
      const transfer: Transferable[] = [];
      preparing.current = w;
      try {
        if (input.type !== "live") {
          request = { type: "start", ...rest, input };
        } else if (input.audio.kind === "microphone") {
          const device = await openFor(w, input.audio.deviceId).catch((error: unknown) => {
            throw new Error(microphoneProblem(error));
          });
          transfer.push(device.frames);
          request = { type: "start", ...rest, input: { ...input, audio: { kind: "microphone", label: device.label, frames: device.frames } } };
        } else {
          const { file } = input.audio;
          const { pcm } = await decodeRecording(file);
          transfer.push(pcm);
          request = { type: "start", ...rest, input: { ...input, audio: { kind: "recording", name: file.name, pcm } } };
        }
      } catch (error) {
        if (worker.current === w) dispatch({ type: "failed", message: error instanceof Error ? error.message : String(error) });
        end(w);
        return;
      } finally {
        if (preparing.current === w) preparing.current = undefined;
      }
      // Stopped while the microphone was opening.
      if (worker.current !== w) return;
      w.postMessage(request, transfer);
    },
    [end, openFor, closeMicrophone],
  );

  const resume = useCallback(async () => {
    const w = worker.current;
    const deviceId = microphone.current?.deviceId;
    if (!w || deviceId === undefined) return;
    try {
      const device = await openFor(w, deviceId);
      if (worker.current !== w) {
        device.close();
        return;
      }
      w.postMessage({ type: "resume", frames: device.frames }, [device.frames]);
      dispatch({ type: "resumed" });
    } catch (error) {
      dispatch({ type: "warn", message: microphoneProblem(error) });
    }
  }, [openFor]);

  const stop = useCallback(() => {
    const w = worker.current;
    if (!w) return;
    closeMicrophone();
    if (preparing.current === w) {
      // Nothing has started yet.
      end(w);
      dispatch({ type: "cancelled" });
    } else if (state.phase === "stopping") {
      end(w);
      dispatch({ type: "abandoned" });
    } else {
      w.postMessage({ type: "stop" });
      dispatch({ type: "stopping" });
    }
  }, [state.phase, end, closeMicrophone]);

  const clear = useCallback(() => dispatch({ type: "clear" }), []);

  useEffect(
    () => () => {
      worker.current?.terminate();
      microphone.current?.device?.close();
    },
    [],
  );

  return { state, start, stop, resume, clear };
}
