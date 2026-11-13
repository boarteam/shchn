// Finds short pauses in 16-bit mono PCM. Streaming speech-to-text holds back
// confirmed text for seconds during continuous speech; asking it to finalize at
// each pause gets the words out a few hundred milliseconds after they're said.

export interface PauseOptions {
  /** Speech needed since the last pause before another pause counts, in ms. */
  minSpeechMs: number;
  /** Silence that counts as a pause, in ms. */
  pauseMs: number;
}

const WINDOW_MS = 20;

export class PauseDetector {
  private noiseFloor = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private remainder = Buffer.alloc(0);
  private readonly windowBytes: number;

  constructor(
    sampleRate: number,
    private readonly onPause: () => void,
    // Speakers pause ~200 ms between sentences, often less between phrases.
    private readonly options: PauseOptions = { minSpeechMs: 400, pauseMs: 200 },
  ) {
    this.windowBytes = ((sampleRate * WINDOW_MS) / 1000) * 2;
  }

  push(frame: Buffer): void {
    let data = this.remainder.length > 0 ? Buffer.concat([this.remainder, frame]) : frame;
    while (data.length >= this.windowBytes) {
      this.analyse(data.subarray(0, this.windowBytes));
      data = data.subarray(this.windowBytes);
    }
    this.remainder = Buffer.from(data);
  }

  private analyse(window: Buffer): void {
    let sum = 0;
    for (let i = 0; i + 1 < window.length; i += 2) {
      const sample = window.readInt16LE(i);
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / (window.length / 2));
    // The noise floor drops at once and rises slowly, so speech doesn't drag it up.
    this.noiseFloor = this.noiseFloor === 0 || rms < this.noiseFloor ? rms : this.noiseFloor + (rms - this.noiseFloor) * 0.002;
    const speaking = rms > Math.max(200, this.noiseFloor * 3);

    if (speaking) {
      this.speechMs += WINDOW_MS;
      this.silenceMs = 0;
      return;
    }
    this.silenceMs += WINDOW_MS;
    if (this.speechMs >= this.options.minSpeechMs && this.silenceMs >= this.options.pauseMs) {
      this.speechMs = 0;
      this.onPause();
    }
  }
}
