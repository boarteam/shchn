// Plays a transcript into the engine at speaking speed, word by word, so a live
// session can be simulated (and timed) without a microphone. A blank line
// between paragraphs counts as a pause.

export interface ReplaySink {
  push(text: string, spokenAt?: number): void;
  flush(): void;
}

export interface ReplayOptions {
  wordsPerMinute: number;
  /** Extra silence at each paragraph break, in ms. */
  pauseMs?: number;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function replay(text: string, sink: ReplaySink, options: ReplayOptions): Promise<void> {
  const msPerWord = 60_000 / options.wordsPerMinute;
  const pauseMs = options.pauseMs ?? 700;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  // Schedule against the start time so timer jitter doesn't accumulate.
  let due = performance.now();
  for (const paragraph of paragraphs) {
    for (const word of paragraph.split(/\s+/)) {
      due += msPerWord;
      await sleep(due - performance.now(), options.signal);
      if (options.signal?.aborted) return;
      sink.push(`${word} `, Date.now());
    }
    sink.flush();
    due += pauseMs;
  }
}
