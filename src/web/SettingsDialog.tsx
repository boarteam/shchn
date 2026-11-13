import { type FormEvent, useEffect, useRef, useState } from "react";
import type { Effort } from "../core/extract/models";
import { EFFORTS, MODELS, type Settings } from "./settings";

/** Tries the key on the free model list, like `npm run set-key`. Returns the problem, if any. */
async function checkAnthropicKey(key: string): Promise<string | undefined> {
  try {
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

interface Props {
  open: boolean;
  onClose(): void;
  apiKey: string;
  onApiKey(key: string): void;
  settings: Settings;
  onSettings(settings: Settings): void;
}

type Check = { state: "idle" } | { state: "checking" } | { state: "saved" } | { state: "failed"; message: string };

export function SettingsDialog({ open, onClose, apiKey, onApiKey, settings, onSettings }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<Check>({ state: "idle" });

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setDraft("");
      setCheck({ state: "idle" });
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    const key = draft.trim();
    if (!key) return;
    setCheck({ state: "checking" });
    const problem = await checkAnthropicKey(key);
    if (problem) {
      setCheck({ state: "failed", message: problem });
      return;
    }
    onApiKey(key);
    setDraft("");
    setCheck({ state: "saved" });
  }

  return (
    <dialog ref={dialog} className="settings" onClose={onClose} aria-labelledby="settings-title">
      <div className="settings-head">
        <h2 id="settings-title">Settings</h2>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <section>
        <h3>Anthropic API key</h3>
        <p className="hint">
          Kept in this browser only, and sent only to api.anthropic.com. Create one in the{" "}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            Anthropic Console
          </a>
          .
        </p>
        {apiKey ? (
          <p className="saved-key">
            Saved key ending in <code>{apiKey.slice(-4)}</code>
            <button type="button" className="link" onClick={() => onApiKey("")}>
              Remove
            </button>
          </p>
        ) : null}
        <form className="key-form" onSubmit={saveKey}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={apiKey ? "Replace with another key" : "sk-ant-…"}
            aria-label="Anthropic API key"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={!draft.trim() || check.state === "checking"}>
            {check.state === "checking" ? "Checking…" : "Check and save"}
          </button>
        </form>
        {check.state === "failed" ? <p className="error">{check.message}</p> : null}
        {check.state === "saved" ? <p className="ok">The key works and is saved.</p> : null}
      </section>

      <section>
        <h3>Extraction</h3>
        <label className="field">
          <span>Model</span>
          <input
            list="models"
            spellCheck={false}
            value={settings.model}
            onChange={(event) => onSettings({ ...settings, model: event.target.value })}
          />
          <datalist id="models">
            {MODELS.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Effort</span>
          <select value={settings.effort} onChange={(event) => onSettings({ ...settings, effort: event.target.value as Effort })}>
            {EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.review}
            onChange={(event) => onSettings({ ...settings, review: event.target.checked })}
          />
          <span>Review pass: rereads the whole text to merge duplicates and add missed relations</span>
        </label>
      </section>

      <div className="settings-foot">
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  );
}
