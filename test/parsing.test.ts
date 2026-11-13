import { describe, expect, it } from "vitest";
import { chooseCut, lastSentenceEnd } from "../src/engine/cut";
import { OpsStreamParser } from "../src/extract/opsStream";
import { SYSTEM_PROMPT } from "../src/extract/prompt";
import { parseOp } from "../src/model/ops";
import { parseModelYaml, toYaml } from "../src/model/yaml";

describe("OpsStreamParser", () => {
  const json =
    '{"ops":[{"op":"upsert_property","entity":"Order","property":"note \\"}{\\" here","ref":null,"many":false},' +
    '{"op":"rename_entity","entity":"Customer","new_name":"Client"}]}';

  it("emits each op as soon as it closes, even fed one character at a time", () => {
    const parser = new OpsStreamParser();
    const seen: Array<{ at: number; value: unknown }> = [];
    [...json].forEach((char, i) => {
      for (const value of parser.push(char)) seen.push({ at: i, value });
    });
    expect(seen.map((s) => s.value)).toEqual(JSON.parse(json).ops);
    // The first op is out well before the end of the stream.
    expect(seen[0]?.at).toBeLessThan(json.indexOf("rename_entity"));
  });

  it("handles an empty list", () => {
    expect(new OpsStreamParser().push('{"ops":[]}')).toEqual([]);
  });
});

describe("parseOp", () => {
  it("accepts valid ops and rejects malformed ones", () => {
    expect(parseOp({ op: "remove_entity", entity: "X" })).toEqual({ op: "remove_entity", entity: "X" });
    expect(parseOp({ op: "upsert_property", entity: "A", property: "b", ref: 3, many: false })).toBeNull();
    expect(parseOp({ op: "drop_table", entity: "X" })).toBeNull();
  });

  it("accepts every example op in the system prompt", () => {
    const examples = SYSTEM_PROMPT.split("\n").filter((line) => line.startsWith('{"ops"'));
    expect(examples.length).toBeGreaterThan(0);
    for (const line of examples) {
      for (const op of JSON.parse(line).ops) expect(parseOp(op), JSON.stringify(op)).not.toBeNull();
    }
  });
});

describe("yaml", () => {
  it("quotes names YAML would misread and round-trips", () => {
    const view = {
      entities: [
        { name: "Switch", properties: [{ name: "on", ref: null, many: false }, { name: "parts", ref: "Part", many: true }] },
        { name: "Part", properties: [] },
      ],
    };
    const yaml = toYaml(view);
    expect(yaml).toContain('"on": {}');
    expect(yaml).toContain("parts: { ref: Part, many: true }");
    expect(parseModelYaml(yaml)).toEqual(view);
  });

  it("reads the hand-written shorthand", () => {
    const view = parseModelYaml("entities:\n  Order:\n    properties:\n      customer: Customer\n      items: OrderItem[]\n      total:\n");
    expect(view.entities[0]?.properties).toEqual([
      { name: "customer", ref: "Customer", many: false },
      { name: "items", ref: "OrderItem", many: true },
      { name: "total", ref: null, many: false },
    ]);
  });
});

describe("chooseCut", () => {
  it("sends complete sentences and waits on an unfinished one", () => {
    const text = "A user has an email. And a na";
    expect(lastSentenceEnd(text)).toBe("A user has an email.".length);
    expect(chooseCut(text, 1000, false)).toBe("A user has an email.".length);
    expect(chooseCut("and a na", 1000, false)).toBe(0);
    expect(chooseCut("and a na", 1000, true)).toBe("and a na".length);
  });

  it("doesn't split decimals", () => {
    expect(lastSentenceEnd("price is 3.5 dollars")).toBe(0);
  });

  it("cuts long text at a boundary below the limit", () => {
    const text = `${"word ".repeat(30)}end. ${"more ".repeat(30)}`;
    const cut = chooseCut(text, 200, true);
    expect(cut).toBeLessThanOrEqual(200);
    expect(text.slice(0, cut).trimEnd().endsWith("end.")).toBe(true);
  });
});
