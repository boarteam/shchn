import { describe, expect, it } from "vitest";
import { levels, percentile, silentGaps } from "../tools/lib/audioStats";

const RATE = 16000;

function signal(parts: Array<[ms: number, amplitude: number]>): Int16Array {
  const out: number[] = [];
  for (const [ms, amplitude] of parts) {
    for (let i = 0; i < (RATE * ms) / 1000; i++) out.push(Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)));
  }
  return Int16Array.from(out);
}

describe("audio analysis helpers", () => {
  it("finds silent gaps by length and threshold", () => {
    const samples = signal([[500, 8000], [240, 0], [500, 8000], [60, 0], [500, 8000]]);
    const gaps = silentGaps(samples, RATE, 200);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.ms).toBe(240);
    expect(gaps[0]?.at).toBeCloseTo(0.5, 1);
  });

  it("reports levels per window, with -96 dBFS for digital silence", () => {
    const timeline = levels(signal([[500, 16384], [500, 0]]), RATE, 500);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.peakDb).toBeCloseTo(-6, 0);
    expect(timeline[1]?.peakDb).toBe(-96);
  });

  it("computes percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});
