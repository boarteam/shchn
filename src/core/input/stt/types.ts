// A streaming speech-to-text connection. Adapters use the standard WebSocket
// API and authenticate through the WebSocket protocols list, so the same code
// runs in Node and in the browser.

/** 16 kHz: the rate audio sources deliver and speech-to-text receives. */
export const SAMPLE_RATE = 16_000;

export interface SttEvents {
  /** The current unfinished hypothesis, replacing the previous one. Display only. */
  partial(text: string): void;
  /** Finalized text (with its own spacing) and the audio time, in ms, when its last word ended. */
  final(text: string, endMs?: number): void;
  /** The speaker paused: a good moment to send what's pending. */
  endpoint(): void;
  error(error: Error): void;
}

export interface SttSession {
  sendAudio(chunk: Uint8Array): void;
  /** The speaker paused: ask for everything heard so far to be confirmed now. */
  finalize(): void;
  /** Ends the audio stream and waits (briefly) for the last results. */
  finish(): Promise<void>;
}

export interface SttOptions {
  sampleRate: number;
  /** Language hints, e.g. ["ru", "en"]. */
  languages: string[];
  /** Vocabulary to bias recognition toward, e.g. entity names. */
  terms: string[];
}

export interface SttProvider {
  readonly name: string;
  connect(options: SttOptions, events: SttEvents): Promise<SttSession>;
}

export function waitOrTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
