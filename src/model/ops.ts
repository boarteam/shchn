// Edit operations: the only way the model changes. The LLM emits them; ModelStore
// applies them. Keeping the vocabulary small keeps the output short (fast) and
// every change checkable.

export type Op =
  | { op: "upsert_entity"; entity: string }
  | { op: "upsert_property"; entity: string; property: string; ref: string | null; many: boolean }
  | { op: "rename_entity"; entity: string; new_name: string }
  | { op: "rename_property"; entity: string; property: string; new_name: string }
  | { op: "remove_entity"; entity: string }
  | { op: "remove_property"; entity: string; property: string }
  | { op: "merge_entities"; entity: string; into: string };

export type OpKind = Op["op"];

const STRING = { type: "string" } as const;

function variant(op: OpKind, fields: Record<string, unknown>) {
  return {
    type: "object",
    properties: { op: { const: op }, ...fields },
    required: ["op", ...Object.keys(fields)],
    additionalProperties: false,
  };
}

/** JSON schema for the structured output: `{"ops": [...]}`. */
export const OPS_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        anyOf: [
          variant("upsert_entity", { entity: STRING }),
          variant("upsert_property", {
            entity: STRING,
            property: STRING,
            ref: { anyOf: [STRING, { type: "null" }] },
            many: { type: "boolean" },
          }),
          variant("rename_entity", { entity: STRING, new_name: STRING }),
          variant("rename_property", { entity: STRING, property: STRING, new_name: STRING }),
          variant("remove_entity", { entity: STRING }),
          variant("remove_property", { entity: STRING, property: STRING }),
          variant("merge_entities", { entity: STRING, into: STRING }),
        ],
      },
    },
  },
  required: ["ops"],
  additionalProperties: false,
} as const;

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** Validates an op parsed from model output. Returns null when the shape is wrong. */
export function parseOp(value: unknown): Op | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v.op) {
    case "upsert_entity":
      return isString(v.entity) ? { op: v.op, entity: v.entity } : null;
    case "upsert_property": {
      const ref = v.ref ?? null;
      if (!isString(v.entity) || !isString(v.property) || (ref !== null && !isString(ref))) return null;
      return { op: v.op, entity: v.entity, property: v.property, ref, many: v.many === true };
    }
    case "rename_entity":
      return isString(v.entity) && isString(v.new_name)
        ? { op: v.op, entity: v.entity, new_name: v.new_name }
        : null;
    case "rename_property":
      return isString(v.entity) && isString(v.property) && isString(v.new_name)
        ? { op: v.op, entity: v.entity, property: v.property, new_name: v.new_name }
        : null;
    case "remove_entity":
      return isString(v.entity) ? { op: v.op, entity: v.entity } : null;
    case "remove_property":
      return isString(v.entity) && isString(v.property)
        ? { op: v.op, entity: v.entity, property: v.property }
        : null;
    case "merge_entities":
      return isString(v.entity) && isString(v.into) ? { op: v.op, entity: v.entity, into: v.into } : null;
    default:
      return null;
  }
}
