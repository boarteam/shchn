import { type SttName, createSttProvider } from "../core/input/stt";
import type { SttProvider } from "../core/input/stt/types";

/** Tells the user where the Claude key goes, after an authentication error. */
export const CLAUDE_KEY_HINT = "Set ANTHROPIC_API_KEY in .env (see .env.example).";

/** The speech-to-text provider with its key from the environment (.env). */
export function sttProviderFromEnv(name: SttName): SttProvider {
  const variable = name === "deepgram" ? "DEEPGRAM_API_KEY" : "SONIOX_API_KEY";
  const key = process.env[variable];
  if (!key) throw new Error(`${variable} isn't set. Add it to .env (npm run set-key -- ${variable}).`);
  return createSttProvider(name, key);
}
