import { useState } from "react";
import { DEFAULT_MODEL } from "../core/extract/models";
import { Activity } from "./Activity";
import { InputPanel } from "./InputPanel";
import type { TextInput } from "./protocol";
import { SettingsDialog } from "./SettingsDialog";
import { type Settings, loadKey, loadSettings, saveKey, saveSettings } from "./settings";
import { useSession } from "./useSession";
import { YamlView } from "./YamlView";

function downloadText(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
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

export function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [apiKey, setApiKey] = useState(() => loadKey("anthropic"));
  const [settingsOpen, setSettingsOpen] = useState(() => !loadKey("anthropic"));
  const { state, start, stop, clear } = useSession();
  const { stats } = state;
  const hasModel = stats.entities > 0;

  function updateSettings(next: Settings) {
    setSettings(next);
    saveSettings(next);
  }

  function updateKey(key: string) {
    setApiKey(key);
    saveKey("anthropic", key);
  }

  function begin(input: TextInput, continueModel: boolean) {
    start({
      type: "start",
      input,
      apiKey,
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
        <span className={`phase phase-${state.phase}`} aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {PHASE_LABEL[state.phase]}
          {state.status ? <span className="status"> · {state.status}</span> : null}
        </span>
        <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </header>

      <main className="layout">
        <InputPanel
          phase={state.phase}
          hasKey={apiKey !== ""}
          hasModel={hasModel}
          wordsPerMinute={settings.wordsPerMinute}
          onWordsPerMinute={(wordsPerMinute) => updateSettings({ ...settings, wordsPerMinute })}
          onStart={begin}
          onStop={stop}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <section className="panel model-panel" aria-label="Model">
          <div className="panel-head">
            <h2>Model</h2>
            <div className="actions">
              <button type="button" className="ghost" disabled={!hasModel} onClick={() => downloadText(state.yaml, "model.yaml")}>
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
        apiKey={apiKey}
        onApiKey={updateKey}
        settings={settings}
        onSettings={updateSettings}
      />
    </div>
  );
}
