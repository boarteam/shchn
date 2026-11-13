import { describe, expect, it } from "vitest";
import { ModelStore } from "../src/model/store";
import { toYaml } from "../src/model/yaml";
import { TerminalView } from "../src/output/view";

/** A fake terminal that keeps the last frame, without escape codes. */
function terminal(columns: number, rows: number) {
  const screen = { text: "" };
  const out = {
    columns,
    rows,
    write(s: string) {
      screen.text = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { out, screen };
}

describe("TerminalView", () => {
  it("shows the model, recent changes, what's heard and the status", () => {
    const store = new ModelStore();
    store.apply({ op: "upsert_property", entity: "User", property: "orders", ref: "Order", many: true });
    const { out, screen } = terminal(100, 40);
    const view = new TerminalView(out, () => "shchn · test", () => toYaml(store.view()));
    view.addChanges(["+ User.orders → Order[]"]);
    view.setHeard("у user есть orders");
    view.setStatus("#1 1.2 s · 2 edits");
    view.render();
    expect(screen.text).toContain("orders: { ref: Order, many: true }");
    expect(screen.text).toContain("+ User.orders → Order[]");
    expect(screen.text).toContain("heard: у user есть orders");
    expect(screen.text).toContain("#1 1.2 s · 2 edits");
  });

  it("crops a tall model around the latest change", () => {
    const store = new ModelStore();
    const { out, screen } = terminal(100, 16);
    const view = new TerminalView(out, () => "shchn · test", () => toYaml(store.view()));
    view.render();
    for (let i = 0; i < 6; i++) store.apply({ op: "upsert_property", entity: "User", property: `field_${i}`, ref: null, many: false });
    store.apply({ op: "upsert_property", entity: "Order", property: "total", ref: null, many: false });
    view.render();
    expect(screen.text).toContain("lines above");
    expect(screen.text).toContain("total: {}");
  });

  it("treats a terminal width of 0 as unknown instead of hiding every line", () => {
    const { out, screen } = terminal(0, 0);
    const view = new TerminalView(out, () => "shchn · test", () => "entities: {}\n");
    view.render();
    expect(screen.text).toContain("entities: {}");
  });
});
