import type { ClaudeConfig } from "../core/extract/claude";
import type { ReviewSettings, SessionInput } from "../core/session";

// Messages between the page and the session worker (worker.ts). Plain data
// only: they're copied between threads.

/** What the page can feed a session so far; the microphone comes later. */
export type TextInput = Extract<SessionInput, { type: "documents" | "replay" }>;

export interface ModelStats {
  entities: number;
  properties: number;
  relations: number;
}

export interface StartRequest {
  type: "start";
  input: TextInput;
  apiKey: string;
  claude: ClaudeConfig;
  review: ReviewSettings;
  /** Continue from this model instead of an empty one. */
  resumeYaml?: string;
}

export type ToWorker =
  | StartRequest
  /** Stop the input; calls already started still finish. */
  | { type: "stop" };

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
  | { type: "done"; summary: string[] }
  | { type: "failed"; message: string };
