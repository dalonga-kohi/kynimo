# 0027 — `describe_motion`: keyframe segments

- Status: accepted (completes the M3 render and feedback item with ADR-0026)
- Date: 2026-11-08

## Context

Agents are unreliable at frame arithmetic and at reading bezier handles (CAPABILITIES.md, principle 3). `get_scene`'s summary says which properties are keyframed between which frames, not what they do. Reading the full document to answer "what moves when, from where to where, with what easing" costs a lot of context. Rendering frames shows the result but not the timing that produced it.

## Decision

- **Segments from the keyframes, not samples.** For each layer of one composition and each keyframed track (found structurally with the same walker as `get_scene`, so new animatable properties appear without changes), `describe_motion` lists one segment per pair of consecutive keyframes:
  - frames are in composition time (`startFrame` + keyframe frame), with seconds at the composition frame rate;
  - `from` / `to` values are rounded to 3 decimals; paths become a vertex count, and other values over 160 characters of JSON are summarized and left to `get_layer`;
  - easing is that of the outgoing keyframe: `linear`, `hold`, `bezier` with its curve, or `spring` with its damping, response and `settle_frame`, the composition frame it comes to rest on (the next keyframe must sit at or after it);
  - `curved` marks position segments bent by spatial tangents, and `outside_layer_range` marks segments none of whose motion falls inside the layer's in/out range.
  - A track with one keyframe is listed as `constant`.
- Nothing is evaluated, so parenting and precomp nesting are reported, not resolved. Each layer carries its parent, and a precomp layer carries the composition it shows, its time offset (in this composition's frames) and the nested frame rate: composition frame f shows the nested composition at f − offset, converted to its frame rate and floored. To describe the nested layers, call again with that composition. Resolved values per frame need sampling the engine; that is an additive option if agents need it.
- No prose and no easing names. Classifying curves ("ease-out") needs heuristics that can mislabel a curve. The exact curve is the contract; tokens (M5) will give names.
- **Filters and limits.** An optional layer selector (matched within the composition, with an error naming the compositions where it does match) and a `from_frame`..`to_frame` window, which leaves out layers that are not on screen during it. Parents of the listed layers are always listed too (marked `parent_of_listed`), on screen or not, because their motion moves the children. At most 1000 segments are listed; `truncated_segments` counts the rest, in total and per property, and a property cut entirely stays listed with no segments, so a cut layer never looks static.

## Consequences

- An agent can check timing and easing in one compact call, then render to check the look (ADR-0026).
- The tool listing is ~58.7 KB of the 60 KB budget. The next tool does not fit without the structural fix ADR-0025 and ADR-0026 deferred to the MCP resources item, so that item must do it.
- Output schemas list segment values as unknown, because their type depends on the property.
