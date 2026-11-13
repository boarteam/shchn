import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type InputDevice, type Microphone, listMicrophones, micLevel, microphoneProblem, openMicrophone } from "./microphone";
import { meterLevel } from "./pcm";

// The microphone input: which device, a level meter (with a test before
// starting, like `./shchn mic`), vocabulary hints, and a recording to play
// instead of speaking, like `live --audio`.

export function LevelMeter({ active }: { active: boolean }) {
  const peak = useSyncExternalStore(micLevel.subscribe, micLevel.get);
  const level = active ? meterLevel(peak) : 0;
  return (
    <div className={`meter${active ? " active" : ""}`} role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      <div className="meter-fill" style={{ transform: `scaleX(${level})` }} />
    </div>
  );
}

interface Props {
  running: boolean;
  /** Seconds of silence after which the session paused, while paused. */
  paused?: number;
  onResume(): void;
  microphoneId: string;
  onMicrophoneId(id: string): void;
  terms: string;
  onTerms(terms: string): void;
  recording: File | undefined;
  onRecording(file: File | undefined): void;
  serviceLabel: string;
}

export function MicrophoneTab({ running, paused, onResume, microphoneId, onMicrophoneId, terms, onTerms, recording, onRecording, serviceLabel }: Props) {
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState("");
  const test = useRef<Microphone | undefined>(undefined);

  useEffect(() => {
    const refresh = () => void listMicrophones().then(setDevices);
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, []);

  function stopTest() {
    test.current?.close();
    test.current = undefined;
    setTesting(false);
  }

  async function startTest() {
    setProblem("");
    setTesting(true);
    try {
      const device = await openMicrophone(microphoneId, { level: micLevel.set, ended: stopTest });
      device.frames.close(); // only the level is needed
      test.current = device;
      // Names appear once the page may use the microphone.
      setDevices(await listMicrophones());
    } catch (error) {
      setProblem(microphoneProblem(error));
      setTesting(false);
    }
  }

  // A session takes the microphone; so does a change of device.
  useEffect(() => {
    if (running) stopTest();
  }, [running]);
  useEffect(() => stopTest, [microphoneId]);

  const known = microphoneId === "" || devices.some((d) => d.id === microphoneId);
  const listening = running && paused === undefined && !recording;

  return (
    <>
      <p className="hint">Talk about your data: entities, their fields and how they relate. Audio goes from this browser straight to {serviceLabel}.</p>

      {paused !== undefined ? (
        <div className="paused" role="status">
          <p>
            No speech for {paused} s, so the microphone is off.
          </p>
          <button type="button" className="primary" onClick={onResume}>
            Resume listening
          </button>
        </div>
      ) : null}

      <label className="stacked">
        <span>Microphone</span>
        <select value={known ? microphoneId : ""} disabled={running} onChange={(event) => onMicrophoneId(event.target.value)}>
          <option value="">System default</option>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <LevelMeter active={testing || listening} />
        <button type="button" disabled={running} onClick={testing ? stopTest : () => void startTest()}>
          {testing ? "Stop test" : "Test"}
        </button>
      </div>
      {problem ? <p className="error">{problem}</p> : null}

      <label className="stacked">
        <span>Terms to expect</span>
        <input
          type="text"
          spellCheck={false}
          placeholder="Jira, SKU, OrderItem"
          value={terms}
          disabled={running}
          onChange={(event) => onTerms(event.target.value)}
        />
      </label>
      <p className="hint">Names and jargon, comma separated, to help recognition. Entities already in the model are added.</p>

      <div className="recording">
        {recording ? (
          <p className="file-row">
            <span className="file-name">{recording.name}</span>
            <button type="button" className="link" disabled={running} onClick={() => onRecording(undefined)}>
              Use the microphone
            </button>
          </p>
        ) : (
          <label className="link-like">
            <input
              type="file"
              accept="audio/*,.wav,.m4a,.mp3,.ogg,.webm"
              disabled={running}
              onChange={(event) => {
                onRecording(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            Or play a recording instead…
          </label>
        )}
        {recording ? <p className="hint">Played at real-time speed, as if spoken.</p> : null}
      </div>
    </>
  );
}
