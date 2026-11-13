import { useState } from "react";
import { DEFAULT_MODEL } from "../core/extract/models";
import { Activity } from "./Activity";
import { InputPanel, type PanelInput } from "./InputPanel";
import { type Keys, SettingsDialog } from "./SettingsDialog";
import { type KeyName, STT_PROVIDERS, type Settings, list, loadKey, loadSettings, saveKey, saveSettings } from "./settings";
import { type SessionSpec, useSession } from "./useSession";
import { YamlView } from "./YamlView";

function downloadText(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const PHASE_LABEL = { idle: "ready", running: "running", stopping: "stopping" } as const;

function loadKeys(): Keys {
  return { anthropic: loadKey("anthropic"), soniox: loadKey("soniox"), deepgram: loadKey("deepgram") };
}

export function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [keys, setKeys] = useState(loadKeys);
  const [settingsOpen, setSettingsOpen] = useState(() => !loadKey("anthropic"));
  const { state, start, stop, resume, clear } = useSession();
  const { stats } = state;
  const hasModel = stats.entities > 0;
  const service = STT_PROVIDERS[settings.stt];

  function updateSettings(next: Settings) {
    setSettings(next);
    saveSettings(next);
  }

  function updateKey(name: KeyName, key: string) {
    setKeys((current) => ({ ...current, [name]: key }));
    saveKey(name, key);
  }

  function begin(input: PanelInput, continueModel: boolean) {
    const speech = {
      type: "live" as const,
      stt: settings.stt,
      sttKey: keys[settings.stt],
      languages: list(settings.languages),
      terms: list(settings.terms),
      pauseAfterSeconds: settings.pauseAfterSeconds,
    };
    const sessionInput: SessionSpec["input"] =
      input.type === "microphone"
        ? { ...speech, audio: { kind: "microphone", deviceId: settings.microphoneId } }
        : input.type === "recording"
          ? { ...speech, audio: { kind: "recording", file: input.file } }
          : input;
    void start({
      input: sessionInput,
      apiKey: keys.anthropic,
      claude: { model: settings.model.trim() || DEFAULT_MODEL, effort: settings.effort, thinking: "auto", fast: false },
      review: { enabled: settings.review, everySeconds: 45, effort: "medium" },
      resumeYaml: continueModel ? state.yaml : undefined,
    });
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>shchn</h1>
        <span className="stats">
          {count(stats.entities, "entity", "entities")} · {count(stats.properties, "property", "properties")} ·{" "}
          {count(stats.relations, "relation", "relations")}
        </span>
        <span className={`phase phase-${state.paused !== undefined ? "paused" : state.phase}`} aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {state.paused !== undefined ? "paused" : PHASE_LABEL[state.phase]}
          {state.status ? <span className="status"> · {state.status}</span> : null}
        </span>
        <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </header>

      <main className="layout">
        <InputPanel
          phase={state.phase}
          source={settings.source}
          onSource={(source) => updateSettings({ ...settings, source })}
          hasKey={keys.anthropic !== ""}
          hasModel={hasModel}
          wordsPerMinute={settings.wordsPerMinute}
          onWordsPerMinute={(wordsPerMinute) => updateSettings({ ...settings, wordsPerMinute })}
          speech={{
            serviceLabel: service.label,
            hasServiceKey: keys[settings.stt] !== "",
            microphoneId: settings.microphoneId,
            onMicrophoneId: (microphoneId) => updateSettings({ ...settings, microphoneId }),
            terms: settings.terms,
            onTerms: (terms) => updateSettings({ ...settings, terms }),
            paused: state.paused,
            onResume: () => void resume(),
          }}
          onStart={begin}
          onStop={stop}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <section className="panel model-panel" aria-label="Model">
          <div className="panel-head">
            <h2>Model</h2>
            <div className="actions">
              {state.transcript && state.phase === "idle" ? (
                <button type="button" className="ghost" onClick={() => downloadText(state.transcript, "model.transcript.txt", "text/plain")}>
                  Download transcript
                </button>
              ) : null}
              <button type="button" className="ghost" disabled={!hasModel} onClick={() => downloadText(state.yaml, "model.yaml", "application/yaml")}>
                Download YAML
              </button>
              <button type="button" className="ghost" disabled={!hasModel || state.phase !== "idle"} onClick={clear}>
                Clear
              </button>
            </div>
          </div>
          <YamlView yaml={state.yaml} />
        </section>

        <Activity state={state} />
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        keys={keys}
        onKey={updateKey}
        settings={settings}
        onSettings={updateSettings}
      />
    </div>
  );
}
