import { describe, expect, it } from "vitest";
import { AudioClock } from "../src/core/input/audioClock";

describe("AudioClock", () => {
  it("maps audio time to wall time across a pause", () => {
    const clock = new AudioClock();
    // 3 s of audio, frames ending at t = 1100, 1200, … 4000.
    for (let i = 1; i <= 30; i++) clock.frame(100, 1000 + i * 100);
    expect(clock.wallTime(1500)).toBe(2500);
    // Paused for a minute, then capture restarts.
    clock.restart();
    for (let i = 1; i <= 10; i++) clock.frame(100, 64_000 + i * 100);
    // Audio sent after the restart starts at 3000 ms of audio time.
    expect(clock.wallTime(3500)).toBe(64_500);
    expect(clock.wallTime(2900)).toBe(3900);
    expect(clock.audioSentMs).toBe(4000);
  });
});
