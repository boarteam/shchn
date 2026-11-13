import { describe, expect, it } from "vitest";
import { scoreModel } from "../src/core/eval/score";
import { deepgramUrl, handleDeepgramMessage } from "../src/core/input/stt/deepgram";
import { handleSonioxMessage, sonioxConfig } from "../src/core/input/stt/soniox";
import type { SttEvents } from "../src/core/input/stt/types";
import { parseModelYaml } from "../src/core/model/yaml";

function recorder() {
  const events: string[] = [];
  const sink: SttEvents = {
    partial: (text) => events.push(`partial:${text}`),
    final: (text, endMs) => events.push(`final:${text}@${endMs}`),
    endpoint: () => events.push("endpoint"),
    error: (error) => events.push(`error:${error.message}`),
  };
  return { events, sink };
}

describe("scoreModel", () => {
  it("scores entities, attributes and relation links separately", () => {
    const expected = parseModelYaml(
      "entities:\n  Order:\n    properties:\n      total: {}\n      customer: Customer\n  Customer:\n    properties:\n      name: {}\n",
    );
    const actual = parseModelYaml(
      "entities:\n  Order:\n    properties:\n      total: {}\n      buyer: Customer\n      note: {}\n  Customers:\n    properties: {}\n",
    );
    const score = scoreModel(actual, expected);
    expect(score.entities.f1).toBe(1); // "Customers" matches "Customer"
    expect(score.relations.f1).toBe(1); // Order → Customer, whatever the property is called
    expect(score.attributes.precision).toBe(0.5);
    expect(score.attributes.missing).toEqual(["Customer.name"]);
    expect(score.attributes.extra).toEqual(["Order.note"]);
  });
});

describe("Soniox", () => {
  it("emits final text once, replaces partial text, and reports pauses", () => {
    const { events, sink } = recorder();
    handleSonioxMessage(
      {
        tokens: [
          { text: "У", is_final: true, end_ms: 200 },
          { text: " User", is_final: true, end_ms: 600 },
          { text: " есть", is_final: false },
        ],
      },
      sink,
    );
    handleSonioxMessage({ tokens: [{ text: " есть email.", is_final: true, end_ms: 1400 }, { text: "<end>", is_final: true }] }, sink);
    expect(events).toEqual(["final:У User@600", "partial: есть", "final: есть email.@1400", "partial:", "endpoint"]);
  });

  it("reports errors and ends the stream", () => {
    const { events, sink } = recorder();
    const result = handleSonioxMessage({ tokens: [], error_code: 401, error_type: "unauthenticated", error_message: "bad key" }, sink);
    expect(result.finished).toBe(true);
    expect(events[0]).toContain("401");
  });

  it("builds the config for raw PCM with endpoint detection", () => {
    const config = sonioxConfig("stt-rt-v6", { sampleRate: 16000, languages: ["ru", "en"], terms: ["OrderItem"] });
    expect(config).toMatchObject({
      model: "stt-rt-v6",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ["ru", "en"],
      enable_endpoint_detection: true,
      context: { terms: ["OrderItem"] },
    });
    expect(config).not.toHaveProperty("api_key");
  });
});

describe("Deepgram", () => {
  it("turns results and utterance ends into events", () => {
    const { events, sink } = recorder();
    handleDeepgramMessage({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "у user" }] } }, sink);
    handleDeepgramMessage(
      {
        type: "Results",
        is_final: true,
        start: 0,
        duration: 2,
        channel: { alternatives: [{ transcript: "у user есть email", words: [{ end: 1.5 }] }] },
      },
      sink,
    );
    handleDeepgramMessage({ type: "UtteranceEnd", last_word_end: 1.5 }, sink);
    handleDeepgramMessage({ type: "UtteranceEnd", last_word_end: -1 }, sink);
    expect(events).toEqual(["partial:у user", "final:у user есть email @1500", "partial:", "endpoint"]);
  });

  it("uses multilingual mode with hints for several languages, and plain mode for one", () => {
    const multi = new URL(deepgramUrl({ sampleRate: 16000, languages: ["ru", "en"], terms: ["Order Item", "SKU"] }));
    expect(multi.searchParams.get("language")).toBe("multi");
    expect(multi.searchParams.getAll("language_hint")).toEqual(["ru", "en"]);
    expect(multi.searchParams.getAll("keyterm")).toEqual(["Order Item", "SKU"]);
    const english = new URL(deepgramUrl({ sampleRate: 16000, languages: ["en"], terms: [] }));
    expect(english.searchParams.get("language")).toBe("en");
    expect(english.searchParams.has("language_hint")).toBe(false);
  });
});

