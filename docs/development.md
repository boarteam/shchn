# Developing shchn

## Setup

```bash
git clone https://github.com/boarteam/shchn && cd shchn
npm install
npm run set-key                      # Anthropic key, hidden input, checked
npm run set-key -- SONIOX_API_KEY    # only for live mode
```

Node 22+, and ffmpeg for audio files (macOS: `brew install ffmpeg`). On macOS the Xcode command line tools build the microphone helper on first use (`xcode-select --install` if `swiftc` is missing).

## Everyday commands

```bash
npm test                 # unit tests: no network, no microphone, no API calls
npm run typecheck        # src, test and tools; then src/core alone, without Node's types; then src/web
npm run web              # the web app at http://localhost:5173, reloading as you edit
./shchn replay examples/shop.en.txt --expect examples/shop.en.expected.yaml   # end to end, a few cents
```

Run shchn through `./shchn`, not `npm run shchn`: npm exits on Ctrl+C before the session can finish (see [debugging](debugging.md#2-ctrlc-ends-the-session-without-a-summary)). Use `npm run shchn` only for non-interactive runs.

## How the code is organized

```
input ──► Engine (core/engine) ──► OpsSource (core/extract) ──► ModelStore (core/model) ──► YAML
 file / stdin / replay             Claude, streamed              edits applied in order
 live: capture → pauses → STT
```

The code is in three parts. `src/core/` is everything above that doesn't depend on where it runs: it uses only what Node, browsers and Web Workers all have (`fetch`, `WebSocket`, timers, typed arrays). `src/cli/` is the command line around it: options, files, stdin, the microphone, the terminal. `src/web/` is the browser around it: a page and a worker.

| Path | Responsibility |
|---|---|
| `src/core/model/` | `ModelStore` holds entities with internal ids; edit operations (`ops.ts`) are the only way it changes; YAML in and out |
| `src/core/extract/` | The system prompt, the streaming Claude call (`OpsSource`), the incremental JSON reader, per-model settings and prices |
| `src/core/engine/` | When to send what: sentence batching, fragment merging, one call at a time, the review pass |
| `src/core/input/` | Replay, the pause detector, the audio clock, speech-to-text adapters |
| `src/core/session.ts` | One session from input to model: engine, speech-to-text, pauses, the auto-pause on silence, the edit log records. The platform passes in its parts: the input, an `AudioSource`, the Claude client, a `Reporter`, where to save |
| `src/core/report.ts` | Text for progress lines and the end summary |
| `src/cli/session.ts` | Runs one command as a core session: reads files and stdin, Enter to start, Ctrl+C to stop, writes the model, the log, the transcript and the audio |
| `src/cli/` (rest) | Options (`cli.ts`), audio capture with the native helper or ffmpeg, the mic check, atomic file writes, the WAV recorder, the terminal view, keys from `.env` |
| `src/web/worker.ts` | Runs one core session in a Web Worker and reports it to the page as messages (`protocol.ts`). Calls Claude and speech-to-text directly from the browser |
| `src/web/microphone.ts`, `captureWorklet.ts`, `pcm.ts` | The microphone: the page opens it, an audio worklet turns it into 16 kHz 16-bit frames and sends them through a `MessagePort` straight to the worker. Also decodes recordings |
| `src/web/audioSources.ts` | The worker's `AudioSource`s: the microphone frames from the port, and a recording played at real-time speed |
| `src/web/` (rest) | The page (React): input, the YAML view (CodeMirror, `YamlView.tsx`), activity, settings and keys kept in `localStorage`; `useSession.ts` starts a worker per session and opens and closes the microphone for it. `vite.config.ts` builds it and adds the content security policy |
| `native/` | The macOS capture helper (Swift) |
| `tools/` | Debugging tools, see [debugging.md](debugging.md) |
| `test/` | Unit tests, one file per area |

A few rules keep this manageable:

- **Nothing in `src/core/` uses Node.** No `node:` imports, `Buffer`, `process` or `fs`; no `window` or `document` either, so core also runs in a Web Worker. `npm run typecheck` enforces it by checking `src/core` on its own, without Node's types ([`src/core/tsconfig.json`](../src/core/tsconfig.json)). What needs Node goes in `src/cli/` and reaches core through an interface, the way `AudioSource` and `waitForSpeaker` do.
- **In the web app, sessions run in the worker; the page only shows them.** Chrome slows timers in a background tab to once a second or less, which would delay batching; a worker's timers keep their pace. The page never touches a `ModelStore`: it gets the YAML and stats in messages. Keep the messages in `protocol.ts` plain data. Audio follows the same rule: only the page can open the microphone, but the samples go from the audio worklet to the worker through a port, never through the page.
- **The model changes only through edit operations.** Adding a kind of change means a new op in `src/core/model/ops.ts` (type, JSON schema, `parseOp`), its handling in `ModelStore`, and a mention in the system prompt.
- **The engine doesn't know about Claude or audio.** It takes an `OpsSource` and text with timestamps, so its tests use a fake source (`test/engine.test.ts`), and so can any experiment. The session takes one too, which is how `test/session.test.ts` runs live mode with a fake microphone, speech-to-text and Claude.
- **Every long-running piece must stop cleanly on Ctrl+C.** Test it with `npm run debug:keys`.

## Changing the prompt or the model

Behavior changes are measured, not judged by eye:

```bash
./shchn replay examples/tracker.ru.txt --expect examples/tracker.ru.expected.yaml
./shchn replay examples/shop.en.txt --expect examples/shop.en.expected.yaml
```

Both should stay at 100% unless the change is meant to move them. Real recordings make a better test: `./shchn live --audio <recording>.wav` replays a session exactly. When a new kind of input matters to you, add a transcript and an expected model to `examples/` so everyone can check against it.

Calls cost money. The examples cost a few cents per run, and `debug:session` shows a run's token use and estimated cost.

## Adding a speech-to-text provider

1. Implement `SttProvider` from `src/core/input/stt/types.ts`: `partial`, `final` (with the audio time of the last word), `endpoint`, and `finalize()` and `finish()` on the session. Use the standard `WebSocket`, so the adapter works in the browser too.
2. Keep the message handling a pure function, like `handleSonioxMessage`, and test it with recorded message shapes (`test/score-and-stt.test.ts`).
3. Register it in `src/core/input/stt/index.ts`, its key's variable name in `src/cli/keys.ts`, and the `--stt` option in `src/cli/cli.ts`. For the web app, add it to `STT_PROVIDERS` in `src/web/settings.ts` and its host to `connect-src` in `src/web/vite.config.ts`; the key check in Settings (`keyChecks.ts`) works for any adapter.
4. Measure it on the same recording as the others: `npm run debug:stt -- <file> --stt <name>`.

## Before opening a pull request

- `npm test` and `npm run typecheck` pass.
- If behavior changed, the examples still score as before, and the README or the docs say what changed.
- For audio or terminal changes, say which machine, interface and terminal you tested on. Those bugs depend on them.
