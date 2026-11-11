# 0040 — Intent tools

- Status: accepted
- Date: 2026-11-11

## Context

Agents are good at stating intent ("fade this in over the base duration, staggered") and unreliable at frame arithmetic and bezier handles (CAPABILITIES.md, design principle 3). `apply_ops` with `setTransformTrack` can express every motion, but every call makes the agent do the math. M4 adds tools that take intent and tokens from the pinned style pack (ADR-0037) and expand into exact operations.

PLAN.md described presets as "data: name, parameters, op template". A template language would grow into a second, worse scripting layer (conditionals for layer types, defaults that depend on the layer, merging tracks).

## Decision

- **`@kynimo/intent`** (new package; depends on `@kynimo/scene`, `@kynimo/engine`, `@kynimo/guidelines`): pure functions `(doc, input) → { ops, resolved }`. No I/O, no clock, no `Math.random` (seeded `mulberry32` for random order). Every refusal is an `IntentError` with a path into the tool input. `run_script` (ADR-0036) shares this code.
- **Tools:** `animate`, `stagger`, `retime`, `apply_preset`, `add_behavior` (writes), `list_presets` (read) and the resource `kynimo://presets`. `add_effect` is not here: it moves to the Effects item, where effects exist to be added.
- **Tokens.** The style is the document's pinned pack, or Keynote's latest when `style` is null; a pinned pack missing from the build is an error. `duration` and stagger `offset` are a token name or whole milliseconds (converted with `millisecondsToFrames`, each delay on its own so rounding doesn't accumulate). `start` and other times are composition frames. Distances are tokens (px at 1080, scaled to the composition) or composition pixels. Responses report frames and the style used.
- **`animate` replaces inside its window.** Keyframes in `[start, start + duration]` (layer time) are replaced by a start and an end keyframe; those outside stay. A missing `from`/`to` is the keyframed value at that edge (behaviors are not applied); `{ by }` adds to it. A spring easing sets the duration to its settle time, and an explicit `duration` with it is refused. A constant track counts as no keyframes; separate X/Y position is refused (use `set_keyframes`).
- **Presets are functions plus data metadata, not op templates.** A preset has `id`, `title`, one-line `description`, `kind` (enter/exit), allowed layer types, a strict zod `params` schema and `expand(ctx, layer, params, timing)`. The window (start, duration, easing) is resolved first and passed in. Transform parts go through `animate`'s expansion, so they share its rules; two parts on one property merge into one op. `list_presets` and `kynimo://presets` give the catalog with each preset's params as JSON Schema; `apply_preset.params` stays an open object in `tools/list`. Shipped: `fade-in`, `fade-up`, `scale-in`, `slide-in`, `pop`, `mask-reveal`, `typewriter`, `word-by-word`, `draw-on` and the exits `fade-out`, `fade-down`, `scale-out`, `slide-out`.
- **`stagger` shifts keyframes, not `startFrame`.** The layer's existing animation moves; its timing and content don't. Calls compound: staggering twice shifts twice. Order is `index`, `reverse`, `center-out` (ties share a delay) or seeded `random`; rhythm is `even`, `accelerate` or `decelerate`. In `apply_preset`, `stagger` offsets each layer's start instead.
- **`retime`** scales and shifts keyframe times around a pivot with `floor(pivot + (f − pivot)·scale + 0.5) + shift`, optionally only inside a window, and refuses collisions, reorderings and springs squeezed below their settle time (with the scale that would fit).
- **A keyframe walker** (`mapLayerKeyframes`, `diffLayerOps`) finds every keyframe of a layer (transform tracks, masks, text animators, shape contents, behaviors) and writes changes back through ops. Fields that no op can write are refused by `stagger` and `retime` with a clear error instead of skipped: text `font.size`, `tracking`, `leading`, `fill`, `box`, and audio `volume`.
- **Two whole-list ops in `@kynimo/scene`,** `setTextAnimators` and `setShapeContents`, because animators and shape contents have no per-item ops. Each replaces the list as one `layer.set` change, so undo works as for other ops. Ops are not part of the stored format: no version bump.
- **`mask-reveal` needs a `box`** (layer space) for shape layers, point text and precomps, whose bounds aren't known from the layer alone; solids, images, videos and box text derive it.
- **Writes.** Intent tools take `base_version` and `idempotency_key` like `apply_ops` and return the operations they wrote plus `resolved`. The idempotency fingerprint is the tool's own input (name, project, base version, arguments), not the produced operations, so a retry replays the stored outcome even after the document moved; a replay returns the write result without `ops`/`resolved`, which are not stored. `dry_run: true` validates the ops with `applyBatch` on a copy and returns them; nothing is stored or recorded. A stale `base_version` is a conflict as in `apply_ops`. `IntentError` becomes a `ToolError("invalid")` with `errors: [{ path, message }]`.
- **Listing.** Tool schemas are compact (loose targets, easing and endpoint bodies with descriptions; the server validates with the full `@kynimo/intent` schemas). Even so, each write tool costs 1.8–2.5 KB (write fields plus output schema), so `tools/list` grows from 58.6 KB to about 69.6 KB and the budget in `server.test.ts` moves to 70 KB. Revisit with the packaging of output schemas if tools keep being added.
- **Instructions** lead with the intent tools; precise tools and `apply_ops` are for everything else.

## Consequences

- An agent states a fade-up or a stagger in one call and gets the exact ops back to inspect, adjust or undo.
- Presets are code reviewed like other code; adding one needs a function, a params schema and tests, not a new template feature.
- Stagger compounding means a repeated call is not idempotent in effect (it is in the write sense: the same key replays).
- Follow-ups: shape bounds for `mask-reveal` without a `box`; `count-up` and `blur-in` (they need number text and effects to render correctly); `add_effect` (with the Effects item); behavior presets; a cheaper listing for write tools.
