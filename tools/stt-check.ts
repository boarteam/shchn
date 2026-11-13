// Checks that a speech-to-text key works, without a microphone.
//
//   npm run debug:stt-check -- [--stt soniox|deepgram]
//
// Connects with the key from .env, sends one second of silence and closes.
// Prints whether the connection opened and any error the service returned
// (a bad key, an exhausted balance). Costs a second of audio time.

import { parseArgs } from "node:util";
import { sttProviderFromEnv } from "../src/cli/keys";
import type { SttName } from "../src/core/input/stt";
import { fail, loadEnv } from "./lib/cli";

const { values } = parseArgs({ options: { stt: { type: "string", default: "soniox" } } });
if (values.stt !== "soniox" && values.stt !== "deepgram") fail("--stt must be soniox or deepgram");
loadEnv();

let problem: string | undefined;
try {
  const provider = sttProviderFromEnv(values.stt as SttName);
  const session = await provider.connect(
    { sampleRate: 16_000, languages: ["en"], terms: [] },
    { partial() {}, final() {}, endpoint() {}, error: (e) => (problem ??= e.message) },
  );
  console.log(`${provider.name}: connected`);
  session.sendAudio(new Uint8Array(32_000)); // one second of 16 kHz, 16-bit silence
  await session.finish();
} catch (error) {
  problem = (error as Error).message;
}
console.log(problem ? `problem: ${problem}` : "key accepted, no errors");
process.exit(problem ? 1 : 0);
