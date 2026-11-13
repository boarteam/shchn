import { unref } from "../../timers";
import { type SttEvents, type SttOptions, type SttProvider, type SttSession, waitOrTimeout } from "./types";

// Deepgram live API: https://developers.deepgram.com/reference/speech-to-text/listen-streaming
// Nova-3 with language=multi handles switching between languages. A pause is
// taken from UtteranceEnd (1 s of silence after the last word); the faster
// speech_final signal fires on 100 ms pauses, too often to batch on.

const URL = "wss://api.deepgram.com/v1/listen";

export interface DeepgramMessage {
  type: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: Array<{ transcript?: string; words?: Array<{ end?: number }> }> };
  last_word_end?: number;
  variant?: string;
  description?: string;
}

export function deepgramUrl(options: SttOptions): string {
  const multilingual = options.languages.length !== 1;
  const params = new URLSearchParams({
    model: "nova-3",
    language: multilingual ? "multi" : (options.languages[0] ?? "en"),
    encoding: "linear16",
    sample_rate: String(options.sampleRate),
    channels: "1",
    interim_results: "true",
    // 100 ms is Deepgram's recommendation for code-switching.
    endpointing: "100",
    utterance_end_ms: "1000",
    smart_format: "true",
    punctuate: "true",
  });
  if (multilingual) for (const language of options.languages) params.append("language_hint", language);
  for (const term of options.terms) params.append("keyterm", term);
  return `${URL}?${params}`;
}

/** Turns one Deepgram message into events. */
export function handleDeepgramMessage(message: DeepgramMessage, events: SttEvents): { finished: boolean } {
  switch (message.type) {
    case "Results": {
      const alternative = message.channel?.alternatives?.[0];
      const text = alternative?.transcript?.trim() ?? "";
      if (!message.is_final) {
        events.partial(text);
      } else {
        if (text) {
          const lastWordEnd = alternative?.words?.at(-1)?.end;
          const endSeconds = lastWordEnd ?? (message.start ?? 0) + (message.duration ?? 0);
          events.final(`${text} `, endSeconds * 1000);
        }
        events.partial("");
      }
      return { finished: false };
    }
    case "UtteranceEnd":
      // -1 means the utterance was already finalized; nothing new to flush.
      if (message.last_word_end !== -1) events.endpoint();
      return { finished: false };
    case "Error":
      events.error(new Error(`Deepgram error (${message.variant ?? "unknown"}): ${message.description ?? ""}`));
      return { finished: true };
    default:
      return { finished: false };
  }
}

export class DeepgramStt implements SttProvider {
  readonly name = "deepgram";

  constructor(
    private readonly apiKey: string,
    /** What to check when the connection fails, in the platform's words. */
    private readonly keyHint = "Check the Deepgram API key, the language codes and the network.",
  ) {}

  connect(options: SttOptions, events: SttEvents): Promise<SttSession> {
    const socket = new WebSocket(deepgramUrl(options), ["token", this.apiKey]);
    let markDone = () => {};
    const done = new Promise<void>((resolve) => (markDone = resolve));
    let lastAudioAt = Date.now();
    // Deepgram closes the connection after 10 s without audio or a KeepAlive.
    const keepalive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN && Date.now() - lastAudioAt > 3000) {
        socket.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 3000);
    unref(keepalive);

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      if (handleDeepgramMessage(JSON.parse(event.data) as DeepgramMessage, events).finished) markDone();
    };
    socket.onclose = () => {
      clearInterval(keepalive);
      markDone();
    };

    return new Promise((resolve, reject) => {
      socket.onerror = () => reject(new Error(`Couldn't connect to Deepgram. ${this.keyHint}`));
      socket.onopen = () => {
        socket.onerror = () => events.error(new Error("Deepgram connection error"));
        resolve({
          sendAudio(chunk) {
            if (socket.readyState !== WebSocket.OPEN) return;
            socket.send(chunk as Uint8Array<ArrayBuffer>);
            lastAudioAt = Date.now();
          },
          finalize() {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "Finalize" }));
          },
          async finish() {
            // Deepgram sends the remaining results and a Metadata message, then closes.
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
            await waitOrTimeout(done, 5000);
            socket.close();
          },
        });
      };
    });
  }
}
