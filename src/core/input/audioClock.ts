// Maps speech-to-text timestamps (milliseconds of audio sent) to wall-clock time.
// Audio stops while a session is paused, so the mapping is piecewise: each time
// capture (re)starts, an anchor ties the audio sent so far to the current time.

export class AudioClock {
  private anchors: Array<{ audioMs: number; wallMs: number }> = [];
  private sentMs = 0;

  /** Call for each frame sent; `frameMs` is its duration. */
  frame(frameMs: number, now = Date.now()): void {
    // The first frame of a capture ends now, so its audio started frameMs ago.
    if (this.pendingAnchor) {
      this.anchors.push({ audioMs: this.sentMs, wallMs: now - frameMs });
      this.pendingAnchor = false;
    }
    this.sentMs += frameMs;
  }

  /** Capture (re)starts: the next frame anchors the clock again. */
  restart(): void {
    this.pendingAnchor = true;
  }

  /** Wall-clock time when audio time `audioMs` was spoken, if known. */
  wallTime(audioMs: number): number | undefined {
    let anchor: { audioMs: number; wallMs: number } | undefined;
    for (const a of this.anchors) if (a.audioMs <= audioMs) anchor = a;
    return anchor ? anchor.wallMs + (audioMs - anchor.audioMs) : undefined;
  }

  get audioSentMs(): number {
    return this.sentMs;
  }

  private pendingAnchor = true;
}
