import { PcmFramer } from "./pcm";

// Runs on the browser's audio thread: takes the microphone's samples and sends
// 100 ms frames of 16-bit PCM straight to the session worker, through a port the
// page hands over at start. Frames never pass through the page, so a busy or
// hidden tab doesn't delay them. The page gets only the level, for the meter.

// The audio worklet's globals, which TypeScript's DOM library doesn't describe.
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export interface CaptureOptions {
  /** The rate to deliver. */
  targetRate: number;
  frameMs: number;
}

class PcmCapture extends AudioWorkletProcessor {
  private frames: MessagePort | undefined;
  private readonly framer: PcmFramer;

  constructor(options: { processorOptions: CaptureOptions }) {
    super();
    const { targetRate, frameMs } = options.processorOptions;
    this.framer = new PcmFramer(sampleRate, targetRate, Math.round((targetRate * frameMs) / 1000), (frame, peak) => {
      this.frames?.postMessage(frame.buffer, [frame.buffer]);
      this.port.postMessage(peak);
    });
    this.port.onmessage = ({ data }: MessageEvent<{ frames?: MessagePort }>) => {
      if (data.frames) this.frames = data.frames;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    // The node mixes its input down to one channel; no input means no samples this round.
    const samples = inputs[0]?.[0];
    if (samples) this.framer.push(samples);
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
