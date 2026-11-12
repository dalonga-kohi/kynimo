# 0057 — Built-in shader transitions

- Status: accepted (extends ADR-0045; ADR-0047's `transition` component stays for cover panels)
- Date: 2026-11-12

## Context

ADR-0045 left shader transitions as a follow-up and ADR-0055 listed them as a separate roadmap item. A transition needs two inputs, the old picture and the new one, which none of the single-input effects have. ADR-0047's components cannot reach the layers beneath them, so a component cannot blend two shots. The same rules as every shader hold: deterministic on SwiftShader and in the float64 reference, trig and seeds on the CPU, a frame cost that is charged before any work.

## Decision

- **Model.** A drawn layer (every layer type except null, camera, audio and adjustment) gets a `transition` (`null` is none). For that layer, A is everything composited beneath it, B is the layer blended normally over A (placement, masks, matte, effects, motion blur and 3D already applied), and the output is `O = T(A, B, p)`. The output replaces what the layer would have drawn. At `p <= 0` the output is A, with the layer still placed, so its matte and cache behave the same. At `p >= 1` the layer is planned as if it had no transition, so every existing plan and golden is unchanged. It works with masks, mattes, effects, blend modes, motion blur, 3D layers and precomps. A nested composition builds its plan at its own size, so the transition's coordinates are in the precomp's pixels. It is not an adjustment layer: an adjustment layer has no B of its own.
- **Scene format 14.** `SCENE_FORMAT_VERSION = 14`. The 13 to 14 migration adds `transition: null` to every drawn layer, which renders as before. There is no new operation: `updateLayer` with `set.transition` replaces the whole value or clears it, and fails on layers that cannot have one. The intent walkers (`retime`, `stagger`, `animate`, the beat sync) shift the keyframes of a transition like any other track.
- **The ten kinds** (every field required; animatable unless noted; angles are degrees, clockwise on screen, 0 toward +x; points and sizes in composition pixels; `progress` is 0 to 1 and eased overshoot is clamped to each field's domain):
  - `dissolve`: `progress`.
  - `noise-dissolve`: `seed` (uint32, constant), `scale` 1 to 512 px per cell, `feather` 0 to 1.
  - `wipe`: `angle` (direction of travel, ±3600), `feather` 0 to 4096 px.
  - `clock`: `startAngle` (0 is 12 o'clock, ±3600), `clockwise` (constant), `center`, `feather` 0 to 180 degrees.
  - `iris`: `shape` circle, diamond or square (constant), `center`, `feather` 0 to 4096 px.
  - `blinds`: `count` 2 to 128 (integer, constant), `angle` (direction the slats open), `feather` 0 to 1 of a slat.
  - `pixelate`: `cell` 2 to 512 px, the largest cell, reached at `p = 0.5`.
  - `push`: `angle` (direction B travels in).
  - `zoom`: `center`, `strength` 0 to 8.
  - `glitch`: `seed`, `bands` 2 to 256 (integer, constant), `amount` 0 to 1.
    Centers are clamped to ±65536.
- **Trig and seeds on the CPU.** `transitionUniforms` (renderer, from the engine's resolved transition and the target size) returns plain numbers in float64: direction vectors, the corner extent `[min, length]` of a direction, the iris's farthest-corner distance, the clock's start direction, the blinds period, the pixelate cell, the zoom scales, the glitch step and amplitude. The GPU takes them as uniforms and the float64 reference rounds each with `Math.fround` first, so both sides start from identical inputs. The only GPU trig is `atan` in the clock. Hashing is the ADR-0045 integer `hashWords` (`uint` math in GLSL), never `fract(sin())`.
- **The maths, condensed.** Pixel positions are centres `c = (x + 0.5, y + 0.5)`. Colours are premultiplied, mixed linearly. For the mask kinds `O = mix(A, B, coverage(c))`.
  - Wipe: `s = dot(c, d)`, `e = min + p · (length + f)`, coverage `clamp((e - s) / f, 0, 1)` with `f = max(feather, 1)`. The edge starts fully outside the frame and ends fully past it.
  - Iris: distance `r` from the center in the shape's metric (Euclidean, `|x| + |y|`, `max(|x|, |y|)`), coverage `clamp((p · (rMax + f) - r) / f, 0, 1)`, `f = max(feather, 1)`, `rMax` the farthest frame corner.
  - Blinds: `s = dot(c, d) - min`, `u = s mod period`, `period = length / count`, coverage `clamp((p · (period + f) - u) / f, 0, 1)`, `f = max(feather · period, 1)`.
  - Noise dissolve: value noise `n` on a lattice of `scale`-pixel cells (quintic fade, corner values a unit hash of the seed and the cell); with feather, coverage `clamp((p · (1 + f) - n) / f, 0, 1)`; without, `n < p`.
  - Clock: angle `phi` of `c - center` from the start direction in `[0, 360)`, mirrored for counter-clockwise; coverage `clamp((p · (360 + f) - phi) / f, 0, 1)` (hard step `phi < 360p` without feather). The centre pixel itself is `phi = 0`.
  - Pixelate: samples both inputs bilinearly at the cell centre, `cell = 1 + (cell_max - 1) · (1 - |2p - 1|)`, mix `clamp((p - 0.4) / 0.2, 0, 1)`.
  - Push: A slides out along `d` by `p · length`, B slides in behind it from `(p - 1) · length`, joined by a one-pixel box edge.
  - Zoom: A is scaled about the center by `1 + strength · p`, B by `1 + strength · (1 - p)`, mixed by `p`.
  - Glitch: `bands` rows; per row and `step = floor(16p)` a hash picks whether the row shows B (`hash < p`) and a shift in `±amount · 0.1 · width · (1 - |2p - 1|)`; red and blue are sampled a quarter of that shift to either side.
  - Bilinear reads clamp the position to the edge texel centres, like the chromatic aberration.
- **Cost.** `transitionSamples` per pixel: 2 for the mask kinds (the two inputs), 8 for pixelate, push and zoom (four taps for each of two bilinear samples) and 12 for glitch (three channels, two inputs, four taps). Charged as `width × height × samples` against the 500 million sample frame budget of ADR-0045, naming the layer, before the placement and before any GPU work.
- **Measured.** GPU (SwiftShader) against the float64 reference differs by at most 1/255 per channel on all 16 tested variants at `p` 0.3 and 0.7, with 0 % of pixels over 2/255. The tests assert 2/255 for the feathered kinds and at most 0.2 % stepped pixels (those whose result moves when the input is nudged by 3/255) for the hard-edged kinds.
- **`add_transition`** (intent tool, no new scene operation). Inputs: `layer` (one layer), `kind`, `edge` (`in` default, or `out`), `duration`, `easing` (default `move`), `params` (the kind's fields without `kind` and `progress`). Defaults come from the composition: centres at its middle, wipe and iris feather `round(4 % of the longer side)`, noise-dissolve scale and pixelate cell from the shorter side (`/ 24` and `/ 12`), `seed` from the layer id through `hashWords`, so a layer's transition is stable between calls. The window is the first (in) or last (out) `duration` frames of the layer, capped to the layer; progress runs 0 to 1 (in) or 1 to 0 (out) with the chosen easing and a hold at the end, in layer time. A spring easing sets the duration. A layer holds one transition: a second call with the same kind and no `params` adds the other edge to the existing one (its keyframes in the window are replaced); another kind or `params` is refused with the fix in the message. For the out edge `angle` keeps meaning the on-screen travel direction: `wipe`, `push` and `blinds` add 180 degrees, `clock` flips `clockwise`. Result: one `updateLayer` and a `resolved` block (frames, easing). `dry_run` and idempotency follow the other intent tools.
- **Manifest and listing.** `get_capabilities` gains `features.transitions` (the ten kinds, all rendering) and `limits.transitions` (feather, point, angle, pixelate cell, noise-dissolve scale, zoom strength, blinds, glitch bands, clock feather). `describe_motion` names a layer's transition and its window. The server instructions point at `add_transition` and `updateLayer`.
- **Size budgets** (the existing deviation from ADR-0035, to be undone by the M8 compaction): the compact tool listing 112 to 116 KB, the capability manifest 11.8 to 13.5 KB, the project JSON schema 100 to 105 KB.
- **Reference scene** `shader-transitions` (640×360, 90 frames): four precomp shots (aurora, stripes, gradient, noise), each a background and a title, stacked; shot 2 comes in with an iris circle, shot 3 with a feathered 30 degree wipe and shot 4 with a seeded glitch, all through the shots' precomp layers. Approved frames 25, 50, 72 and 89.

## Alternatives considered

- **A transition layer that references two layers.** A second kind of cross-layer link to keep valid through reordering, trimming, precomposing and undo; the layer's own backdrop already is the other input.
- **Transitions as effects in layer space.** An effect sees only its layer, never the picture beneath, so a wipe or a push would have nothing to reveal.
- **A component that keyframes the layers.** ADR-0047: a component's subtree cannot reach the layers beneath it, and the component transitions (cover panels) cover the picture, not blend it.
- **GPU trigonometry with a looser tolerance.** Rejected in ADR-0045 for the same reason: a wide tolerance would hide regressions and break cross-GPU previews.

## Consequences

- An agent reveals any shot, precomp or component with ten looks through one tool, and the result stays an editable, retimable property in the document, visible to `describe_motion` and the script SDK.
- Follow-ups:
  - Custom two-input shader transitions: a `custom-shader` kind in the transition union, written in ADR-0055's language with a second `sampleInput` for the backdrop.
  - `build_from_brief` cuts could use shader transitions instead of its cover panels.
  - The float64 reference compositor is slow per pixel for the displacing kinds; the tests use small frames.
  - The budget test mocks a constant instead of a real frame at the limit.
  - If the puppet-deform branch (which also uses scene format 14) merges first, this format becomes 15: renumber the version, migration and fixtures.
  - The tool listing, manifest and schema budgets come back down with the M8 compaction.
