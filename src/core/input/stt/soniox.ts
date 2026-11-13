import { unref } from "../../timers";
import { type SttEvents, type SttOptions, type SttProvider, type SttSession, waitOrTimeout } from "./types";

// Soniox real-time API: https://docs.soniox.com/stt/api-reference/websocket-api
// Handles Russian/English switching mid-sentence and reports pauses itself
// (endpoint detection), which is what triggers an extraction call.

const URL = "wss://stt-rt.soniox.com/transcribe-websocket";
export const SONIOX_MODEL = "stt-rt-v6";
const FINALIZE_INTERVAL_MS = 2000;

interface SonioxToken {
  text: string;
  start_ms?: number;
  end_ms?: number;
  is_final: boolean;
}

export interface SonioxMessage {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  error_type?: string;
  error_message?: string;
}

export function sonioxConfig(model: string, options: SttOptions): Record<string, unknown> {
  return {
    model,
    audio_format: "pcm_s16le",
    sample_rate: options.sampleRate,
    num_channels: 1,
    language_hints: options.languages,
    enable_endpoint_detection: true,
    // How long to wait after speech before declaring a pause (500–3000, default 2000).
    max_endpoint_delay_ms: 1000,
    context: {
      general: [{ key: "domain", value: "Software design: data models, entities, database tables and their fields" }],
      ...(options.terms.length > 0 ? { terms: options.terms } : {}),
    },
  };
}

/**
 * Turns one Soniox response into events. Final tokens arrive once and never
 * change; non-final tokens are re-sent in every response, so they replace the
 * previous partial text. "<end>" marks a pause; "<fin>" answers a finalize request.
 */
export function handleSonioxMessage(message: SonioxMessage, events: SttEvents): { finished: boolean } {
  if (message.error_code !== undefined) {
    events.error(
      new Error(`Soniox error ${message.error_code} (${message.error_type ?? "unknown"}): ${message.error_message ?? ""}`),
    );
    return { finished: true };
  }
  let finalText = "";
  let endMs: number | undefined;
  let partial = "";
  let endpoint = false;
  for (const token of message.tokens ?? []) {
    if (token.text === "<end>") endpoint = true;
    else if (token.text === "<fin>") continue;
    else if (token.is_final) {
      finalText += token.text;
      endMs = token.end_ms ?? endMs;
    } else partial += token.text;
  }
  if (finalText) events.final(finalText, endMs);
  events.partial(partial);
  if (endpoint) events.endpoint();
  return { finished: message.finished === true };
}

export class SonioxStt implements SttProvider {
  readonly name = "soniox";

  constructor(
    private readonly apiKey: string,
    private readonly model = SONIOX_MODEL,
  ) {}

  connect(options: SttOptions, events: SttEvents): Promise<SttSession> {
    const socket = new WebSocket(URL, ["soniox-api-key", this.apiKey]);
    let markDone = () => {};
    const done = new Promise<void>((resolve) => (markDone = resolve));
    let lastAudioAt = Date.now();
    let lastFinalizeAt = 0;
    let finalizeTimer: ReturnType<typeof setTimeout> | undefined;
    // Soniox closes the stream after 20 s without audio or a keepalive.
    const keepalive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN && Date.now() - lastAudioAt > 8000) {
        socket.send(JSON.stringify({ type: "keepalive" }));
      }
    }, 5000);
    unref(keepalive);

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      if (handleSonioxMessage(JSON.parse(event.data) as SonioxMessage, events).finished) markDone();
    };
    socket.onclose = () => {
      clearInterval(keepalive);
      clearTimeout(finalizeTimer);
      markDone();
    };

    return new Promise((resolve, reject) => {
      socket.onerror = () => reject(new Error("Couldn't connect to Soniox. Check SONIOX_API_KEY and the network."));
      socket.onopen = () => {
        socket.onerror = () => events.error(new Error("Soniox connection error"));
        socket.send(JSON.stringify(sonioxConfig(this.model, options)));
        resolve({
          sendAudio(chunk) {
            if (socket.readyState !== WebSocket.OPEN) return;
            socket.send(chunk as Uint8Array<ArrayBuffer>);
            lastAudioAt = Date.now();
          },
          finalize() {
            // Soniox advises finalizing at pauses, but not more often than every few
            // seconds: a pause that comes too soon is finalized when the interval is up.
            if (finalizeTimer) return;
            const send = () => {
              finalizeTimer = undefined;
              if (socket.readyState !== WebSocket.OPEN) return;
              socket.send(JSON.stringify({ type: "finalize" }));
              lastFinalizeAt = Date.now();
            };
            const wait = lastFinalizeAt + FINALIZE_INTERVAL_MS - Date.now();
            if (wait <= 0) send();
            else finalizeTimer = setTimeout(send, wait);
          },
          async finish() {
            // An empty text frame ends the stream; Soniox then sends the last tokens and closes.
            if (socket.readyState === WebSocket.OPEN) socket.send("");
            await waitOrTimeout(done, 5000);
            socket.close();
          },
        });
      };
    });
  }
}
