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
npm run typecheck        # src, test and tools
./shchn replay examples/shop.en.txt --expect examples/shop.en.expected.yaml   # end to end, a few cents
```

Run shchn through `./shchn`, not `npm run shchn`: npm exits on Ctrl+C before the session can finish (see [debugging](debugging.md#2-ctrlc-ends-the-session-without-a-summary)). Use `npm run shchn` only for non-interactive runs.

## How the code is organized

```
input ──► Engine (src/engine) ──► OpsSource (src/extract) ──► ModelStore (src/model) ──► YAML
 file / stdin / replay            Claude, streamed             edits applied in order
 live: capture → pauses → STT
```

| Path | Responsibility |
|---|---|
| `src/model/` | `ModelStore` holds entities with internal ids; edit operations (`ops.ts`) are the only way it changes; YAML in and out |
| `src/extract/` | The system prompt, the streaming Claude call (`OpsSource`), the incremental JSON reader, per-model settings and prices |
| `src/engine/` | When to send what: sentence batching, fragment merging, one call at a time, the review pass |
| `src/input/` | Replay, audio capture (native helper or ffmpeg), the pause detector, the audio clock, the mic check, speech-to-text adapters |
| `src/output/` | Atomic file writes, the edit log, the WAV recorder, the terminal view |
| `src/session.ts` | Wires one command together: input, engine, outputs, Ctrl+C, the summary |
| `native/` | The macOS capture helper (Swift) |
| `tools/` | Debugging tools, see [debugging.md](debugging.md) |
| `test/` | Unit tests, one file per area |

A few rules keep this manageable:

- **The model changes only through edit operations.** Adding a kind of change means a new op in `src/model/ops.ts` (type, JSON schema, `parseOp`), its handling in `ModelStore`, and a mention in the system prompt.
- **The engine doesn't know about Claude or audio.** It takes an `OpsSource` and text with timestamps, so its tests use a fake source (`test/engine.test.ts`), and so can any experiment.
- **Speech-to-text adapters use the standard WebSocket API**, so they can run in a browser later. Keep `node:` imports out of `src/input/stt/` and `src/model/`.
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

1. Implement `SttProvider` from `src/input/stt/types.ts`: `partial`, `final` (with the audio time of the last word), `endpoint`, and `finalize()` and `finish()` on the session.
2. Keep the message handling a pure function, like `handleSonioxMessage`, and test it with recorded message shapes (`test/score-and-stt.test.ts`).
3. Register it in `src/input/stt/index.ts` and the `--stt` option in `src/cli.ts`.
4. Measure it on the same recording as the others: `npm run debug:stt -- <file> --stt <name>`.

## Before opening a pull request

- `npm test` and `npm run typecheck` pass.
- If behavior changed, the examples still score as before, and the README or the docs say what changed.
- For audio or terminal changes, say which machine, interface and terminal you tested on. Those bugs depend on them.
