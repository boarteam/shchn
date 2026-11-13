# shchn

Turns live speech, requirements text or source code into a YAML model of entities, their properties and the relations between them. The model is updated while the input is still coming in: talk about a data structure and watch it take shape.

```yaml
entities:
  Client:
    properties:
      name: {}
      email: {}
      orders: { ref: Order, many: true }
  Order:
    properties:
      client: { ref: Client }
      total: {}
      items: { ref: OrderItem, many: true }
```

A property with `ref` is a relation to another entity, like a foreign key; `many: true` means it holds several. Types are ignored for now.

## Setup

Needs Node 22+, and ffmpeg for live mode (macOS: `brew install ffmpeg`). On macOS the microphone is read by a small Swift helper (`native/mic-capture.swift`, built on first use with the Xcode command line tools), because ffmpeg's macOS capture loses about 6% of the audio and drifts behind. Use `./shchn mic` to check levels and pick `--channel` on a multi-input interface, and keep the interface at 48 kHz: at 192 kHz capture breaks.

```bash
npm install
cp .env.example .env
```

Then fill in `.env`: `ANTHROPIC_API_KEY`, plus `SONIOX_API_KEY` (default) or `DEEPGRAM_API_KEY` for live speech. `npm run set-key` (or `npm run set-key -- SONIOX_API_KEY`) asks for a key with hidden input and writes it to `.env`, keeping it out of shell history; for the Anthropic key it also checks that the key works. On macOS the terminal app asks for microphone access the first time.

## Usage

```bash
# Talk; the model updates as you speak. Ctrl+C to stop.
./shchn live --view

# Simulate a live session from a transcript, then score the result.
./shchn replay examples/tracker.ru.txt --view --expect examples/tracker.ru.expected.yaml

# Requirements documents or code.
./shchn file docs/requirements.md src/models/*.ts

# Any text stream, e.g. another transcriber.
some-transcriber | ./shchn stdin
```

Every session writes:

- `model.yaml`, rewritten on each change (atomically, so editors and `watch cat model.yaml` never see half a file).
- `model.ops.jsonl`, every edit with the text it came from and the timing of each call.
- `model.transcript.txt` for `live` and `stdin` sessions, so a real session can be replayed later with other settings.
- `model.audio.wav` for `live` sessions run with `--save-audio`, to replay the exact audio with `live --audio`.

Live mode with a microphone waits for Enter before it starts listening. After 20 seconds without recognized speech it turns the microphone off and pauses until you press Enter again, in case someone walks away and leaves it running (`--pause-after <seconds>`, `0` turns this off). `--resume` continues from an existing `model.yaml`. `./shchn --help` lists every option.

## How it works

```
mic ─► speech-to-text ─┐
replay / stdin / files ┴─► engine ─► Claude ─► edits ─► model ─► model.yaml
                           (batches      ▲                 │
                            sentences)   └─ current model ─┘
                    every 45 s: review pass over the whole transcript ─► edits
```

- **Edits, not regeneration.** Claude never rewrites the YAML. Each call returns a short list of edits (`upsert_property`, `rename_entity`, `merge_entities`, …) that the code checks and applies. Output stays a few dozen tokens however big the model gets, and the YAML only changes where something changed.
- **Each call gets the current model, the last ~1,500 characters of text and the new text.** The model itself is the memory, so calls stay small and every call sees the exact current state. The response is a JSON schema-constrained stream; each edit is applied the moment its closing brace arrives.
- **One call at a time, nothing queues.** Complete sentences are sent as soon as they end; after a pause (reported by speech-to-text) the rest goes too. Fragments shorter than three meaningful words wait for the next phrase, filler alone ("э-э", "um") is never sent, and 1.5 s of quiet sends whatever is left. Text that arrives during a call goes out together with the next one, so a slow call never builds up a backlog.
- **A review pass** reads the whole transcript every 45 seconds of live input, and once at the end. It merges duplicates, fixes relations and catches what the fast calls missed. Its edits are applied between calls, never in the middle of one.
- **Pauses release the text.** During continuous speech Soniox holds back confirmed text for about 4.7 s. shchn spots short pauses (~200 ms) in the audio and asks it to confirm what it heard, which cuts that to about 0.2 s.
- **Speech-to-text** streams over WebSocket. Soniox (`stt-rt-v6`) is the default because it handles Russian with English terms mid-sentence; Deepgram Nova-3 (`--stt deepgram`) is the alternative. Both use the standard WebSocket API, so the same adapters can later run in a browser.
- **Claude settings:** `claude-opus-5-5` at `--effort low` by default. A declined request is retried server-side on Anthropic's recommended fallback model (`fallbacks: "default"`).

## Measuring speed and quality

`replay` plays a transcript at speaking speed and reports how long it took from the end of each sentence to the model update, how long calls took, tokens and an approximate cost. With `--expect` it also scores the final model against a hand-written one: entities, plain attributes, and relation links (scored as Order → Client regardless of the property's name).

Compare settings on the same transcript:

```bash
./shchn replay examples/shop.en.txt --expect examples/shop.en.expected.yaml
./shchn replay examples/shop.en.txt --expect examples/shop.en.expected.yaml --fast
./shchn replay examples/shop.en.txt --expect examples/shop.en.expected.yaml --model claude-sonnet-5-5 --thinking off
./shchn replay examples/shop.en.txt --expect examples/shop.en.expected.yaml --model claude-haiku-5-5
```

Speed varies by the hour, so compare runs made one after another. Your own recorded sessions (the saved transcripts) are a better test set than the examples.

To test the full speech path without speaking, stream a recording: `./shchn live --audio talk.m4a --view`. On macOS `say -v Milena "У User есть email и список orders" -o talk.aiff` makes one.

## Layout

| Path | What's there |
|---|---|
| `src/model/` | The model store, edit operations, name normalization, YAML in and out |
| `src/extract/` | System prompt, the streaming Claude call, the incremental JSON reader, per-model settings |
| `src/engine/` | Batching, scheduling and the review pass |
| `src/input/` | Audio capture, pause detection, the mic check, transcript replay, Soniox and Deepgram adapters |
| `src/output/` | File writers, the WAV recorder and the terminal view |
| `src/eval/` | Scoring against an expected model |
| `native/` | The macOS microphone helper, compiled on first use |
| `scripts/` | `set-key.sh`, behind `npm run set-key` |
| `shchn` | The launcher: runs a single process so Ctrl+C reaches the session (`npm run` doesn't wait) |
| `examples/` | Two transcripts (English; Russian with English terms) with expected models |

```bash
npm test            # unit tests, no API calls
npm run typecheck
```
