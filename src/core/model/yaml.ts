import { parse } from "yaml";
import type { ModelView, PropertyView } from "./store";

// The output format:
//
//   entities:
//     Customer:
//       properties:
//         email: {}
//         orders: { ref: Order, many: true }
//
// Written by hand rather than through a YAML library so the layout is fixed:
// one line per property, stable order, nothing reflowed between updates.

const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"]);

function scalar(text: string): string {
  if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(text) && !RESERVED.has(text.toLowerCase())) return text;
  return JSON.stringify(text); // a JSON string is a valid double-quoted YAML scalar
}

function propertyValue(p: PropertyView): string {
  const parts: string[] = [];
  if (p.ref !== null) parts.push(`ref: ${scalar(p.ref)}`);
  if (p.many) parts.push("many: true");
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
}

export function toYaml(view: ModelView): string {
  if (view.entities.length === 0) return "entities: {}\n";
  const lines = ["entities:"];
  for (const e of view.entities) {
    lines.push(`  ${scalar(e.name)}:`);
    if (e.properties.length === 0) {
      lines.push("    properties: {}");
      continue;
    }
    lines.push("    properties:");
    for (const p of e.properties) lines.push(`      ${scalar(p.name)}: ${propertyValue(p)}`);
  }
  return `${lines.join("\n")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProperty(name: string, def: unknown): PropertyView {
  // Shorthand for hand-written files: `customer: Customer`, `orders: Order[]`.
  if (typeof def === "string") {
    const many = def.trim().endsWith("[]");
    return { name, ref: def.replace(/\[\]\s*$/, "").trim() || null, many };
  }
  if (isRecord(def)) {
    return { name, ref: typeof def.ref === "string" ? def.ref : null, many: def.many === true };
  }
  return { name, ref: null, many: false };
}

/** Reads a model file in the format above (also accepts the shorthand). */
export function parseModelYaml(text: string): ModelView {
  const data: unknown = parse(text);
  const entities = isRecord(data) && isRecord(data.entities) ? data.entities : {};
  return {
    entities: Object.entries(entities).map(([name, def]) => {
      const props = isRecord(def) && isRecord(def.properties) ? def.properties : {};
      return { name, properties: Object.entries(props).map(([p, pdef]) => parseProperty(p, pdef)) };
    }),
  };
}
