import type { ClaudeConfig } from "../core/extract/claude";
import type { SttName } from "../core/input/stt";
import type { ReviewSettings, SessionInput } from "../core/session";

// Messages between the page and the session worker (worker.ts). Plain data
// only: they're copied between threads, except the transferred audio port and
// recording buffer.

/** Pasted text or dropped files. */
export type TextInput = Extract<SessionInput, { type: "documents" | "replay" }>;

/** Speech: the microphone, or a recording played as if spoken. */
export interface LiveRequest {
  type: "live";
  stt: SttName;
  sttKey: string;
  languages: string[];
  terms: string[];
  /** Turn the microphone off after this many seconds without speech; 0 = never. */
  pauseAfterSeconds: number;
  audio:
    | { kind: "microphone"; label: string; frames: MessagePort }
    | { kind: "recording"; name: string; pcm: ArrayBuffer };
}

export interface ModelStats {
  entities: number;
  properties: number;
  relations: number;
}

export interface StartRequest {
  type: "start";
  input: TextInput | LiveRequest;
  apiKey: string;
  claude: ClaudeConfig;
  review: ReviewSettings;
  /** Continue from this model instead of an empty one. */
  resumeYaml?: string;
}

export type ToWorker =
  | StartRequest
  /** Stop the input; calls already started still finish. */
  | { type: "stop" }
  /** The microphone is on again after a pause; frames come through `frames`. */
  | { type: "resume"; frames: MessagePort }
  /** The microphone went away. */
  | { type: "microphone-lost" };

export type FromWorker =
  | { type: "model"; yaml: string; stats: ModelStats }
  | { type: "changes"; lines: string[]; fromReview: boolean }
  /** A call started: what it's working on. */
  | { type: "status"; text: string }
  /** A call finished, in one line. */
  | { type: "batch"; text: string }
  | { type: "heard"; text: string }
  | { type: "info"; message: string }
  | { type: "warn"; message: string }
  /** Listening stopped: turn the microphone off. */
  | { type: "microphone-off" }
  /** No speech for a while: the microphone is off until the user resumes. */
  | { type: "paused"; seconds: number }
  /** `transcript`: what was heard, for speech sessions. */
  | { type: "done"; summary: string[]; transcript?: string }
  | { type: "failed"; message: string };
