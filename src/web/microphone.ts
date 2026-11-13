import { SAMPLE_RATE } from "../core/input/stt/types";
import type { CaptureOptions } from "./captureWorklet";
import workletUrl from "./captureWorklet.ts?worker&url";
import { toInt16 } from "./pcm";

// The page's side of audio: opening the microphone (only the page may), and
// decoding recordings. The samples themselves go to the session worker through
// a MessagePort; the page keeps only the level, for the meter.

const FRAME_MS = 100;

export interface Microphone {
  /** The device's name, e.g. "MacBook Pro Microphone". */
  label: string;
  /** Carries 16 kHz 16-bit frames; hand it to the session worker. */
  frames: MessagePort;
  close(): void;
}

export interface MicrophoneEvents {
  /** Peak level 0…1, about ten times a second. */
  level(peak: number): void;
  /** The device went away (unplugged, or access revoked). */
  ended(): void;
}

/** Opens a microphone (`deviceId` "" for the system default) and starts delivering frames. */
export async function openMicrophone(deviceId: string, events: MicrophoneEvents): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      // Raw audio, as the command line captures it: speech-to-text does better without the browser's call processing.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const tracks = stream.getAudioTracks();
  let context: AudioContext | undefined;
  try {
    // Chrome resamples the microphone to the context's rate, so frames come out at 16 kHz.
    context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    await context.audioWorklet.addModule(workletUrl);
    const options: CaptureOptions = { targetRate: SAMPLE_RATE, frameMs: FRAME_MS };
    const node = new AudioWorkletNode(context, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // A stereo or multichannel input is mixed down to mono.
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: options,
    });
    const channel = new MessageChannel();
    node.port.postMessage({ frames: channel.port1 }, [channel.port1]);
    node.port.onmessage = ({ data }: MessageEvent<number>) => events.level(data);
    context.createMediaStreamSource(stream).connect(node);
    // The node outputs silence; connecting it keeps the graph running.
    node.connect(context.destination);
    await context.resume();

    let closed = false;
    for (const track of tracks) track.addEventListener("ended", () => closed || events.ended(), { once: true });
    const audioContext = context;
    return {
      label: tracks[0]?.label || "the microphone",
      frames: channel.port2,
      close() {
        if (closed) return;
        closed = true;
        for (const track of tracks) track.stop();
        node.port.onmessage = null;
        void audioContext.close();
        events.level(0);
      },
    };
  } catch (error) {
    for (const track of tracks) track.stop();
    void context?.close();
    throw error;
  }
}

/** What to tell the user when the microphone can't be opened. */
export function microphoneProblem(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return (
        "Chrome isn't allowed to use the microphone. Allow it with the icon at the left of the address bar; " +
        "on macOS also check System Settings → Privacy & Security → Microphone → Google Chrome."
      );
    case "NotFoundError":
      return "No microphone found. Connect one, or choose another input.";
    case "OverconstrainedError":
      return "The chosen microphone isn't available any more. Choose another input.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone couldn't be opened: another app may be using it, or the device stopped responding.";
    default:
      return `The microphone couldn't be opened: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface InputDevice {
  id: string;
  label: string;
}

/** Audio inputs. Names are known only once the page has been allowed to use the microphone. */
export async function listMicrophones(): Promise<InputDevice[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}

/** A recording decoded to 16 kHz 16-bit mono PCM, for replaying it as if spoken. */
export async function decodeRecording(file: File): Promise<{ pcm: ArrayBuffer; seconds: number }> {
  // Decoding in a context at 16 kHz resamples as well.
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let audio: AudioBuffer;
  try {
    audio = await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(`Couldn't decode ${file.name}. Use WAV, MP3, M4A, OGG or WebM audio.`);
  }
  const pcm = new Int16Array(audio.length);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  for (let i = 0; i < audio.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    pcm[i] = toInt16(sum / channels.length);
  }
  return { pcm: pcm.buffer, seconds: audio.duration };
}

// The level, for meters anywhere on the page, without re-rendering the page ten times a second.
const levelListeners = new Set<(level: number) => void>();
let currentLevel = 0;

export const micLevel = {
  set(peak: number): void {
    currentLevel = peak;
    for (const listener of levelListeners) listener(peak);
  },
  get: (): number => currentLevel,
  subscribe(listener: (level: number) => void): () => void {
    levelListeners.add(listener);
    return () => levelListeners.delete(listener);
  },
};
