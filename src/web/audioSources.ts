import type { AudioCapture, AudioProblem, AudioSource } from "../core/session";

// The session worker's audio sources. The microphone itself is opened by the
// page (workers can't); its frames arrive here through a MessagePort, one port
// per stretch of listening. A recording is decoded by the page and played here
// at real-time speed, as `live --audio` does on the command line.

const FRAME_MS = 100;

function capture(): { capture: AudioCapture; finish(): void } {
  let finish = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  return { capture: { stop: () => finish(), done }, finish: () => finish() };
}

export function microphoneAdvice(problem: AudioProblem, speed: number): string {
  switch (problem) {
    case "no-audio":
      return (
        "No audio from the microphone after 5 s. Check that Chrome may use it (the icon at the left of the address bar) " +
        "and, on macOS, System Settings → Privacy & Security → Microphone → Google Chrome."
      );
    case "silent":
      return "The microphone sends only silence. Check it isn't muted, or choose another input.";
    case "slow":
      return (
        `Audio arrives at ${speed.toFixed(2)}x real time, so recognition may fail. ` +
        "Close other apps using the microphone, or choose another input."
      );
  }
}

/**
 * Drops frames until capture starts. Speech-to-text connects between the page
 * opening the microphone and the session starting to listen (as on the command
 * line, listening starts once it's connected), and a burst of queued frames
 * would throw off the audio clock that times each word.
 */
function discardUntilStarted(port: MessagePort): MessagePort {
  port.onmessage = () => {};
  return port;
}

/**
 * The microphone, through ports from the page. The first port comes with the
 * start request; after a pause for silence the page opens the microphone again
 * and sends a new one (`supply`).
 */
export class MicrophoneAudio implements AudioSource {
  readonly microphone = true;
  readonly advice = microphoneAdvice;
  private port: MessagePort | undefined;
  private current: (() => void) | undefined;
  private waiting: ((port: MessagePort) => void) | undefined;

  constructor(
    readonly description: string,
    port: MessagePort,
    /** Capture stopped: the page should turn the microphone off. */
    private readonly onStop: () => void,
  ) {
    this.port = discardUntilStarted(port);
  }

  start(_sampleRate: number, onFrame: (frame: Uint8Array) => void): AudioCapture {
    const port = this.port;
    this.port = undefined;
    const { capture: result, finish } = capture();
    if (!port) {
      finish();
      return result;
    }
    port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => onFrame(new Uint8Array(data));
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      port.onmessage = null;
      port.close();
      if (this.current === stop) this.current = undefined;
      this.onStop();
      finish();
    };
    this.current = stop;
    return { stop, done: result.done };
  }

  /** The microphone went away: end the capture, which ends listening. */
  lost(): void {
    this.current?.();
  }

  /** Waits for the page to reopen the microphone; false if the session stops first. */
  waitForPort(signal: AbortSignal): Promise<boolean> {
    if (this.port) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => {
        this.waiting = undefined;
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting = (port) => {
        signal.removeEventListener("abort", onAbort);
        this.waiting = undefined;
        this.port = discardUntilStarted(port);
        resolve(true);
      };
    });
  }

  /** A new port from the page, after Resume. */
  supply(port: MessagePort): void {
    if (this.waiting) this.waiting(port);
    else {
      this.port?.close();
      this.port = discardUntilStarted(port);
    }
  }
}

/** A decoded recording (16-bit mono PCM at the session's rate), played at real-time speed. */
export class RecordingAudio implements AudioSource {
  readonly microphone = false;

  constructor(
    readonly description: string,
    private readonly pcm: Uint8Array,
  ) {}

  start(sampleRate: number, onFrame: (frame: Uint8Array) => void): AudioCapture {
    const frameBytes = ((sampleRate * FRAME_MS) / 1000) * 2;
    const { capture: result, finish } = capture();
    const started = Date.now();
    let offset = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      // Send every frame that's due by now; schedule from the start time so delays don't add up.
      while (offset < this.pcm.length && (offset / frameBytes) * FRAME_MS <= Date.now() - started) {
        onFrame(this.pcm.slice(offset, offset + frameBytes));
        offset += frameBytes;
      }
      if (offset >= this.pcm.length) finish();
      else timer = setTimeout(tick, started + (offset / frameBytes) * FRAME_MS - Date.now());
    };
    tick();
    return {
      stop() {
        clearTimeout(timer);
        finish();
      },
      done: result.done,
    };
  }

  advice(problem: AudioProblem): string {
    return problem === "silent" ? "The recording is silent." : "The recording didn't play.";
  }
}
