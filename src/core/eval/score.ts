import { looseKey, nameKey } from "../model/names";
import type { ModelView } from "../model/store";

// Compares an extracted model with a hand-written expected one. Three views:
//   entities    — which entities exist
//   attributes  — plain properties, per entity
//   relations   — links between entities (from → to, one or many), regardless
//                 of what the property is called, because relation names vary
//                 a lot between equally good answers.
// Matching ignores case, separators and simple plurals, but not synonyms.

export interface Metric {
  precision: number;
  recall: number;
  f1: number;
  missing: string[];
  extra: string[];
}

export interface Score {
  entities: Metric;
  attributes: Metric;
  relations: Metric;
}

type Items = Map<string, string>; // comparison key → display label

function collect(view: ModelView): { entities: Items; attributes: Items; relations: Items } {
  const entities: Items = new Map();
  const attributes: Items = new Map();
  const relations: Items = new Map();
  for (const e of view.entities) {
    const ek = looseKey(e.name);
    entities.set(ek, e.name);
    for (const p of e.properties) {
      if (p.ref === null) {
        attributes.set(`${ek}.${nameKey(p.name)}`, `${e.name}.${p.name}`);
      } else {
        const label = `${e.name} → ${p.ref}${p.many ? "[]" : ""}`;
        relations.set(`${ek}>${looseKey(p.ref)}${p.many ? "[]" : ""}`, label);
      }
    }
  }
  return { entities, attributes, relations };
}

function metric(actual: Items, expected: Items): Metric {
  const missing = [...expected].filter(([k]) => !actual.has(k)).map(([, label]) => label);
  const extra = [...actual].filter(([k]) => !expected.has(k)).map(([, label]) => label);
  const hits = expected.size - missing.length;
  const precision = actual.size === 0 ? (expected.size === 0 ? 1 : 0) : hits / actual.size;
  const recall = expected.size === 0 ? 1 : hits / expected.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, missing, extra };
}

export function scoreModel(actual: ModelView, expected: ModelView): Score {
  const a = collect(actual);
  const e = collect(expected);
  return {
    entities: metric(a.entities, e.entities),
    attributes: metric(a.attributes, e.attributes),
    relations: metric(a.relations, e.relations),
  };
}

export function formatScore(score: Score): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4);
  const lines = ["               precision  recall    F1"];
  for (const [name, m] of Object.entries(score) as Array<[string, Metric]>) {
    lines.push(`  ${name.padEnd(12)}    ${pct(m.precision)}     ${pct(m.recall)}  ${pct(m.f1)}`);
  }
  for (const [name, m] of Object.entries(score) as Array<[string, Metric]>) {
    if (m.missing.length > 0) lines.push(`  missing ${name}: ${m.missing.join(", ")}`);
    if (m.extra.length > 0) lines.push(`  extra ${name}: ${m.extra.join(", ")}`);
  }
  return lines.join("\n");
}
