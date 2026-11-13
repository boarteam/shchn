// Pure helpers for looking at 16-bit mono PCM: levels over time and silent gaps.

export function decibels(value: number): number {
  return value > 0 ? 20 * Math.log10(value / 32768) : -96;
}

/** A dBFS value for display: rounded, and never "-0". */
export function formatDb(db: number): string {
  return String(Math.round(db) || 0);
}

export interface Level {
  /** Window start, in seconds. */
  at: number;
  rmsDb: number;
  peakDb: number;
}

/** RMS and peak level per window (dBFS; -96 means exact digital silence). */
export function levels(samples: Int16Array, sampleRate: number, windowMs: number): Level[] {
  const size = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const out: Level[] = [];
  for (let start = 0; start + size <= samples.length; start += size) {
    let sum = 0;
    let peak = 0;
    for (let i = start; i < start + size; i++) {
      const v = samples[i] ?? 0;
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    out.push({ at: start / sampleRate, rmsDb: decibels(Math.sqrt(sum / size)), peakDb: decibels(peak) });
  }
  return out;
}

export interface Gap {
  /** Start, in seconds. */
  at: number;
  ms: number;
}

/**
 * Stretches where the 20 ms RMS stays below `threshold` (raw sample units, as
 * the pause detector uses) for at least `minMs`.
 */
export function silentGaps(samples: Int16Array, sampleRate: number, threshold: number, minMs = 100): Gap[] {
  const windowMs = 20;
  const size = (sampleRate * windowMs) / 1000;
  const gaps: Gap[] = [];
  let runStart = -1;
  let run = 0;
  const close = () => {
    if (run * windowMs >= minMs) gaps.push({ at: (runStart * size) / sampleRate, ms: run * windowMs });
    run = 0;
  };
  for (let w = 0; (w + 1) * size <= samples.length; w++) {
    let sum = 0;
    for (let i = w * size; i < (w + 1) * size; i++) {
      const v = samples[i] ?? 0;
      sum += v * v;
    }
    if (Math.sqrt(sum / size) < threshold) {
      if (run === 0) runStart = w;
      run++;
    } else close();
  }
  close();
  return gaps;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}
