# 0038 — Text animators and range selectors

- Status: accepted (format v6)
- Date: 2026-11-10

## Context

Per-character and per-word reveals carry most launch videos, so text animators are the first M4 feature held to reference-scene quality. The model is After Effects': an animator holds properties and a range selector says how much of them each unit of text gets. We have no After Effects here, so where its behavior was not documented the definitions below are ours, and the tests pin them.

Constraints: layout must not shift while an animator runs (except for tracking), rendering must stay deterministic across Node and the pinned Chromium, and a text layer without animators must draw bit-identically, so every golden hash and approved frame stays as it is.

## Decision

- **Format v6.** A text layer gains `animators` (at most 8). An absent list means none, so layer bodies written for format 5 (including `apply_ops` batches, ADR-0024) still validate; the 5 → 6 migration writes `[]` into stored documents. Each animator has a `name`, a `selector` and `properties`. Every number is animatable; values are fractions and ratios like the rest of the schema, not percentages.
- **Selector.** `unit` (`characters`, `words`, `lines`), `start`, `end` (0..1), `offset` (any number), `shape` (`square`, `ramp-up`, `ramp-down`, `triangle`, `round`, `smooth`), `easeHigh`, `easeLow` (0..1), `order` (`forward`, `reverse`, `center-out`, `edges-in`, `random`), `seed` and `amount` (−1..1).
  - **Window.** It runs from `min(start, end) + offset` to `max(start, end) + offset` on a 0..1 axis over the units. It does not wrap.
  - **Partial selection.** A unit's weight is the exact average of the shape's profile over the unit's slice of the axis, so a window edge that cuts a unit selects it partly, and sweeping `end` fades characters in one by one. Square, ramps, triangle and smooth use closed-form antiderivatives; round uses `asin` and `sqrt`.
  - **Order** assigns each unit a slot on the axis. `center-out` ranks units by distance from the middle (ties to the earlier unit), `edges-in` reverses that, `random` is a Fisher–Yates shuffle from a mulberry32 generator seeded by `seed`. Nothing reads a clock or `Math.random`.
  - **Ease** reshapes the 0..1 weight with a cubic bezier that is linear at 0 and a full ease-in-out at 1 (`easeLow` flattens the bottom, `easeHigh` the top). `amount` multiplies the result; a negative amount pushes additive properties the other way (fill and opacity are clamped, so they only respond to positive weights).
- **Units.** Characters are our approximation of grapheme clusters (combining marks, variation selectors, skin tones, ZWJ sequences, flag pairs), not `Intl.Segmenter`, whose data differs between engines. Spaces count as characters; line breaks are not units. A word is a run of non-space characters plus the space after it (leading spaces join the first word; a line break ends a word). Lines are the lines the layout actually made, wrapped lines included, counted before a box hides any that do not fit; empty lines are skipped.
- **Properties.** `position` and `rotation` (degrees) add `weight × value`. `scale` and `opacity` move from 1 toward their value by the weight and multiply across animators (opacity stays in 0..1). `fill` blends toward its color by the weight, in OKLab like keyframed colors. `tracking` (thousandths of an em) and `blur` add. Animators apply in list order. Scale and rotation pivot at the middle of each character on its baseline.
- **Rendering.** Layout runs once, as if there were no animators. When at least one character changes, each non-space cluster is shaped as its own paragraph and drawn at the position the full layout gave it, under its own transform. Identical clusters in the same color share one shaped paragraph. When nothing changes on a frame, the layer is one paragraph exactly as before.
  - **Tracking** moves a cluster by the tracking of the clusters before it on its line; a centered or right-aligned line grows around its anchor. It does not re-wrap: the base layout chose the lines. That is narrower than After Effects, which re-lays out the paragraph.
  - **Shaping across clusters is lost** while an animator is active: ligatures and joining scripts (Arabic) are drawn per cluster, so they can change at the first frame an animator touches the layer.
  - **Blur** is accepted but not drawn: it needs the effect path. A blur-only animator does not take the per-glyph path. Renders carry an `animator-blur` warning, and the manifest lists it as `accepted`.
- **A glyph budget**, like the shape path budget of ADR-0034. An animated layer may draw at most `MAX_ANIMATED_CLUSTERS` (1 000) non-space clusters per frame and a frame at most `MAX_FRAME_ANIMATED_CLUSTERS` (4 000) across layers, precomps included. Calibration: a ramp animator over 2 000 glyphs took about 0.5 s a frame in Node, against 24 ms for the same text as one paragraph, because fading changes each cluster's color so shaped paragraphs rarely repeat; the limits keep a frame near a second. Both are charged before any cluster is shaped and refused with a `RenderError` that says what to lower. The manifest states them.
- **Reveals** select the part not yet shown: opacity 0 on the animator, `start` swept 0 → 1. A reference scene (`packages/capture/reference/text-animators`) pins the sweep, tracking, centered alignment and accented multi-line text frame by frame.
- **`describe_motion`** lists each animator as one line ("rise: position, opacity by word, square range 0..animated"); its keyframed selector and property tracks appear as ordinary motion properties.
- **No new operations yet.** Animators enter through `add_layer`, like the rest of a text layer's fields; editing them in place arrives with the intent tools (`animate`, `stagger`, `apply_preset`).

## Consequences

- The typewriter, word-by-word, fade-up and blur-in presets of the intent tools are data over this model: animate `end` or `offset`, pick a unit and a property.
- Per-glyph drawing costs one shaped paragraph per distinct cluster and frame. The budget bounds it; a cache across frames is an optimization for when exports need it (M7).
- The selector profile, the ease curve and the unit definitions are ours. If imported After Effects projects (v1.x) disagree, the engine function changes, not the format.
- Not settled: per-animator ids for in-place editing (the intent tools may need them, which would be an additive format change); `characters excluding spaces`, `index` and per-word anchor grouping as After Effects offers; blur as a real per-glyph effect once effects land.
