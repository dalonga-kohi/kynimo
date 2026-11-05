# 0009 — Scene schema conventions (Zod 4)

- Status: accepted
- Date: 2026-11-05

## Context

Scene schema v1 (roadmap M1) fixes the shape of every stored document. Agents write these documents through MCP, so the schema is also an input boundary that receives untrusted data. Choices made here are expensive to change later, because tightening a rule or adding a required field rejects or rewrites documents that already exist.

## Decision

- **Zod 4** is the schema library. It is already a peer dependency of the MCP SDK, so tool schemas and the scene schema share one library, and `z.toJSONSchema` produces the schema resource for M3. Types are inferred from the schemas.
- **Explicit canonical documents.** No schema defaults. Unknown keys are rejected (`strictObject`) so agent typos surface. Colors are lowercase hex, ids are lowercase slugs, numbers must be finite.
- **Ids** are branded, caller-supplied strings. Layer, marker and composition ids are unique across the project; shape item ids are unique within their layer. Operations generate ids from a seeded counter, never randomly.
- **Layers are listed top-first.** Layer keyframes and markers are in layer time: composition frame = `layer.startFrame + frame`, so sliding a layer moves its animation and markers with it.
- **Animatable properties are `{ value } | { keyframes }`**, written as one object with optional keys plus an exactly-one check, not a Zod union, so validation errors keep their precise path. The TypeScript types are declared as the union. Position additionally allows `{ separate: { x, y } }` and spatial handles on keyframes.
- **Interpolation belongs to the outgoing keyframe:** linear, hold, cubic-bezier (CSS-style, normalized time) or spring (damping ratio + response seconds). A spring segment lasts `springSettleFrames(spring, fps)` frames, defined once in `@kynimo/scene` and shared by validation and the engine; the next keyframe must sit at or after that frame.
- **Pinned references:** the style pack (`style`) and each component instance (`componentVersion`) are pinned by version, so publishing a new version never changes an existing document. Assets pin `sha256` and use store-relative keys, never URLs or paths.
- **Frame rate is an exact ratio** `{ num, den }`.
- **Hostile input is bounded.** Arrays, sizes, fps and duration have limits. Recursive structures (shape groups, component props) are checked by an iterative depth check that runs before the recursive schema and aborts with one pathed issue. Parent-cycle and precomp-cycle checks are linear time. Validation must never throw, overflow the stack, or produce error output that grows faster than the input.
- **Text content** is stored as `{ value }` and is constant-only: strings cannot be interpolated. Keyframed source text (`v1.x`) will allow only hold keyframes, which loosens the rule and needs no migration.
- Cross-reference rules (uniqueness, references, cycles, spring timing) live in one project-level integrity pass, with messages that name the location and the fix.

## Consequences

- New animatable properties get keyframes, spring checks and error paths for free by using `animatable`.
- The exported JSON Schema is large (about 177 KB inline) because every property carries a keyframe form; it has a size budget in tests and is emitted with `reused: "ref"` for the MCP resource (about 39 KB, budgeted at 60 KB in tests).
- `springSettleFrames` uses `Math.exp`/`Math.log`, which are not guaranteed bit-identical across JS engines. A settle frame could in theory land one frame differently on another runtime. If that ever matters, replace them with a table or a fixed-point implementation.
- Interpolation can push a value outside its property's domain (bezier overshoot or a spring on opacity above 1, a negative radius, skew past ±85). The engine ADR must define clamping per property; the schema only validates stored values.
- A future token interpolation (`{ type: "token", name }`, M5) is an additive union variant, but its spring timing check needs the pinned pack, so it moves from schema validation into the guideline-aware layer.
- Interpolating paths with different vertex counts, per-dimension spatial paths, time remap and the other `v1.x` items are additive: new optional fields or new union variants.
- Any later change to these conventions needs a `SCENE_FORMAT_VERSION` bump and a migration. Version 1 stays unbumped until this work ships.
