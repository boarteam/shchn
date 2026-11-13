import type { CallStats, OpsSource } from "../extract/claude";
import type { Effort } from "../extract/models";
import { type InputKind, extractMessage, reviewMessage } from "../extract/prompt";
import type { Op } from "../model/ops";
import type { ApplyResult, EntityResolver, ModelStore } from "../model/store";
import { toYaml } from "../model/yaml";
import { chooseCut, lastWordBoundary } from "./cut";

// The scheduler between input and the LLM. Text arrives in pieces; the engine
// sends complete sentences (or everything, after a pause) to one extraction
// call at a time. Text that arrives while a call runs waits and goes out with
// the next call, so a slow call never builds a queue. Each call sees the current
// model, so the model itself is the memory and calls stay small.
//
// A slower review pass reads the whole transcript every so often and fixes
// drift (duplicates, missed relations). Its edits are applied between
// extraction calls, never in the middle of one.

export interface EngineOptions {
  kind: InputKind;
  /** Max characters of new text per extraction call. */
  maxBatchChars: number;
  /** Characters of already-processed text sent along as context. */
  contextChars: number;
  /** Send unfinished text after this much quiet, in ms; 0 turns it off. */
  idleFlushMs: number;
  review: {
    enabled: boolean;
    /** Minimum time between review passes during input, in ms. */
    everyMs: number;
    effort?: Effort;
    /** The review reads at most this many characters from the end of the transcript. */
    maxChars: number;
  };
}

export interface Segment {
  text: string;
  /** Wall-clock time (ms) when this text finished being spoken, for latency stats. */
  spokenAt?: number;
}

export interface AppliedOp {
  batch: number;
  kind: BatchRecord["kind"];
  at: number;
  op: Op;
  result: ApplyResult;
}

export interface BatchRecord {
  id: number;
  kind: "extract" | "review";
  /** The new text sent (empty for a review). */
  text: string;
  sentAt: number;
  doneAt?: number;
  stats?: CallStats;
  error?: unknown;
  ops: AppliedOp[];
  /** Time from the end of the latest speech in this batch to its edits being applied. */
  latencyMs?: number;
}

export interface EngineEvents {
  batchStart?(batch: BatchRecord): void;
  op?(applied: AppliedOp): void;
  batchEnd?(batch: BatchRecord): void;
  error?(error: unknown, batch: BatchRecord): void;
}

const MIN_WORDS = 3;
const FILLERS = new Set(
  "э ээ эээ эм ам а аа м мм ммм ну вот так значит короче типа um umm uh uhm hmm mm ah er okay ok so well like".split(" "),
);

/** Words that carry meaning: everything except hesitation and filler. */
export function meaningfulWords(text: string): number {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !FILLERS.has(w)).length;
}

export class Engine {
  readonly batches: BatchRecord[] = [];
  private pending: Segment[] = [];
  private sent = "";
  private busy = false;
  private flushRequested = false;
  private wordFlushRequested = false;
  private pauseRequested = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private reviewTimer?: ReturnType<typeof setInterval>;
  private nextBatchId = 1;
  private idleWaiters: Array<() => void> = [];
  private review?: Promise<void>;
  private reviewResult?: { ops: Op[]; resolve: EntityResolver; batch: BatchRecord };
  private lastReviewAt = Date.now();
  private changedSinceReview = false;

  constructor(
    private readonly store: ModelStore,
    private readonly source: OpsSource,
    private readonly options: EngineOptions,
    private readonly events: EngineEvents = {},
  ) {
    if (options.review.enabled && options.kind === "speech") {
      this.reviewTimer = setInterval(() => this.maybeReview(), 1000);
      this.reviewTimer.unref?.();
    }
  }

  /** Everything sent for extraction so far. */
  get transcript(): string {
    return this.sent;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  push(text: string, spokenAt?: number): void {
    if (!text) return;
    this.pending.push({ text, spokenAt });
    if (this.options.idleFlushMs > 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.flushWholeWords(), this.options.idleFlushMs);
      this.idleTimer.unref?.();
    }
    this.pump();
  }

  /** The speaker paused or a section ended: send pending text even without a sentence end. */
  flush(): void {
    if (!this.pendingText().trim()) return;
    this.flushRequested = true;
    this.pump();
  }

  /**
   * Speech-to-text noticed a pause. Unfinished text may go, but a fragment shorter
   * than a phrase still waits for more words, or for a longer quiet spell.
   */
  pause(): void {
    if (!this.pendingText().trim()) return;
    this.pauseRequested = true;
    this.pump();
  }

  /** Quiet for a while without a sentence end: send what's pending, up to its last whole word. */
  private flushWholeWords(): void {
    if (!this.pendingText().trim()) return;
    this.wordFlushRequested = true;
    this.pump();
  }

  /** Processes everything pending, runs a final review if anything changed, and waits for both. */
  async drain(): Promise<void> {
    clearInterval(this.reviewTimer);
    this.flush();
    await this.whenIdle();
    await this.review;
    if (this.options.review.enabled && this.changedSinceReview) await this.startReview();
  }

  private pendingText(): string {
    return this.pending.map((s) => s.text).join("");
  }

  private pump(): void {
    if (this.busy) return;
    this.applyReviewResult();
    const text = this.pendingText();
    if (!text.trim()) {
      this.pending = [];
      this.flushRequested = false;
      this.wordFlushRequested = false;
      this.pauseRequested = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      return;
    }
    const speech = this.options.kind === "speech";
    const force = this.flushRequested || !speech;
    let cut = chooseCut(text, this.options.maxBatchChars, force || this.pauseRequested);
    const quietFlush = cut <= 0 && this.wordFlushRequested;
    if (quietFlush) cut = lastWordBoundary(text);
    if (cut <= 0) return; // wait for the sentence (or word) to end

    if (speech) {
      const words = meaningfulWords(text.slice(0, cut));
      // Only filler ("э-э", "um") and the speaker has paused: nothing to extract.
      if (words === 0 && (force || quietFlush)) {
        this.sent += this.take(cut).map((s) => s.text).join("");
        this.wordFlushRequested = false;
        if (cut >= text.length) this.flushRequested = false;
        this.pump();
        return;
      }
      // A fragment like "Могут." costs a whole call: let it ride along with the
      // next phrase, unless the speaker has paused for good.
      if (words < MIN_WORDS && !force && !quietFlush) return;
    }

    this.wordFlushRequested = false;
    if (cut >= text.length) {
      this.flushRequested = false;
      this.pauseRequested = false;
    }
    void this.extract(this.take(cut));
  }

  private take(count: number): Segment[] {
    const taken: Segment[] = [];
    let remaining = count;
    while (remaining > 0 && this.pending.length > 0) {
      const segment = this.pending[0]!;
      if (segment.text.length <= remaining) {
        taken.push(segment);
        this.pending.shift();
        remaining -= segment.text.length;
      } else {
        taken.push({ text: segment.text.slice(0, remaining), spokenAt: segment.spokenAt });
        this.pending[0] = { text: segment.text.slice(remaining), spokenAt: segment.spokenAt };
        remaining = 0;
      }
    }
    return taken;
  }

  private whenIdle(): Promise<void> {
    if (!this.busy && !this.pendingText().trim()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private contextTail(): string {
    const max = this.options.contextChars;
    if (this.sent.length <= max) return this.sent;
    const tail = this.sent.slice(-max);
    return `…${tail.slice(tail.indexOf(" ") + 1)}`;
  }

  private async extract(segments: Segment[]): Promise<void> {
    this.busy = true;
    const text = segments.map((s) => s.text).join("");
    const batch = this.newBatch("extract", text);
    const message = extractMessage(toYaml(this.store.view()), this.contextTail(), text, this.options.kind);
    this.sent += text;
    this.events.batchStart?.(batch);
    try {
      batch.stats = await this.source.run(message, (op) => this.apply(op, batch));
    } catch (error) {
      batch.error = error;
      this.events.error?.(error, batch);
    }
    batch.doneAt = Date.now();
    const spokenAt = segments.flatMap((s) => (s.spokenAt === undefined ? [] : [s.spokenAt]));
    if (spokenAt.length > 0) batch.latencyMs = batch.doneAt - Math.max(...spokenAt);
    this.finish(batch);
    this.busy = false;
    this.maybeReview();
    this.pump();
  }

  private apply(op: Op, batch: BatchRecord, resolve?: EntityResolver): void {
    const result = this.store.apply(op, resolve);
    if (batch.kind === "extract" && result.status === "applied") this.changedSinceReview = true;
    const applied: AppliedOp = { batch: batch.id, kind: batch.kind, at: Date.now(), op, result };
    batch.ops.push(applied);
    this.events.op?.(applied);
  }

  private maybeReview(): void {
    const { enabled, everyMs } = this.options.review;
    // Documents get one review at the end (drain); only live input is reviewed periodically.
    if (!enabled || this.options.kind !== "speech" || this.review || !this.changedSinceReview) return;
    if (Date.now() - this.lastReviewAt < everyMs) return;
    void this.startReview();
  }

  private startReview(): Promise<void> {
    this.review ??= this.runReview().finally(() => {
      this.review = undefined;
    });
    return this.review;
  }

  private async runReview(): Promise<void> {
    this.changedSinceReview = false;
    this.lastReviewAt = Date.now();
    const batch = this.newBatch("review", "");
    const resolve = this.store.resolver();
    const transcript = this.sent.slice(-this.options.review.maxChars);
    const message = reviewMessage(toYaml(this.store.view()), transcript, this.options.kind);
    const ops: Op[] = [];
    this.events.batchStart?.(batch);
    try {
      batch.stats = await this.source.run(message, (op) => ops.push(op), { effort: this.options.review.effort });
    } catch (error) {
      batch.error = error;
      this.events.error?.(error, batch);
    }
    this.reviewResult = { ops, resolve, batch };
    if (!this.busy) this.applyReviewResult();
  }

  /** Applies a finished review's edits, resolving names as the review saw them. */
  private applyReviewResult(): void {
    const result = this.reviewResult;
    if (!result) return;
    this.reviewResult = undefined;
    for (const op of result.ops) this.apply(op, result.batch, result.resolve);
    result.batch.doneAt = Date.now();
    this.finish(result.batch);
  }

  private newBatch(kind: BatchRecord["kind"], text: string): BatchRecord {
    return { id: this.nextBatchId++, kind, text, sentAt: Date.now(), ops: [] };
  }

  private finish(batch: BatchRecord): void {
    this.batches.push(batch);
    this.events.batchEnd?.(batch);
  }
}
