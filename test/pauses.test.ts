import { describe, expect, it } from "vitest";
import { PauseDetector } from "../src/input/pauses";

const RATE = 16000;

/** 16-bit mono PCM: a tone (speech stand-in) or near-silence, `ms` long. */
function audio(ms: number, amplitude: number): Buffer {
  const samples = (RATE * ms) / 1000;
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE) + (Math.random() - 0.5) * 40), i * 2);
  }
  return buffer;
}

/** Feeds audio in 100 ms frames, like the capture does. */
function feed(detector: PauseDetector, buffer: Buffer): void {
  for (let i = 0; i < buffer.length; i += 3200) detector.push(buffer.subarray(i, i + 3200));
}

describe("PauseDetector", () => {
  it("fires once per pause after enough speech", () => {
    let pauses = 0;
    const detector = new PauseDetector(RATE, () => pauses++);
    feed(detector, audio(300, 20)); // background noise
    feed(detector, audio(1000, 4000)); // speech
    feed(detector, audio(400, 20)); // pause
    expect(pauses).toBe(1);
    feed(detector, audio(600, 20)); // still the same pause
    expect(pauses).toBe(1);
    feed(detector, audio(800, 4000));
    feed(detector, audio(300, 20));
    expect(pauses).toBe(2);
  });

  it("ignores gaps that are too short and blips of noise", () => {
    let pauses = 0;
    const detector = new PauseDetector(RATE, () => pauses++);
    feed(detector, audio(1000, 4000));
    feed(detector, audio(100, 20)); // a comma, not a pause
    feed(detector, audio(1000, 4000));
    expect(pauses).toBe(0);
    feed(detector, audio(1000, 20));
    feed(detector, audio(100, 4000)); // a click
    feed(detector, audio(500, 20));
    expect(pauses).toBe(1);
  });
});
