import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { Effort } from "../core/extract/models";
import type { SttName } from "../core/input/stt";
import { checkKey } from "./keyChecks";
import { EFFORTS, type KeyName, MODELS, STT_PROVIDERS, type Settings } from "./settings";

export type Keys = Record<KeyName, string>;

interface Props {
  open: boolean;
  onClose(): void;
  keys: Keys;
  onKey(name: KeyName, key: string): void;
  settings: Settings;
  onSettings(settings: Settings): void;
}

type Check = { state: "idle" } | { state: "checking" } | { state: "saved" } | { state: "failed"; message: string };

/** One API key: shows the saved one by its last characters, and checks a new one before saving it. */
function KeyField({
  name,
  label,
  placeholder,
  saved,
  onKey,
  resetToken,
  children,
}: {
  name: KeyName;
  label: string;
  placeholder: string;
  saved: string;
  onKey(name: KeyName, key: string): void;
  /** Changes when the dialog opens, to clear what was typed last time. */
  resetToken: number;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<Check>({ state: "idle" });

  useEffect(() => {
    setDraft("");
    setCheck({ state: "idle" });
  }, [resetToken, name]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const key = draft.trim();
    if (!key) return;
    setCheck({ state: "checking" });
    const problem = await checkKey(name, key);
    if (problem) {
      setCheck({ state: "failed", message: problem });
      return;
    }
    onKey(name, key);
    setDraft("");
    setCheck({ state: "saved" });
  }

  return (
    <>
      <p className="hint">{children}</p>
      {saved ? (
        <p className="saved-key">
          Saved key ending in <code>{saved.slice(-4)}</code>
          <button type="button" className="link" onClick={() => onKey(name, "")}>
            Remove
          </button>
        </p>
      ) : null}
      <form className="key-form" onSubmit={save}>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={saved ? "Replace with another key" : placeholder}
          aria-label={`${label} API key`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={!draft.trim() || check.state === "checking"}>
          {check.state === "checking" ? "Checking…" : "Check and save"}
        </button>
      </form>
      {check.state === "failed" ? <p className="error">{check.message}</p> : null}
      {check.state === "saved" ? <p className="ok">The key works and is saved.</p> : null}
    </>
  );
}

export function SettingsDialog({ open, onClose, keys, onKey, settings, onSettings }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(0);
  const provider = { name: settings.stt, ...STT_PROVIDERS[settings.stt] };

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setOpened((n) => n + 1);
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

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
        <KeyField name="anthropic" label="Anthropic" placeholder="sk-ant-…" saved={keys.anthropic} onKey={onKey} resetToken={opened}>
          Kept in this browser only, and sent only to api.anthropic.com. Create one in the{" "}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            Anthropic Console
          </a>
          .
        </KeyField>
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

      <section>
        <h3>Speech to text</h3>
        <label className="field">
          <span>Service</span>
          <select value={settings.stt} onChange={(event) => onSettings({ ...settings, stt: event.target.value as SttName })}>
            {Object.entries(STT_PROVIDERS).map(([name, p]) => (
              <option key={name} value={name}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <KeyField
          name={provider.name}
          label={provider.label}
          placeholder={`${provider.label} API key`}
          saved={keys[provider.name]}
          onKey={onKey}
          resetToken={opened}
        >
          For the microphone and recordings. Audio goes straight from this browser to {provider.label}. Get a key in the{" "}
          <a href={provider.console} target="_blank" rel="noreferrer">
            {provider.label} Console
          </a>
          .
        </KeyField>
        <label className="field">
          <span>Languages</span>
          <input
            spellCheck={false}
            placeholder="ru, en"
            value={settings.languages}
            onChange={(event) => onSettings({ ...settings, languages: event.target.value })}
          />
        </label>
        <p className="hint field-hint">Language codes spoken, comma separated. Several can be mixed in one sentence.</p>
        <label className="field">
          <span>Auto-pause</span>
          <span className="inline-field">
            <input
              type="number"
              min={0}
              max={600}
              step={5}
              value={settings.pauseAfterSeconds}
              onChange={(event) => onSettings({ ...settings, pauseAfterSeconds: Math.max(0, Number(event.target.value) || 0) })}
            />
            <span>s without speech turns the microphone off (0: never)</span>
          </span>
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
