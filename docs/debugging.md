# Debugging shchn

A live session is a chain: microphone → capture → speech-to-text → scheduler → Claude → model. When something goes wrong, the symptom usually shows up at the end of the chain (nothing appears, the wrong words appear, updates come late) while the cause sits near the start. The tools in [`tools/`](../tools) let you test each link on its own, mostly for free and without speaking.

Start with the [quick checks](#quick-checks). If they don't settle it, find your symptom under [case studies](#case-studies): each one is a real problem from the first sessions with shchn, with the tool that found it.

## Quick checks

| Question | Command | Costs |
|---|---|---|
| Does my microphone work, at the right level and speed? | `./shchn mic` | free |
| Is my speech-to-text key valid, with money on the account? | `npm run debug:stt-check` (`-- --stt deepgram` for Deepgram) | a second of audio |
| What did the last session actually do, call by call? | `npm run debug:session` | free |
| Is there speech in this recording, and how long are the pauses? | `npm run debug:audio -- model.audio.wav` | free |

Record a session with `--save-audio` whenever something looks wrong: `model.audio.wav` lets you rerun the exact audio through every tool below, and through `./shchn live --audio model.audio.wav`, as often as you like.

## The tools

All of them are TypeScript files in `tools/`, run with `npm run debug:<name> -- <args>`. Each file starts with a comment explaining what it's for and how to read its output.

### `./shchn mic`: microphone check

Records 8 seconds while you count aloud, through the same capture path live mode uses, and reports:

- the input format (sample rate, channels);
- seconds of audio received in seconds of real time. Anything far from 1.0x means distorted, recognition-proof audio;
- the peak and average level of every input channel, which shows which input your mic is on;
- a verdict: fine, use `--channel N`, too quiet, clipping, wrong speed, or exact digital silence (the microphone is blocked or muted).

It saves the loudest channel to `out/mic-check.wav` for a closer look.

### `debug:capture`: capture speed over time

```bash
npm run debug:capture -- --seconds 30            # the backend live mode uses
npm run debug:capture -- --seconds 30 --ffmpeg   # force ffmpeg, to compare
```

Prints audio received against wall-clock time every 5 seconds. You don't need to speak. A steady ratio of 1.00 is correct. A ratio below 1.0 means a live session falls further behind the longer it runs, by `(1 - ratio)` seconds per second.

### `debug:ffmpeg-variants`: ffmpeg capture settings (macOS)

```bash
npm run debug:ffmpeg-variants -- --seconds 10
```

Runs five ffmpeg capture configurations for 10 seconds each and prints each one's real-time ratio. It exists to recheck one finding (case 5) after an ffmpeg upgrade.

### `debug:stt`: when speech-to-text returns text

```bash
npm run debug:stt -- model.audio.wav                  # as live mode does it
npm run debug:stt -- model.audio.wav --no-finalize    # without asking for text at pauses
npm run debug:stt -- clip.wav --stt deepgram --partials
```

Streams a file to the speech-to-text service in real time, the way live mode streams the microphone. It prints every confirmed piece of text with its lag, meaning how long after the words were spoken it arrived. It also prints Soniox's own pause signals ("ENDPOINT") and the finalize requests shchn sends at pauses. It makes no Claude calls; Soniox charges $0.12 per hour of audio.

### `debug:audio`: what's in a recording

```bash
npm run debug:audio -- model.audio.wav --window 0.5 --thresholds 200,500,1000
```

Shows the format, the overall level, the percentage of exact-zero samples, the level every half second, and the silent gaps under each threshold. The pause detector treats 200 ms below RMS 200 as a pause, so the `200` row shows where live mode would ask for text.

### `debug:session`: a session, call by call

```bash
npm run debug:session                         # last session in model.ops.jsonl
npm run debug:session -- out/x.ops.jsonl --session all --edits
```

For each Claude call it shows when it was sent, how long it took, how long after the last words the model updated, how many edits it made, and the text it carried. `--edits` adds the edits themselves. The summary counts calls that changed nothing, which is wasted money, and gives latency percentiles and an estimated cost.

### `debug:tts`: a spoken test clip without speaking (macOS)

```bash
npm run debug:tts -- examples/tracker.ru.txt --paragraphs 2 --out out/clip.aiff --left-only
./shchn live --audio out/clip.aiff
```

Reads the first paragraphs of a transcript aloud with macOS `say` (Milena and Yuri speak Russian). `--left-only` also writes a stereo copy with speech only on the left channel, like a microphone on input 1 of an audio interface, for testing `--channel`.

### `debug:stt-check`: is the key good?

Connects with the key from `.env`, sends one second of silence, and reports whether the service accepted it. It catches a mistyped key, an expired key, or an empty balance before a session does.

### `debug:keys`: interactive behavior in a scripted terminal

```bash
npm run debug:keys -- "1:<enter>,10:<enter>,14:<ctrl-c>" ./shchn live --pause-after 4
```

Runs a command in a 120×40 pseudo-terminal and presses keys at the given times. That's the only faithful way to test the Enter prompt, the silence pause and Ctrl+C. A pipe isn't a terminal, and `kill -INT` reaches only one process, while Ctrl+C reaches the whole foreground process group. It uses only the Python standard library.

## Case studies

### 1. Live mode hears nothing

**Symptom:** "listening to the microphone", then nothing, whatever you say.

**Cause:** macOS hadn't let the app running the terminal use the microphone. ffmpeg then waits forever without an error. In the Claude desktop app's terminal, the app to allow is *Claude Code*.

**Found with:** a 2-second ffmpeg capture that never finished. **Now:** live mode warns after 5 s when no audio arrives, or only exact zeros, and says where to allow access. `./shchn mic` and `debug:capture` report the same.

### 2. Ctrl+C ends the session without a summary

**Symptom:** after Ctrl+C the prompt comes back immediately, with no summary and sometimes no transcript.

**Cause:** `npm run` and `tsx` both exit as soon as Ctrl+C arrives, without waiting for the program inside, so the session is killed while it's still finishing. ffmpeg, in the same process group, also got the signal directly.

**Found with:** `debug:keys`, running the same session through `npm run`, `npx tsx` and plain `node` and comparing the exit status: 130 against 0. **Now:** the `./shchn` launcher `exec`s a single node process, and capture runs in its own process group, so Ctrl+C reaches shchn alone and shchn stops capture in order.

### 3. Updates arrive 6–11 seconds after speech

**Symptom:** each phrase showed up in the model long after it was said, though each Claude call took about 1.5 s.

**Cause:** during continuous speech Soniox confirms text only about 4.7 s behind the audio, and shchn waits for confirmed text. Text arrived within 0.11 s when the stream ended.

**Found with:** `debug:stt --no-finalize` showed lags of about 4.7 s for every piece. **Fix:** a pause detector ([`src/input/pauses.ts`](../src/input/pauses.ts)) asks Soniox to finalize at short pauses (at most every 2 s, as Soniox advises), which brings confirmed text to 0.1–0.3 s. `debug:audio` then showed that synthetic speech pauses only 180–260 ms between sentences, which set the threshold at 200 ms rather than 250.

### 4. The transcript is an unrelated phrase

**Symptom:** the `heard:` line shows words nobody said, or nothing at all, while you speak normally.

**Causes, stacked:**
1. A two-input audio interface (Scarlett 2i2) with the mic on input 1. Mixing both inputs halved the voice.
2. The interface was set to 192 kHz, and at that rate capture delivered 0.24x real time, chopping the speech into pieces no recognizer can read.

**Found with:** `./shchn mic`, whose speed line printed "received 1.6 s of audio in 6.8 s", and `debug:audio` on a `--save-audio` recording, which held 9 s of audio from a session that lasted much longer. **Fix:** `--channel 1`, and the interface switched to 48 kHz in Audio MIDI Setup. The mic check now flags both problems.

### 5. Latency grows over the session

**Symptom:** updates came after 3 s early in a session and after 7 s a minute later. The recording was a few seconds shorter than the session.

**Cause:** ffmpeg's macOS capture (avfoundation) delivered about 0.94 s of audio per second, losing samples steadily. `debug:ffmpeg-variants` measured 0.93–0.94x for every configuration, including capture without resampling, so the loss is in ffmpeg's macOS input itself.

**Found with:** `debug:capture`, which showed "behind" climbing by about 0.06 s every second. **Fix:** on macOS the default microphone is read by [`native/mic-capture.swift`](../native/mic-capture.swift) (AVAudioEngine), which measured 1.001x with no drift. ffmpeg is still used for files, `--device`, and other systems.

### 6. A latency number that wasn't true

**Symptom:** a replay reported "median 4.8 s from end of speech" while every call line said 1.2–3.5 s.

**Cause:** replay feeds text word by word, and the summary measured from every word, including the first word of a sentence, spoken seconds before its end.

**Found with:** `debug:session`-style analysis of `model.ops.jsonl`. **Fix:** latency is now measured per call, from the end of the last words it carried.

### 7. Too many calls for a few sentences

**Symptom:** an 84-second session made 30 Claude calls, and 17 of them changed nothing.

**Cause:** finalizing at every pause makes Soniox end each fragment with a period ("Могут." "Играть."), so each looked like a complete sentence.

**Found with:** `debug:session`, by counting calls with 0 edits. **Fix:** fragments under three meaningful words wait for the next phrase, and filler alone ("э-э", "um") is never sent. Replaying the same recording took 16 calls instead of 30, at the same accuracy.

## Things to know

- **Which commands cost money.** Claude calls: `file`, `replay`, `stdin`, `live`. Speech-to-text time: `live`, `debug:stt`, `debug:stt-check`. Everything else is free. The examples cost cents; an hour of live talk costs about $3–4 of Claude and $0.12 of Soniox.
- **Keep the interface at 48 kHz.** Some apps (DAWs especially) switch it back to 192 kHz; the mic check catches it.
- **`ANTHROPIC_BASE_URL`.** The Anthropic SDK honors it. Some environments, such as an AI coding tool's shell, set it to their own value; unset it if requests go somewhere unexpected.
