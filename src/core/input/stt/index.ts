import { DeepgramStt } from "./deepgram";
import { SonioxStt } from "./soniox";
import type { SttProvider } from "./types";

export type SttName = "soniox" | "deepgram";

/** The provider by name. Where the key comes from is up to the platform (the CLI reads .env). */
export function createSttProvider(name: SttName, apiKey: string): SttProvider {
  return name === "deepgram" ? new DeepgramStt(apiKey) : new SonioxStt(apiKey);
}
