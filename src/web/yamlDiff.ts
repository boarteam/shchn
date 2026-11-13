// Small pieces of the YAML view that don't need a browser, so they're tested
// in Node (test/web.test.ts).

/** The one edit that turns `before` into `after`: everything between their common start and end. */
export function changedRange(before: string, after: string): { from: number; to: number; insert: string } | undefined {
  if (before === after) return undefined;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

/**
 * Which lines are new: a line counts as fresh for `highlightMs` after it first
 * appeared. Lines in the first text shown (an empty or resumed model) aren't
 * new. The same rule as the terminal view.
 */
export class FreshLines {
  private readonly firstSeen = new Map<string, number>();
  private started = false;

  constructor(private readonly highlightMs: number) {}

  /** Records `text` as shown at `now`; returns the 1-based numbers of its fresh lines, in order. */
  update(text: string, now: number): number[] {
    const lines = text.split("\n");
    for (const line of lines) if (!this.firstSeen.has(line)) this.firstSeen.set(line, this.started ? now : -Infinity);
    this.started = true;
    return lines.flatMap((line, i) => (now - (this.firstSeen.get(line) ?? -Infinity) < this.highlightMs ? [i + 1] : []));
  }
}
