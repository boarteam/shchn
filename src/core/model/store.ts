import { looseKey, nameKey, toEntityName, toPropertyName } from "./names";
import type { Op } from "./ops";

// The live model. Entities and properties keep internal ids, so a rename or a
// merge doesn't break relations pointing at them, and insertion order is kept so
// the YAML doesn't jump around between updates.

interface Property {
  id: string;
  name: string;
  /** Id of the target entity when the property is a relation. */
  ref: string | null;
  many: boolean;
}

interface Entity {
  id: string;
  name: string;
  properties: Property[];
}

/** Plain view of the model, without ids: what gets serialized and shown to the LLM. */
export interface ModelView {
  entities: EntityView[];
}
export interface EntityView {
  name: string;
  properties: PropertyView[];
}
export interface PropertyView {
  name: string;
  ref: string | null;
  many: boolean;
}

export type ApplyStatus = "applied" | "noop" | "rejected";

export interface ApplyResult {
  status: ApplyStatus;
  /** Human-readable changes, e.g. "+ Order.customer → Customer". */
  changes: string[];
  reason?: string;
}

/**
 * Maps a name to an entity id. Used for ops generated against an older snapshot
 * (the review pass): names are resolved as they were when the LLM saw them, so a
 * rename made in the meantime doesn't send the op to the wrong place.
 */
export type EntityResolver = (name: string) => string | undefined;

export class ModelStore {
  private entities: Entity[] = [];
  private nextId = 1;
  /** Bumped on every change. */
  version = 0;

  static fromView(view: ModelView): ModelStore {
    const store = new ModelStore();
    for (const e of view.entities) store.apply({ op: "upsert_entity", entity: e.name });
    for (const e of view.entities) {
      for (const p of e.properties) {
        store.apply({ op: "upsert_property", entity: e.name, property: p.name, ref: p.ref, many: p.many });
      }
    }
    return store;
  }

  apply(op: Op, resolve?: EntityResolver): ApplyResult {
    const changes: string[] = [];
    const { status, reason } = this.dispatch(op, changes, resolve);
    if (changes.length > 0) this.version++;
    if (status === "rejected") return { status, changes, reason };
    return { status: changes.length > 0 ? "applied" : "noop", changes, reason };
  }

  view(): ModelView {
    return {
      entities: this.entities.map((e) => ({
        name: e.name,
        properties: e.properties.map((p) => ({
          name: p.name,
          ref: p.ref ? (this.byId(p.ref)?.name ?? null) : null,
          many: p.many,
        })),
      })),
    };
  }

  /** Freezes the current name → id mapping, for ops that will be applied later. */
  resolver(): EntityResolver {
    const ids = new Map(this.entities.map((e) => [nameKey(e.name), e.id] as const));
    return (name) => ids.get(nameKey(name));
  }

  stats(): { entities: number; properties: number; relations: number } {
    let properties = 0;
    let relations = 0;
    for (const e of this.entities) {
      properties += e.properties.length;
      relations += e.properties.filter((p) => p.ref !== null).length;
    }
    return { entities: this.entities.length, properties, relations };
  }

  private dispatch(op: Op, changes: string[], resolve?: EntityResolver): { status: ApplyStatus; reason?: string } {
    switch (op.op) {
      case "upsert_entity":
        if (!toEntityName(op.entity)) return rejected("empty entity name");
        this.ensure(op.entity, changes, resolve);
        return ok();

      case "upsert_property": {
        const name = toPropertyName(op.property);
        if (!name) return rejected("empty property name");
        const entity = this.ensure(op.entity, changes, resolve);
        if (!entity) return rejected("empty entity name");
        let ref: string | null = null;
        if (op.ref !== null && toEntityName(op.ref)) {
          ref = this.ensure(op.ref, changes, resolve)?.id ?? null;
        }
        const existing = findProperty(entity, name);
        if (!existing) {
          const p: Property = { id: this.newId("p"), name, ref, many: op.many };
          entity.properties.push(p);
          changes.push(`+ ${entity.name}.${p.name}${this.refLabel(p)}`);
        } else if (existing.ref !== ref || existing.many !== op.many) {
          existing.ref = ref;
          existing.many = op.many;
          changes.push(`~ ${entity.name}.${existing.name}${this.refLabel(existing) || " (plain)"}`);
        }
        return ok();
      }

      case "rename_entity": {
        const newName = toEntityName(op.new_name);
        if (!newName) return rejected("empty new name");
        const entity = this.find(op.entity, resolve);
        const target = this.find(op.new_name, resolve);
        if (!entity) return target ? ok("already renamed") : rejected(`no entity "${op.entity}"`);
        if (target && target !== entity) {
          this.merge(entity, target, changes);
          return ok();
        }
        if (entity.name !== newName) {
          changes.push(`${entity.name} → ${newName}`);
          entity.name = newName;
        }
        return ok();
      }

      case "rename_property": {
        const newName = toPropertyName(op.new_name);
        if (!newName) return rejected("empty new name");
        const entity = this.find(op.entity, resolve);
        if (!entity) return rejected(`no entity "${op.entity}"`);
        const prop = findProperty(entity, op.property);
        const clash = findProperty(entity, newName);
        if (!prop) return clash ? ok("already renamed") : rejected(`no property "${entity.name}.${op.property}"`);
        if (clash && clash !== prop) {
          // The new name already exists: fold the old property into it.
          if (clash.ref === null && prop.ref !== null) {
            clash.ref = prop.ref;
            clash.many = prop.many;
          }
          entity.properties = entity.properties.filter((p) => p !== prop);
          changes.push(`${entity.name}.${prop.name} ⇒ ${entity.name}.${clash.name}`);
        } else if (prop.name !== newName) {
          changes.push(`${entity.name}.${prop.name} → ${entity.name}.${newName}`);
          prop.name = newName;
        }
        return ok();
      }

      case "remove_entity": {
        const entity = this.find(op.entity, resolve);
        if (!entity) return ok("not found");
        this.entities = this.entities.filter((e) => e !== entity);
        changes.push(`- ${entity.name}`);
        // Relations pointing at the removed entity go too.
        for (const other of this.entities) {
          const dangling = other.properties.filter((p) => p.ref === entity.id);
          if (dangling.length === 0) continue;
          other.properties = other.properties.filter((p) => p.ref !== entity.id);
          for (const p of dangling) changes.push(`- ${other.name}.${p.name}`);
        }
        return ok();
      }

      case "remove_property": {
        const entity = this.find(op.entity, resolve);
        const prop = entity ? findProperty(entity, op.property) : undefined;
        if (!entity || !prop) return ok("not found");
        entity.properties = entity.properties.filter((p) => p !== prop);
        changes.push(`- ${entity.name}.${prop.name}`);
        return ok();
      }

      case "merge_entities": {
        const from = this.find(op.entity, resolve);
        const into = this.find(op.into, resolve);
        if (!from) return into ? ok("already merged") : rejected(`no entity "${op.entity}"`);
        if (!into) {
          // Merging into something that doesn't exist yet is a rename.
          return this.dispatch({ op: "rename_entity", entity: op.entity, new_name: op.into }, changes, resolve);
        }
        if (from !== into) this.merge(from, into, changes);
        return ok();
      }
    }
  }

  private merge(from: Entity, into: Entity, changes: string[]): void {
    for (const p of from.properties) {
      const same = findProperty(into, p.name);
      if (!same) {
        into.properties.push(p);
      } else if (same.ref === null && p.ref !== null) {
        same.ref = p.ref;
        same.many = p.many;
      }
    }
    for (const e of this.entities) {
      for (const p of e.properties) if (p.ref === from.id) p.ref = into.id;
    }
    this.entities = this.entities.filter((e) => e !== from);
    changes.push(`${from.name} ⇒ ${into.name}`);
  }

  private find(name: string, resolve?: EntityResolver): Entity | undefined {
    const pinned = resolve?.(name);
    if (pinned) {
      const entity = this.byId(pinned);
      if (entity) return entity;
    }
    const key = nameKey(name);
    if (!key) return undefined;
    const exact = this.entities.find((e) => nameKey(e.name) === key);
    if (exact) return exact;
    const loose = looseKey(name);
    return this.entities.find((e) => looseKey(e.name) === loose);
  }

  private ensure(name: string, changes: string[], resolve?: EntityResolver): Entity | undefined {
    const found = this.find(name, resolve);
    if (found) return found;
    const entityName = toEntityName(name);
    if (!entityName) return undefined;
    const entity: Entity = { id: this.newId("e"), name: entityName, properties: [] };
    this.entities.push(entity);
    changes.push(`+ ${entity.name}`);
    return entity;
  }

  private byId(id: string): Entity | undefined {
    return this.entities.find((e) => e.id === id);
  }

  private refLabel(p: Property): string {
    if (p.ref === null) return p.many ? " []" : "";
    return ` → ${this.byId(p.ref)?.name ?? "?"}${p.many ? "[]" : ""}`;
  }

  private newId(prefix: string): string {
    return `${prefix}${this.nextId++}`;
  }
}

function findProperty(entity: Entity, name: string): Property | undefined {
  const key = nameKey(name);
  return entity.properties.find((p) => nameKey(p.name) === key);
}

function ok(reason?: string): { status: ApplyStatus; reason?: string } {
  return { status: "applied", reason };
}

function rejected(reason: string): { status: ApplyStatus; reason: string } {
  return { status: "rejected", reason };
}
