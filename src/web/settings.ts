import { DEFAULT_MODEL, type Effort } from "../core/extract/models";
import type { SttName } from "../core/input/stt";

// What this browser remembers: settings and API keys, in localStorage. Storage
// can be blocked (private windows, site data turned off); then nothing is
// remembered and everything still works.

export type InputSource = "microphone" | "transcript" | "files";

export interface Settings {
  model: string;
  effort: Effort;
  review: boolean;
  wordsPerMinute: number;
  stt: SttName;
  /** Languages spoken, comma separated, as `--lang`. */
  languages: string;
  /** Vocabulary hints, comma separated, as `--terms`. */
  terms: string;
  /** Seconds without speech before the microphone turns off; 0 = never. */
  pauseAfterSeconds: number;
  /** The chosen input; "" for the system default. */
  microphoneId: string;
  /** The input tab last used. */
  source: InputSource;
}

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL,
  effort: "low",
  review: true,
  wordsPerMinute: 150,
  stt: "soniox",
  languages: "ru, en",
  terms: "",
  pauseAfterSeconds: 20,
  microphoneId: "",
  source: "transcript",
};

export const STT_PROVIDERS: Readonly<Record<SttName, { label: string; console: string }>> = {
  soniox: { label: "Soniox", console: "https://console.soniox.com" },
  deepgram: { label: "Deepgram", console: "https://console.deepgram.com" },
};

/** "ru, en" → ["ru", "en"] */
export function list(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"];
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

const PREFIX = "shchn.";

function read(name: string): string | null {
  try {
    return localStorage.getItem(PREFIX + name);
  } catch {
    return null;
  }
}

function write(name: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + name);
    else localStorage.setItem(PREFIX + name, value);
  } catch {
    // not remembered; the page keeps working
  }
}

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(read("settings") ?? "{}") as Partial<Settings>;
    const settings = { ...DEFAULT_SETTINGS, ...saved };
    if (!(settings.stt in STT_PROVIDERS)) settings.stt = DEFAULT_SETTINGS.stt;
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  write("settings", JSON.stringify(settings));
}

export type KeyName = "anthropic" | SttName;

export function loadKey(name: KeyName): string {
  return read(`key.${name}`) ?? "";
}

export function saveKey(name: KeyName, value: string): void {
  write(`key.${name}`, value.trim() || null);
}
