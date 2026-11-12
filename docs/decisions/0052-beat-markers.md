# 0052 — Beat markers: detection at upload, `mark_beats`, `sync_to_beats`

- Status: accepted
- Date: 2026-11-12

## Context

The M7 roadmap item is "Beat markers on audio layers (detection + manual); `sync_to_beats`". CAPABILITIES says audio has one model, audio layers, and that beat markers are markers on an audio layer. An agent cutting a video to music needs to know where the beats are and to land keyframes and cuts on them, without doing the arithmetic from milliseconds to frames itself. The beats belong to the sound, not to a layer that uses it, so they are found once, when the audio is uploaded. This ADR is numbered 0052 because 0049 to 0051 were taken by the time it was written; earlier commits of the same feature refer to it in code comments.

## Decision

### Beats on the audio asset (scene format 10)

- An audio asset gets an optional `beats: { bpm, confidence, timesMs }`. `bpm` is 20 to 400, `confidence` 0 to 1, `timesMs` is **at most `MAX_BEATS` = 1000** non-negative integer milliseconds, **strictly ascending and less than `durationMs`**.
- The field is optional, so the step from format 9 to **10** needs no data change (a migration that only bumps the version, with a test). Assets uploaded before this have no beats: re-upload the file, or use a grid.
- Detection runs in `prepareMedia` after the FLAC is written, for audio-only uploads and for a video's extracted sound. The stored FLAC is decoded with `decodePcm(audio, ceil(durationMs * 48) + 48_000)` and passed to `detectBeats`. It never fails an upload: an error from either step, or no beat found, means the asset has no `beats`.
- `list_assets` shows `bpm` and `beat_count` for audio with beats, never the times. The upload reply echoes the asset with its beats.

### The tracker (`apps/mcp/src/beats.ts`)

Pure and deterministic: no clock, randomness or I/O, and it runs at authoring time only. Its result is stored in the document, so the render path never runs it (same document, same frame, same pixels).

- Input: the decoded stereo PCM, mixed to mono, **at most 61 s** (longer input throws, which an upload treats as no beats).
- Onset envelope: 1024-sample Hann windows with a **10 ms hop**; log spectral flux up to **8 kHz**, plus the flux of the **150 Hz low band** (so kicks count), each normalised, then the moving mean removed.
- Tempo: **50 to 220 bpm** (lags `floor(6000 / 220)` to `ceil(6000 / 50)`, the reported bpm clamped into the range), from the centred autocorrelation of the envelope weighted by a log-Gaussian around **120 bpm** (one octave wide), with parabolic refinement of the peak. **Confidence = acf(peak) / acf(0).** Below **0.2** (or fewer than 4 beats) there are no beats; white noise measured 0.117.
- Beats: Ellis (2007) dynamic programming with tightness **100**. A beat's time is the **centre of its analysis window**. Times are rounded to integer ms.

Measured on the synthetic tracks in `beats.test.ts` (48 kHz stereo, first beat at 250 ms; worst error is the largest distance from a true beat after 1 s to the nearest detected one):

| Track                                 | True bpm | Detected bpm | Confidence | Beats (true) | Worst error |
| ------------------------------------- | -------- | ------------ | ---------- | ------------ | ----------- |
| 1 kHz click                           | 90       | 89.77        | 0.765      | 18 (18)      | 5.7 ms      |
| 1 kHz click                           | 120      | 120.00       | 0.950      | 20 (20)      | 1 ms        |
| 1 kHz click                           | 140      | 139.68       | 0.913      | 28 (28)      | 7.6 ms      |
| 60 Hz kick plus off-beat 1 kHz clicks | 100      | 100.00       | 0.950      | 20 (20)      | 1 ms        |
| 60 Hz kick only                       | 110      | 109.89       | 0.631      | 22 (22)      | 6.3 ms      |
| 1 kHz click, 20 s                     | 50       | 50.00        | 0.941      | 17 (17)      | 1 ms        |
| 1 kHz click, 20 s                     | 60       | 60.00        | 0.950      | 20 (20)      | 1 ms        |
| 1 kHz click, 20 s                     | 100      | 100.00       | 0.970      | 33 (33)      | 1 ms        |
| 1 kHz click, 20 s                     | 150      | 149.98       | 0.980      | 50 (50)      | 1 ms        |
| 1 kHz click, 20 s                     | 160      | **80.00**    | 0.962      | 27 (53)      | half tempo  |
| 1 kHz click, 20 s                     | 174      | **86.97**    | 0.966      | 29 (58)      | half tempo  |
| 1 kHz click, 20 s                     | 180      | **89.79**    | 0.766      | 30 (60)      | half tempo  |
| 1 kHz click, 20 s                     | 200      | **100.00**   | 0.970      | 33 (66)      | half tempo  |
| 1 kHz click, 20 s                     | 220      | **73.23**    | 0.865      | 25 (73)      | a third     |

These are clean synthetic signals. Real music has not been evaluated yet.

**Tempos above about 150 bpm may be reported at half tempo** (a third at 220): the log-Gaussian prior around 120 bpm and the non-integer lag of a fast tempo (a 160 bpm period is 37.5 envelope frames, so its autocorrelation is split between two lags) favour the slower multiple. An octave check (take half the best lag when its unweighted autocorrelation is at least 0.9 of the best) was tried and removed: it could not recover 160 (ratio 0.67), 174 (0.54) or 180 (0.50). An agent that knows the song is fast should use `every`/`phase` or a `grid`. The top lag was moved from `ceil` to `floor(6000 / 220)` so 220 bpm is reachable, but it still scores below its third.

### Markers on audio layers

Every marker on an audio layer is a beat marker: zero-length, named `beat <n>` (n counts from the first beat of the source), in layer time.

- **`mark_beats`** takes one audio layer and either the asset's detected beats or a `grid` (`bpm` 20 to 400, `first_beat_frame` in composition frames, optional `count`). For a grid, `count` includes the beats before the layer's `inFrame`, and the number in the name counts from `first_beat_frame`. Only beats inside the layer's in/out range get a marker. It refuses a layer that already has markers unless `replace: true`, which removes them first. A layer holds at most `MAX_MARKERS` markers. Its reply omits the ops (`echoOps: false`; up to 1000 `addMarker` ops) and carries a resolved summary (`source`, `bpm`, `beat_count`, `first_frame`, `last_frame`, `removed`).
- **`sync_to_beats`** snaps the keyframes and/or cuts of layers to the markers of an audio layer in the same composition. `snap` is `keyframes` (default), `cuts` or both. A **cut** is a layer's in point; the layer **slides** (`inFrame`, `outFrame` and `startFrame` move together) so its content keeps its timing relative to the cut. `every` and `phase` keep every nth beat starting at `phase` (a bar is `every: 4`, with `phase` for the downbeat). `max_distance` is in frames; the default is `floor(median gap between kept beats / 2)`. A frame equidistant from two beats goes to the **earlier** one. `window` limits what moves to composition frames, judged on the positions before the call (a cut by its original in point, a keyframe before any slide of the same call). Keyframes that would collide, or squeeze a spring, are refused with the same checks as `retime` (`checkMovedTracks`), with a hint on what to change.

### Listing budget

`tools/list` grows from 96.1 KB to **101.2 KB** (`mark_beats` 2.3 KB, `sync_to_beats` 2.8 KB with field descriptions). The `server.test.ts` cap rises from 97 KB to **102 KB**. The manifest stays under its 10 KB cap (the audio reason is one sentence longer). Lowering the listing is still the M8 item.

## Alternatives considered

- **Detect on demand through a tool.** Decided against: beats belong to the asset and are found once, at upload.
- **Onsets only, no tempo.** Irregular and hard to snap to; a period and a grid are what an editor wants.
- **essentia.js.** Heavy WebAssembly and AGPL.

## Consequences

- An agent can mark the beats of any uploaded song and snap a cut or an animation to them in two calls, with a dry run first.
- Follow-ups:
  - Downbeats and bars are not detected (use `every: 4` with `phase`).
  - One global period: tempo changes in a song are not tracked.
  - Audio layers inside precomps are not covered by the exports yet (ADR-0048), and the beat tools work on layers of one composition.
  - Detection runs on the request thread (~0.3 s per 60 s of audio); move it to a worker with deploy.
  - Evaluate the tracker on real music and tune the constants.
  - Editor UI for beat markers.
