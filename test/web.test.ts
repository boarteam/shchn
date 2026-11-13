import { describe, expect, it } from "vitest";
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
