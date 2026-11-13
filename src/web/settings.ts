import { DEFAULT_MODEL, type Effort } from "../core/extract/models";

// What this browser remembers: settings and API keys, in localStorage. Storage
// can be blocked (private windows, site data turned off); then nothing is
// remembered and everything still works.

export interface Settings {
  model: string;
  effort: Effort;
  review: boolean;
  wordsPerMinute: number;
}

export const DEFAULT_SETTINGS: Settings = { model: DEFAULT_MODEL, effort: "low", review: true, wordsPerMinute: 150 };

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
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  write("settings", JSON.stringify(settings));
}

/** Keys the app can hold; Soniox and Deepgram join with the microphone. */
export type KeyName = "anthropic";

export function loadKey(name: KeyName): string {
  return read(`key.${name}`) ?? "";
}

export function saveKey(name: KeyName, value: string): void {
  write(`key.${name}`, value.trim() || null);
}
