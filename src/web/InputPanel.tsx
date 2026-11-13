import { type DragEvent, useState } from "react";
import shopTranscript from "../../examples/shop.en.txt?raw";
import trackerTranscript from "../../examples/tracker.ru.txt?raw";
import type { TextInput } from "./protocol";

// What to feed the session: a transcript played at speaking speed (as if
// someone were saying it), or requirements and code files read at once.

const EXAMPLES = [
  { name: "Online shop (English)", text: shopTranscript },
  { name: "Issue tracker (Russian, English terms)", text: trackerTranscript },
];

interface DocumentFile {
  name: string;
  size: number;
  text: string;
}

interface Props {
  phase: "idle" | "running" | "stopping";
  hasKey: boolean;
  /** There's a model to continue from. */
  hasModel: boolean;
  wordsPerMinute: number;
  onWordsPerMinute(value: number): void;
  onStart(input: TextInput, continueModel: boolean): void;
  onStop(): void;
  onOpenSettings(): void;
}

function kilobytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function InputPanel({ phase, hasKey, hasModel, wordsPerMinute, onWordsPerMinute, onStart, onStop, onOpenSettings }: Props) {
  const [source, setSource] = useState<"transcript" | "files">("transcript");
  const [transcript, setTranscript] = useState("");
  const [files, setFiles] = useState<DocumentFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [continueModel, setContinueModel] = useState(false);
  const running = phase !== "idle";

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const read = await Promise.all([...list].map(async (file) => ({ name: file.name, size: file.size, text: await file.text() })));
    setFiles((current) => [...current.filter((f) => !read.some((r) => r.name === f.name)), ...read]);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  }

  const ready = source === "transcript" ? transcript.trim().length > 0 : files.length > 0;

  function start() {
    const input: TextInput =
      source === "transcript"
        ? { type: "replay", text: transcript, wordsPerMinute }
        : { type: "documents", files: files.map(({ name, text }) => ({ name, text })) };
    onStart(input, continueModel && hasModel);
  }

  return (
    <section className="panel input-panel" aria-label="Input">
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={source === "transcript"}
          disabled={running}
          onClick={() => setSource("transcript")}
        >
          Transcript
        </button>
        <button type="button" role="tab" aria-selected={source === "files"} disabled={running} onClick={() => setSource("files")}>
          Files
        </button>
      </div>

      <div className="input-body">
        {source === "transcript" ? (
          <>
            <p className="hint">Paste what someone said. It's played word by word at speaking speed, as in a live session.</p>
            <textarea
              value={transcript}
              disabled={running}
              placeholder="A customer has a name and an email. Each order belongs to one customer…"
              aria-label="Transcript"
              onChange={(event) => setTranscript(event.target.value)}
            />
            <div className="row">
              <select
                aria-label="Load an example"
                value=""
                disabled={running}
                onChange={(event) => {
                  const example = EXAMPLES[Number(event.target.value)];
                  if (example) setTranscript(example.text.trim());
                }}
              >
                <option value="" disabled>
                  Load an example…
                </option>
                {EXAMPLES.map((example, i) => (
                  <option key={example.name} value={i}>
                    {example.name}
                  </option>
                ))}
              </select>
              <label className="inline">
                <input
                  type="number"
                  min={30}
                  max={600}
                  step={10}
                  value={wordsPerMinute}
                  disabled={running}
                  onChange={(event) => onWordsPerMinute(Math.max(30, Number(event.target.value) || 150))}
                />
                <span>words/min</span>
              </label>
            </div>
          </>
        ) : (
          <>
            <p className="hint">Requirements, specs or source code. Read all at once; code files are treated as code.</p>
            <label
              className={`dropzone${dragging ? " dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input
                type="file"
                multiple
                disabled={running}
                onChange={(event) => {
                  void addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <span>Drop files here or click to choose</span>
            </label>
            {files.length > 0 ? (
              <ul className="files">
                {files.map((file) => (
                  <li key={file.name}>
                    <span className="file-name">{file.name}</span>
                    <span className="file-size">{kilobytes(file.size)}</span>
                    <button
                      type="button"
                      className="link"
                      disabled={running}
                      aria-label={`Remove ${file.name}`}
                      onClick={() => setFiles((current) => current.filter((f) => f.name !== file.name))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>

      <div className="input-foot">
        <label className="check">
          <input
            type="checkbox"
            checked={continueModel && hasModel}
            disabled={running || !hasModel}
            onChange={(event) => setContinueModel(event.target.checked)}
          />
          <span>Continue from the current model</span>
        </label>
        {!hasKey ? (
          <p className="hint">
            Add your Anthropic API key in{" "}
            <button type="button" className="link" onClick={onOpenSettings}>
              Settings
            </button>{" "}
            to start.
          </p>
        ) : !ready && !running ? (
          <p className="hint">{source === "transcript" ? "Paste a transcript or load an example to start." : "Add files to start."}</p>
        ) : null}
        {running ? (
          <button type="button" className="primary danger" onClick={onStop}>
            {phase === "stopping" ? "Stop now" : "Stop"}
          </button>
        ) : (
          <button type="button" className="primary" disabled={!ready || !hasKey} onClick={start}>
            Start
          </button>
        )}
      </div>
    </section>
  );
}
