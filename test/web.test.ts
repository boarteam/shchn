import { describe, expect, it, vi } from "vitest";
import { MicrophoneAudio, RecordingAudio } from "../src/web/audioSources";
import { PcmFramer, meterLevel, toInt16 } from "../src/web/pcm";
import { FreshLines, changedRange } from "../src/web/yamlDiff";

function apply(text: string, change: ReturnType<typeof changedRange>): string {
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;
}

describe("changedRange", () => {
  it("replaces only the part between the common start and end", () => {
    const before = "entities:\n  User:\n    properties:\n      name: {}\n";
    const after = "entities:\n  User:\n    properties:\n      name: {}\n      email: {}\n";
    const change = changedRange(before, after);
    expect(change).toEqual({ from: before.length, to: before.length, insert: "      email: {}\n" });
    expect(apply(before, change)).toBe(after);
  });

  it("handles removals, edits in the middle and identical texts", () => {
    const cases: Array<[string, string]> = [
      ["a: {}\nb: {}\nc: {}\n", "a: {}\nc: {}\n"],
      ["orders: { ref: Order }", "orders: { ref: Order, many: true }"],
      ["aaa", "aaaa"],
      ["", "entities: {}\n"],
    ];
    for (const [before, after] of cases) expect(apply(before, changedRange(before, after))).toBe(after);
    expect(changedRange("same", "same")).toBeUndefined();
  });
});

describe("FreshLines", () => {
  it("doesn't highlight what was there at first, then highlights new lines for a while", () => {
    const fresh = new FreshLines(4000);
    expect(fresh.update("entities:\n  User:", 0)).toEqual([]);
    expect(fresh.update("entities:\n  User:\n  Order:", 1000)).toEqual([3]);
    expect(fresh.update("entities:\n  Client:\n  User:\n  Order:", 2000)).toEqual([2, 4]);
    expect(fresh.update("entities:\n  Client:\n  User:\n  Order:", 5500)).toEqual([2]);
    expect(fresh.update("entities:\n  Client:\n  User:\n  Order:", 6000)).toEqual([]);
  });
});

describe("PcmFramer", () => {
  it("converts float samples to 16-bit and cuts fixed-size frames", () => {
    const frames: Array<{ frame: number[]; peak: number }> = [];
    const framer = new PcmFramer(16000, 16000, 4, (frame, peak) => frames.push({ frame: [...frame], peak }));
    framer.push(new Float32Array([0, 0.5, -0.5, 1, -1, 2]));
    expect(frames).toEqual([{ frame: [0, toInt16(0.5), toInt16(-0.5), 32767], peak: 1 }]);
    framer.push(new Float32Array([0.25, 0]));
    expect(frames[1]).toEqual({ frame: [-32768, 32767, toInt16(0.25), 0], peak: 1 });
    expect(toInt16(0.5)).toBe(16384);
    expect(toInt16(-0.5)).toBe(-16384);
  });

  it("resamples 48 kHz to 16 kHz across block boundaries", () => {
    const out: number[] = [];
    const framer = new PcmFramer(48000, 16000, 1600, (frame) => out.push(...frame));
    const tone = (rate: number, i: number) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
    // 0.35 s in the worklet's blocks of 128 samples.
    for (let start = 0; start < 48000 * 0.35; start += 128) {
      framer.push(Float32Array.from({ length: 128 }, (_, k) => tone(48000, start + k)));
    }
    expect(out).toHaveLength(3 * 1600);
    const worst = Math.max(...out.map((sample, i) => Math.abs(sample / 32767 - tone(16000, i))));
    expect(worst).toBeLessThan(0.01);
  });

  it("scales the meter in decibels", () => {
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(0.001)).toBeCloseTo(0, 5);
    expect(meterLevel(10 ** (-30 / 20))).toBeCloseTo(0.5, 5);
    expect(meterLevel(0)).toBe(0);
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function pcmFrame(value: number): ArrayBuffer {
  return new Int16Array(4).fill(value).buffer;
}

describe("MicrophoneAudio", () => {
  it("drops frames sent before listening starts, then passes them on until stopped", async () => {
    const channel = new MessageChannel();
    let stops = 0;
    const audio = new MicrophoneAudio("Test mic", channel.port2, () => stops++);
    channel.port1.postMessage(pcmFrame(1));
    await settle();

    const received: number[] = [];
    const capture = audio.start(16000, (frame) => received.push(new Int16Array(frame.buffer)[0] ?? 0));
    channel.port1.postMessage(pcmFrame(2));
    channel.port1.postMessage(pcmFrame(3));
    await settle();
    expect(received).toEqual([2, 3]);

    capture.stop();
    await capture.done;
    channel.port1.postMessage(pcmFrame(4));
    await settle();
    expect(received).toEqual([2, 3]);
    expect(stops).toBe(1);
  });

  it("waits for a new port after a pause, and gives up when the session stops", async () => {
    const audio = new MicrophoneAudio("Test mic", new MessageChannel().port2, () => {});
    audio.start(16000, () => {}).stop();

    const stopSession = new AbortController();
    const waiting = audio.waitForPort(stopSession.signal);
    const channel = new MessageChannel();
    audio.supply(channel.port2);
    expect(await waiting).toBe(true);
    const received: number[] = [];
    const capture = audio.start(16000, (frame) => received.push(new Int16Array(frame.buffer)[0] ?? 0));
    channel.port1.postMessage(pcmFrame(7));
    await settle();
    expect(received).toEqual([7]);

    audio.lost();
    await capture.done;
    const next = audio.waitForPort(stopSession.signal);
    stopSession.abort();
    expect(await next).toBe(false);
  });
});

describe("RecordingAudio", () => {
  it("plays a recording in 100 ms frames at real-time speed", async () => {
    vi.useFakeTimers();
    try {
      const pcm = new Uint8Array(16000 * 2 * 0.35); // 350 ms
      const sizes: number[] = [];
      const capture = new RecordingAudio("the recording", pcm).start(16000, (frame) => sizes.push(frame.length));
      expect(sizes).toEqual([3200]);
      await vi.advanceTimersByTimeAsync(100);
      expect(sizes).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(250);
      expect(sizes).toEqual([3200, 3200, 3200, 1600]);
      await capture.done;
    } finally {
      vi.useRealTimers();
    }
  });
});
