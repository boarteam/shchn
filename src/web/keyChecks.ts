import { type SttName, createSttProvider } from "../core/input/stt";
import { SAMPLE_RATE } from "../core/input/stt/types";
import type { KeyName } from "./settings";

// Each key is tried before it's saved, like `npm run set-key` does. A check
// returns the problem to show, or undefined when the key works.

async function checkAnthropicKey(key: string): Promise<string | undefined> {
  try {
    // The model list is free.
    const response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (response.ok) return undefined;
    if (response.status === 401 || response.status === 403) return "Anthropic rejected this key.";
    return `Anthropic answered with status ${response.status}. Try again in a moment.`;
  } catch {
    return "Couldn't reach api.anthropic.com. Check the network connection.";
  }
}

/** Opens a stream, sends 100 ms of silence and closes it: a rejected key fails the connection or answers with an error. */
async function checkSttKey(name: SttName, key: string): Promise<string | undefined> {
  const label = name === "deepgram" ? "Deepgram" : "Soniox";
  let problem: string | undefined;
  try {
    const session = await createSttProvider(name, key, "").connect(
      { sampleRate: SAMPLE_RATE, languages: ["en"], terms: [] },
      {
        partial() {},
        final() {},
        endpoint() {},
        error(error) {
          problem ??= error.message;
        },
      },
    );
    session.sendAudio(new Uint8Array((SAMPLE_RATE / 10) * 2));
    await session.finish();
  } catch {
    return `${label} rejected this key, or couldn't be reached.`;
  }
  if (problem && /\b40[13]\b|unauthenticated|unauthorized/i.test(problem)) return `${label} rejected this key.`;
  return problem;
}

export function checkKey(name: KeyName, key: string): Promise<string | undefined> {
  return name === "anthropic" ? checkAnthropicKey(key) : checkSttKey(name, key);
}
