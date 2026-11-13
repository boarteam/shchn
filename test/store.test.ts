import { describe, expect, it } from "vitest";
import { nameKey, toEntityName, toPropertyName } from "../src/core/model/names";
import type { Op } from "../src/core/model/ops";
import { ModelStore } from "../src/core/model/store";
import { toYaml } from "../src/core/model/yaml";

function prop(entity: string, property: string, ref: string | null = null, many = false): Op {
  return { op: "upsert_property", entity, property, ref, many };
}

function build(...ops: Op[]): ModelStore {
  const store = new ModelStore();
  for (const op of ops) store.apply(op);
  return store;
}

describe("names", () => {
  it("normalizes entity and property names", () => {
    expect(toEntityName("order item")).toBe("OrderItem");
    expect(toEntityName("order_item")).toBe("OrderItem");
    expect(toEntityName("HTTPRequest")).toBe("HttpRequest");
    expect(toPropertyName("createdAt")).toBe("created_at");
    expect(toPropertyName("User ID")).toBe("user_id");
    expect(toPropertyName("avatar url")).toBe("avatar_url");
    expect(nameKey("OrderItem")).toBe(nameKey("order item"));
  });

  it("keeps non-Latin letters", () => {
    expect(toEntityName("заказ товара")).toBe("ЗаказТовара");
  });
});

describe("ModelStore", () => {
  it("creates entities and relation targets on demand", () => {
    const store = build(prop("User", "email"), prop("User", "orders", "Order", true));
    expect(store.view()).toEqual({
      entities: [
        {
          name: "User",
          properties: [
            { name: "email", ref: null, many: false },
            { name: "orders", ref: "Order", many: true },
          ],
        },
        { name: "Order", properties: [] },
      ],
    });
  });

  it("matches existing names regardless of case, separators and plurals", () => {
    const store = build(prop("OrderItem", "quantity"), prop("order items", "price"), prop("Users", "email"));
    expect(store.view().entities.map((e) => e.name)).toEqual(["OrderItem", "Users"]);
    expect(store.apply(prop("user", "name")).changes).toEqual(["+ Users.name"]);
  });

  it("reports no-ops and updates", () => {
    const store = build(prop("Order", "customer", "Customer"));
    expect(store.apply(prop("Order", "customer", "Customer")).status).toBe("noop");
    const result = store.apply(prop("Order", "customer", "Client"));
    expect(result.status).toBe("applied");
    expect(result.changes).toEqual(["+ Client", "~ Order.customer → Client"]);
  });

  it("renames entities and keeps relations pointing at them", () => {
    const store = build(prop("Order", "customer", "Customer"), prop("Customer", "name"));
    store.apply({ op: "rename_entity", entity: "Customer", new_name: "client" });
    expect(toYaml(store.view())).toBe(
      ["entities:", "  Order:", "    properties:", "      customer: { ref: Client }", "  Client:", "    properties:", "      name: {}", ""].join("\n"),
    );
  });

  it("treats renaming onto an existing entity as a merge", () => {
    const store = build(prop("Customer", "name"), prop("Client", "email"), prop("Order", "client", "Client"));
    const result = store.apply({ op: "rename_entity", entity: "Client", new_name: "Customer" });
    expect(result.changes).toEqual(["Client ⇒ Customer"]);
    const view = store.view();
    expect(view.entities.map((e) => e.name)).toEqual(["Customer", "Order"]);
    expect(view.entities[0]?.properties.map((p) => p.name)).toEqual(["name", "email"]);
    expect(view.entities[1]?.properties[0]?.ref).toBe("Customer");
  });

  it("merges entities, keeping the target's properties on conflict", () => {
    const store = build(prop("Buyer", "name"), prop("Buyer", "address", "Address"), prop("Customer", "address"));
    store.apply({ op: "merge_entities", entity: "Buyer", into: "Customer" });
    expect(store.view().entities.find((e) => e.name === "Customer")?.properties).toEqual([
      { name: "address", ref: "Address", many: false },
      { name: "name", ref: null, many: false },
    ]);
  });

  it("removes relations that point at a removed entity", () => {
    const store = build(prop("Order", "invoice", "Invoice"), prop("Order", "total"));
    const result = store.apply({ op: "remove_entity", entity: "Invoice" });
    expect(result.changes).toEqual(["- Invoice", "- Order.invoice"]);
    expect(store.view().entities).toEqual([{ name: "Order", properties: [{ name: "total", ref: null, many: false }] }]);
  });

  it("renames a property onto an existing one by folding it in", () => {
    const store = build(prop("Order", "cost"), prop("Order", "price"));
    expect(store.apply({ op: "rename_property", entity: "Order", property: "cost", new_name: "price" }).changes).toEqual([
      "Order.cost ⇒ Order.price",
    ]);
    expect(store.view().entities[0]?.properties.map((p) => p.name)).toEqual(["price"]);
  });

  it("is idempotent for removals and rejects edits to things that never existed", () => {
    const store = build(prop("Order", "total"));
    expect(store.apply({ op: "remove_property", entity: "Order", property: "fax" }).status).toBe("noop");
    expect(store.apply({ op: "remove_entity", entity: "Ghost" }).status).toBe("noop");
    expect(store.apply({ op: "rename_entity", entity: "Ghost", new_name: "Spirit" }).status).toBe("rejected");
    expect(store.apply(prop("Order", "  ")).status).toBe("rejected");
  });

  it("resolves names as they were when a snapshot was taken", () => {
    const store = build(prop("Client", "name"), prop("Customer", "email"));
    const resolve = store.resolver();
    // Meanwhile, Client gets renamed…
    store.apply({ op: "rename_entity", entity: "Client", new_name: "Buyer" });
    // …and a review based on the old snapshot merges "Client" into Customer.
    store.apply({ op: "merge_entities", entity: "Client", into: "Customer" }, resolve);
    expect(store.view().entities.map((e) => e.name)).toEqual(["Customer"]);
  });

  it("round-trips through a view", () => {
    const store = build(prop("User", "teams", "Team", true), prop("Team", "name"), prop("Team", "tags", null, true));
    expect(ModelStore.fromView(store.view()).view()).toEqual(store.view());
  });
});
