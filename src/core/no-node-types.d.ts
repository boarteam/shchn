// Stands in for `undici-types` when core is type-checked on its own (see
// tsconfig.json here). The Anthropic SDK's declarations import undici-types,
// which loads all of Node's types and would let Buffer or process into core
// unnoticed. Nothing in core uses these types; the SDK falls back to its own.
export {};
