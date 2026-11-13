import { describe, expect, it } from "vitest";
import { Engine, type EngineOptions } from "../src/core/engine/engine";
import type { CallStats, OpsSource } from "../src/core/extract/claude";
import type { Op } from "../src/core/model/ops";
import { ModelStore } from "../src/core/model/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stands in for Claude: answers each call with scripted ops after a delay. */
class FakeSource implements OpsSource {
  readonly messages: string[] = [];

  constructor(private readonly respond: (message: string) => { ops?: Op[]; delayMs?: number } = () => ({})) {}

  async run(message: string, onOp: (op: Op) => void): Promise<CallStats> {
    this.messages.push(message);
    const { ops = [], delayMs = 5 } = this.respond(message);
    await sleep(delayMs);
    for (const op of ops) onOp(op);
    return {
      model: "fake",
      stopReason: "end_turn",
      totalMs: delayMs,
      ops: ops.length,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  /** The <new> text of each extraction call. */
  get sentTexts(): string[] {
    return this.messages.flatMap((m) => {
      const match = /<new kind="\w+">\n([\s\S]*?)\n<\/new>/.exec(m);
      return match?.[1] ? [match[1]] : [];
    });
  }
}

function options(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return {
    kind: "speech",
    maxBatchChars: 1500,
    contextChars: 1500,
    idleFlushMs: 0,
    review: { enabled: false, everyMs: 60_000, maxChars: 60_000 },
    ...overrides,
  };
}

describe("Engine", () => {
  it("sends complete sentences and holds back an unfinished one", async () => {
    const source = new FakeSource();
    const engine = new Engine(new ModelStore(), source, options());
    engine.push("A user has an email. And");
    await sleep(20);
    expect(source.sentTexts).toEqual(["A user has an email."]);
    engine.push(" a name. ");
    await engine.drain();
    expect(source.sentTexts).toEqual(["A user has an email.", "And a name."]);
  });

  it("batches text that arrives during a call into the next call", async () => {
    const source = new FakeSource(() => ({ delayMs: 40 }));
    const engine = new Engine(new ModelStore(), source, options());
    engine.push("Users have emails. ");
    await sleep(5);
    engine.push("Orders have totals. ");
    engine.push("Items have prices. ");
    await engine.drain();
    expect(source.sentTexts).toEqual(["Users have emails.", "Orders have totals. Items have prices."]);
  });

  it("flushes unfinished text on a pause and on drain", async () => {
    const source = new FakeSource();
    const engine = new Engine(new ModelStore(), source, options());
    engine.push("so users have emails");
    await sleep(20);
    expect(source.sentTexts).toEqual([]);
    engine.flush();
    await sleep(20);
    expect(source.sentTexts).toEqual(["so users have emails"]);
    engine.push("and names");
    await engine.drain();
    expect(source.sentTexts).toEqual(["so users have emails", "and names"]);
  });

  it("applies ops, and shows each call the current model and the text before it", async () => {
    const store = new ModelStore();
    const source = new FakeSource((m) =>
      m.includes("email") ? { ops: [{ op: "upsert_property", entity: "User", property: "email", ref: null, many: false }] } : {},
    );
    const engine = new Engine(store, source, options());
    engine.push("A user has an email. ");
    await sleep(20);
    engine.push("That's all. ");
    await engine.drain();
    expect(store.view().entities).toEqual([{ name: "User", properties: [{ name: "email", ref: null, many: false }] }]);
    expect(source.messages[1]).toContain("email: {}");
    expect(source.messages[1]).toMatch(/<recent_context>\nA user has an email\.\n<\/recent_context>/);
  });

  it("splits a long document into several calls", async () => {
    const source = new FakeSource();
    const engine = new Engine(new ModelStore(), source, options({ kind: "document", maxBatchChars: 100 }));
    engine.push("A sentence that is about forty chars. ".repeat(6));
    await engine.drain();
    expect(source.sentTexts.length).toBeGreaterThan(1);
    expect(source.sentTexts.every((t) => t.length <= 100)).toBe(true);
    expect(source.sentTexts.join(" ").match(/forty/g)?.length).toBe(6);
  });

  it("records time from end of speech to the model update", async () => {
    const engine = new Engine(new ModelStore(), new FakeSource(), options());
    engine.push("Users have ", Date.now() - 3000);
    engine.push("emails. ", Date.now() - 1000);
    await engine.drain();
    // Measured from the latest words, not from the start of the sentence.
    const latency = engine.batches[0]?.latencyMs ?? 0;
    expect(latency).toBeGreaterThanOrEqual(1000);
    expect(latency).toBeLessThan(3000);
  });

  it("runs a final review and applies its fixes", async () => {
    const store = new ModelStore();
    const source = new FakeSource((m) => {
      if (m.includes("<transcript")) return { ops: [{ op: "merge_entities", entity: "Client", into: "Customer" }] };
      return {
        ops: [
          { op: "upsert_property", entity: "Customer", property: "name", ref: null, many: false },
          { op: "upsert_property", entity: "Client", property: "phone", ref: null, many: false },
        ],
      };
    });
    const engine = new Engine(store, source, options({ review: { enabled: true, everyMs: 60_000, maxChars: 60_000 } }));
    engine.push("Customers have names. Clients have phones. ");
    await engine.drain();
    expect(store.view().entities).toEqual([
      {
        name: "Customer",
        properties: [
          { name: "name", ref: null, many: false },
          { name: "phone", ref: null, many: false },
        ],
      },
    ]);
    expect(engine.batches.map((b) => b.kind)).toEqual(["extract", "review"]);
  });

  it("skips the final review when nothing changed", async () => {
    const source = new FakeSource();
    const engine = new Engine(new ModelStore(), source, options({ review: { enabled: true, everyMs: 0, maxChars: 1000 } }));
    engine.push("Um, okay. ");
    await engine.drain();
    expect(source.messages.some((m) => m.includes("<transcript"))).toBe(false);
  });
});

describe("Engine quiet-time flush", () => {
  it("sends unfinished speech after a quiet spell, but not half a word", async () => {
    const source = new FakeSource();
    const engine = new Engine(new ModelStore(), source, options({ idleFlushMs: 30 }));
    engine.push("Так, давайте наки");
    await sleep(80);
    expect(source.sentTexts).toEqual(["Так, давайте"]);
    engine.push("даем модель данных. ");
    await engine.drain();
    expect(source.sentTexts).toEqual(["Так, давайте", "накидаем модель данных."]);
  });
});

describe("Engine fragment merging", () => {
  it("lets one-word fragments ride along with the next phrase", async () => {
    const source = new FakeSource();
    const engine = new Engine(new ModelStore(), source, options());
    engine.push("Сотрудники. ");
    engine.push("Могут. ");
    await sleep(20);
    expect(source.sentTexts).toEqual([]);
    engine.push("Играть роль. ");
    await engine.drain();
    expect(source.sentTexts).toEqual(["Сотрудники. Могут. Играть роль."]);
  });

  it("never spends a call on filler alone", async () => {
    const source = new FakeSource();
    const engine = new Engine(new ModelStore(), source, options({ idleFlushMs: 20 }));
    engine.push("Э-э. ");
    await sleep(60);
    engine.push("Мм, ну. ");
    await engine.drain();
    expect(source.messages).toEqual([]);
    // It still counts as said, so later calls see it as context.
    expect(engine.transcript).toContain("Э-э.");
  });

  it("still sends a short phrase once the speaker pauses", async () => {
    const source = new FakeSource();
    const engine = new Engine(new ModelStore(), source, options());
    engine.push("Есть роли. ");
    await sleep(20);
    expect(source.sentTexts).toEqual([]);
    engine.flush(); // speech-to-text reported a pause
    await sleep(20);
    expect(source.sentTexts).toEqual(["Есть роли."]);
    await engine.drain();
  });
});

describe("Engine speech-to-text pauses", () => {
  it("send unfinished phrases but keep collecting one-word fragments", async () => {
    const source = new FakeSource();
    const engine = new Engine(new ModelStore(), source, options());
    engine.push("Могут");
    engine.pause();
    await sleep(20);
    expect(source.sentTexts).toEqual([]);
    engine.push(" играть разные роли");
    engine.pause();
    await sleep(20);
    expect(source.sentTexts).toEqual(["Могут играть разные роли"]);
    await engine.drain();
  });
});
