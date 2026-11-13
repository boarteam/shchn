import type Anthropic from "@anthropic-ai/sdk";

// Per-model request settings. The defaults favor latency: low effort on the
// default model; the other knobs exist so models can be compared on the same
// transcripts (`replay --expect`).

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingMode = "auto" | "off";
type ThinkingParam = Anthropic.Beta.Messages.BetaThinkingConfigParam;

export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * The thinking setting to send, or undefined to leave it out (adaptive).
 * "off" maps to whatever each model accepts; Opus 5.5 and the Fable/Mythos
 * models can't turn thinking off, so there the knob is effort.
 */
export function thinkingFor(model: string, mode: ThinkingMode): { param?: ThinkingParam; warning?: string } {
  if (mode === "auto") return {};
  if (/^claude-sonnet-5-5/.test(model)) return { param: { type: "between_tools" } };
  if (/^claude-(opus-5-5|fable|mythos)/.test(model)) {
    return { warning: `${model} can't turn thinking off; lower --effort instead` };
  }
  return { param: { type: "disabled" } };
}

/** Server-side refusal fallback (`fallbacks: "default"`); Haiku has none. */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(opus-5|sonnet-5-5|fable-5|mythos-5)/.test(model);
}

/** `speed: "fast"` without a beta flag. */
export function supportsFastMode(model: string): boolean {
  return /^claude-(opus-5-5|fable-5-2|mythos-5-2)$/.test(model);
}

// USD per million tokens: input, output, cache read, cache write. Cached
// 2026-11 from Anthropic's price list; only used for the rough cost line.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "claude-fable-5-2": [8, 40, 0.2, 10],
};

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function estimateCostUsd(model: string, usage: TokenUsage, fast: boolean): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  const [input, output, cacheRead, cacheWrite] = price;
  const multiplier = fast ? 2 : 1;
  return (
    (multiplier *
      (usage.input * input + usage.output * output + usage.cacheRead * cacheRead + usage.cacheWrite * cacheWrite)) /
    1e6
  );
}
