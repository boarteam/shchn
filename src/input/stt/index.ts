import { DeepgramStt } from "./deepgram";
import { SonioxStt } from "./soniox";
import type { SttProvider } from "./types";

export type SttName = "soniox" | "deepgram";

/** The provider with its API key from the environment (.env). */
export function createSttProvider(name: SttName): SttProvider {
  const variable = name === "deepgram" ? "DEEPGRAM_API_KEY" : "SONIOX_API_KEY";
  const key = process.env[variable];
  if (!key) throw new Error(`${variable} isn't set. Add it to .env (npm run set-key -- ${variable}).`);
  return name === "deepgram" ? new DeepgramStt(key) : new SonioxStt(key);
}
