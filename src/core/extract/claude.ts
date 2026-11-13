import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { OPS_SCHEMA, type Op, parseOp } from "../model/ops";
import {
  type Effort,
  type ThinkingMode,
  type TokenUsage,
  supportsFastMode,
  supportsServerFallback,
  thinkingFor,
} from "./models";
import { OpsStreamParser } from "./opsStream";
import { SYSTEM_PROMPT } from "./prompt";

export interface CallStats {
  /** The model that served the response (differs from the requested one after a fallback). */
  model: string;
  stopReason: string | null;
  /** Request start → first content block (thinking or text). */
  firstTokenMs?: number;
  /** Request start → first complete op. */
  firstOpMs?: number;
  totalMs: number;
  ops: number;
  usage: TokenUsage;
}

/** Runs one extraction call, calling `onOp` for each op the moment it's complete. */
export interface OpsSource {
  run(userMessage: string, onOp: (op: Op) => void, options?: { effort?: Effort }): Promise<CallStats>;
}

export interface ClaudeConfig {
  model: string;
  effort: Effort;
  thinking: ThinkingMode;
  fast: boolean;
  timeoutMs?: number;
}

export class ClaudeOpsSource implements OpsSource {
  /** Setup problems worth telling the user about once. */
  readonly warnings: string[] = [];
  private readonly thinking?: Anthropic.Beta.Messages.BetaThinkingConfigParam;
  private readonly fast: boolean;

  constructor(
    private readonly client: Anthropic,
    private readonly config: ClaudeConfig,
    private readonly onWarning: (message: string) => void = () => {},
  ) {
    const thinking = thinkingFor(config.model, config.thinking);
    this.thinking = thinking.param;
    if (thinking.warning) this.warnings.push(thinking.warning);
    this.fast = config.fast && supportsFastMode(config.model);
    if (config.fast && !this.fast) this.warnings.push(`fast mode isn't available for ${config.model}; ignoring --fast`);
  }

  async run(userMessage: string, onOp: (op: Op) => void, options: { effort?: Effort } = {}): Promise<CallStats> {
    const started = performance.now();
    const params: BetaMessageStreamParams = {
      model: this.config.model,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }],
      output_config: {
        effort: options.effort ?? this.config.effort,
        format: { type: "json_schema", schema: OPS_SCHEMA },
      },
      ...(this.thinking ? { thinking: this.thinking } : {}),
      ...(this.fast ? { speed: "fast" as const } : {}),
      // A declined request is retried server-side on the recommended fallback model.
      ...(supportsServerFallback(this.config.model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    };

    const stream = this.client.beta.messages.stream(params, { timeout: this.config.timeoutMs ?? 60_000 });
    const parser = new OpsStreamParser();
    let firstTokenMs: number | undefined;
    let firstOpMs: number | undefined;
    let ops = 0;

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        firstTokenMs ??= performance.now() - started;
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        let completed: unknown[];
        try {
          completed = parser.push(event.delta.text);
        } catch (err) {
          this.onWarning(`unreadable model output: ${(err as Error).message}`);
          continue;
        }
        for (const raw of completed) {
          const op = parseOp(raw);
          if (!op) {
            this.onWarning(`skipped malformed op ${JSON.stringify(raw)}`);
            continue;
          }
          firstOpMs ??= performance.now() - started;
          ops++;
          onOp(op);
        }
      }
    }

    const message = await stream.finalMessage();
    return {
      model: message.model,
      stopReason: message.stop_reason,
      firstTokenMs,
      firstOpMs,
      totalMs: performance.now() - started,
      ops,
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
        cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
