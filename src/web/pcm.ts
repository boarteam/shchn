// Turns the browser's audio (32-bit float samples at the device's rate) into
// what speech-to-text takes: 16-bit little-endian mono PCM at 16 kHz, in frames
// of about 100 ms. Runs inside the audio worklet, so it allocates as little as
// possible per call.

/** A float sample in -1…1 as a 16-bit integer. */
export function toInt16(sample: number): number {
  const s = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

/** Peak level 0…1 shown on a meter scaled in decibels: -60 dB and below is 0, full scale is 1. */
export function meterLevel(peak: number): number {
  if (peak <= 0) return 0;
  return Math.max(0, Math.min(1, 1 + (20 * Math.log10(peak)) / 60));
}

/**
 * Collects samples into fixed-size frames, resampling by linear interpolation
 * when the input rate differs. Chrome normally delivers 16 kHz itself (the audio
 * context is created at that rate); resampling here is the fallback.
 */
export class PcmFramer {
  private readonly step: number;
  private frame: Int16Array;
  private filled = 0;
  private peak = 0;
  /** Position of the next output sample, in input samples from the start of the next block; -1…0 is between the previous block's last sample and the next block's first. */
  private position = 0;
  private previous = 0;

  constructor(
    inputRate: number,
    outputRate: number,
    private readonly frameSamples: number,
    /** A full frame (its own buffer, free to transfer) and its peak level 0…1. */
    private readonly onFrame: (frame: Int16Array, peak: number) => void,
  ) {
    this.step = inputRate / outputRate;
    this.frame = new Int16Array(frameSamples);
  }

  push(input: Float32Array): void {
    if (input.length === 0) return;
    if (this.step === 1) {
      for (let i = 0; i < input.length; i++) this.emit(input[i] ?? 0);
      return;
    }
    let position = this.position;
    const last = input.length - 1;
    while (position < last) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = index < 0 ? this.previous : (input[index] ?? 0);
      const b = input[index + 1] ?? 0;
      this.emit(a + (b - a) * fraction);
      position += this.step;
    }
    this.position = position - input.length;
    this.previous = input[last] ?? 0;
  }

  private emit(sample: number): void {
    const magnitude = sample < 0 ? -sample : sample;
    if (magnitude > this.peak) this.peak = magnitude;
    this.frame[this.filled++] = toInt16(sample);
    if (this.filled < this.frameSamples) return;
    this.onFrame(this.frame, Math.min(1, this.peak));
    this.frame = new Int16Array(this.frameSamples);
    this.filled = 0;
    this.peak = 0;
  }
}
