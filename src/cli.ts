import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatScore, scoreModel } from "./eval/score";
import { DEFAULT_MODEL, type Effort, type ThinkingMode } from "./extract/models";
import { micCheck } from "./input/micCheck";
import { parseModelYaml } from "./model/yaml";
import { type Command, runSession, sideLogPath } from "./session";

const USAGE = `shchn: turns speech, requirements or code into a live YAML model of entities and relations

Usage:
  ./shchn file <path...>          extract from documents or source code
  ./shchn replay <transcript>     play a transcript at speaking speed (simulated live session)
  ./shchn live                    listen to the microphone through cloud speech-to-text
  ./shchn stdin                   read text from stdin as it arrives
  ./shchn score <actual.yaml> <expected.yaml>
  ./shchn mic                     check your microphone's level, channel by channel

Output:
  -o, --out <file>         YAML model, rewritten on every change (default: model.yaml)
      --log <file>         edit log with the text each edit came from (default: <out>.ops.jsonl; "none" to skip)
      --view               redraw the model in the terminal, highlighting changes
      --resume             continue from the model already in --out

Extraction:
      --model <id>         Claude model (default: ${DEFAULT_MODEL})
      --effort <level>     low | medium | high | xhigh | max (default: low)
      --thinking <mode>    auto | off; off only where the model allows it (default: auto)
      --fast               fast mode, about 2x the speed and the price (Opus 5.5)
      --no-review          skip the review pass that fixes duplicates and missed relations
      --review-every <s>   seconds between review passes during live input (default: 45)
      --review-effort <l>  effort for review passes (default: medium)

Replay:
      --wpm <n>            speaking speed in words per minute (default: 150)
      --expect <file>      score the final model against a hand-written YAML

Live:
      --stt <provider>     soniox | deepgram (default: soniox)
      --lang <codes>       languages spoken, comma separated (default: ru,en)
      --terms <words>      vocabulary hints for recognition, comma separated
      --audio <file>       stream an audio file in real time instead of the microphone
      --save-audio         keep the session's audio as <out>.audio.wav
      --pause-after <s>    turn the microphone off after this much silence until you
                           press Enter (default: 20; 0 = never)
      --channel <n>        use one input channel of an audio interface (see ./shchn mic)
      --device <name>      a microphone other than the system default (macOS: an index from
                           ffmpeg -f avfoundation -list_devices true -i ""). Uses ffmpeg, which
                           on macOS loses ~6% of the audio; prefer changing the default input

Keys go in .env: ANTHROPIC_API_KEY, plus SONIOX_API_KEY or DEEPGRAM_API_KEY for live.
npm run set-key [-- NAME] writes one there with hidden input.`;

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

function fail(message: string): never {
  process.stderr.write(`${message}\n\nRun with --help for usage.\n`);
  process.exit(2);
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) fail(`--${name} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function positiveNumber(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number`);
  return n;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      out: { type: "string", short: "o", default: "model.yaml" },
      log: { type: "string" },
      view: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      model: { type: "string", default: DEFAULT_MODEL },
      effort: { type: "string", default: "low" },
      thinking: { type: "string", default: "auto" },
      fast: { type: "boolean", default: false },
      review: { type: "boolean", default: true },
      "review-every": { type: "string", default: "45" },
      "review-effort": { type: "string", default: "medium" },
      wpm: { type: "string", default: "150" },
      expect: { type: "string" },
      stt: { type: "string", default: "soniox" },
      lang: { type: "string", default: "ru,en" },
      terms: { type: "string", default: "" },
      audio: { type: "string" },
      device: { type: "string" },
      channel: { type: "string" },
      "save-audio": { type: "boolean", default: false },
      "pause-after": { type: "string", default: "20" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, ...args] = positionals;
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (command === "mic") return micCheck(values.device);

  if (command === "score") {
    const [actual, expected] = args;
    if (!actual || !expected) fail("score needs two files: <actual.yaml> <expected.yaml>");
    const score = scoreModel(parseModelYaml(readFileSync(actual, "utf8")), parseModelYaml(readFileSync(expected, "utf8")));
    process.stdout.write(`${formatScore(score)}\n`);
    return 0;
  }

  if (!["file", "stdin", "replay", "live"].includes(command)) fail(`unknown command "${command}"`);
  if (command === "file" && args.length === 0) fail("file needs at least one path");
  if (command === "replay" && args.length !== 1) fail("replay needs one transcript file");
  for (const path of [...args, ...(values.audio ? [values.audio] : []), ...(values.expect ? [values.expect] : [])]) {
    if (!existsSync(path)) fail(`no such file: ${path}`);
  }

  return runSession({
    command: command as Command,
    inputs: args,
    out: values.out,
    log: values.log === "none" ? null : (values.log ?? sideLogPath(values.out)),
    view: values.view,
    resume: values.resume,
    claude: {
      model: values.model,
      effort: oneOf("effort", values.effort, EFFORTS),
      thinking: oneOf<ThinkingMode>("thinking", values.thinking, ["auto", "off"]),
      fast: values.fast,
    },
    review: {
      enabled: values.review,
      everySeconds: positiveNumber("review-every", values["review-every"]),
      effort: oneOf("review-effort", values["review-effort"], EFFORTS),
    },
    wordsPerMinute: positiveNumber("wpm", values.wpm),
    expect: values.expect,
    stt: oneOf("stt", values.stt, ["soniox", "deepgram"] as const),
    languages: list(values.lang),
    terms: list(values.terms),
    audio: values.audio,
    device: values.device,
    saveAudio: values["save-audio"],
    pauseAfterSeconds: values["pause-after"] === "0" ? 0 : positiveNumber("pause-after", values["pause-after"]),
    channel: values.channel === undefined ? undefined : positiveNumber("channel", values.channel),
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
