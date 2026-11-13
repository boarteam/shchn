// Name normalization. Entities are PascalCase (OrderItem), properties snake_case
// (created_at). Matching ignores case and separators, so "order item",
// "order_item" and "OrderItem" all name the same thing.

const WORD = /[\p{L}\p{N}]+/gu;

/** Splits an identifier or phrase into words, including camelCase boundaries. */
export function words(raw: string): string[] {
  const spaced = raw
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2") // orderItem -> order Item
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2"); // HTTPRequest -> HTTP Request
  return spaced.match(WORD) ?? [];
}

export function toEntityName(raw: string): string {
  return words(raw)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

export function toPropertyName(raw: string): string {
  return words(raw)
    .map((w) => w.toLowerCase())
    .join("_");
}

/** Comparison key: case- and separator-insensitive. */
export function nameKey(raw: string): string {
  return words(raw).join("").toLowerCase();
}

/** A looser key that also ignores a simple English plural. Only a fallback for matching. */
export function looseKey(raw: string): string {
  const key = nameKey(raw);
  if (key.length > 4 && key.endsWith("ies")) return `${key.slice(0, -3)}y`;
  if (key.length > 3 && key.endsWith("s") && !key.endsWith("ss")) return key.slice(0, -1);
  return key;
}
