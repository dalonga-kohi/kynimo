# Kynimo — Capability map

What the engine can express, and how agents reach it over MCP. Benchmark: the 2D core of Adobe After Effects. Decision: [ADR-0008](decisions/0008-ae-grade-engine-simple-editor.md). Code authoring: [ADR-0012](decisions/0012-code-authoring.md). Media, 3D and renderer: [ADR-0013](decisions/0013-media-3d-gpu-renderer.md), drawing backend: [ADR-0016](decisions/0016-drawing-backend.md).

**Principle: deep engine, simple editor.** Most users drive Kynimo through their assistant, so every capability below is in the scene format and exposed as MCP tools. The human surface starts as a player with comments, then a simple editor (viewer, timeline, layers, inspector) that grows toward an After Effects-like workflow after beta (ADR-0035); it doesn't need a control for every capability. If the scene graph can't represent something, neither surface can do it.

`beta` below is a plan, not a claim about the running build. What a build actually draws is in its capability manifest (`get_capabilities`, ADR-0028); what has shipped is checked off in [ROADMAP.md](ROADMAP.md).

Status:

- `beta`: ships before the private beta, and has a roadmap item.
- `v1.x`: the schema v1 design leaves room for it so adding it needs no breaking change. It ships after beta.
- `later`: not designed for yet.
- `no`: out of scope.

## Document model

- A **project** holds assets and compositions.
- A **composition** has a size, frame rate, duration and an ordered layer list. One composition is the project's main one.
- A **scene** is a composition placed in the main composition's sequence, so scenes and precomps are the same concept.
- A precomp layer references a composition by id. References must not form a cycle (validated).
- **Audio** has one model: audio layers. Beat markers are markers on an audio layer.
- Guideline packs are **pinned by version** in the document. Token values (easings, springs, colors) are resolved against that pinned version, so publishing a new pack version never changes an existing document's pixels. Upgrading the pack is an explicit operation.

## 1. Compositions and time

| Capability                                                     | AE equivalent        | Status |
| -------------------------------------------------------------- | -------------------- | ------ |
| Composition: width, height, frame rate, duration, background   | Composition settings | beta   |
| Nested compositions used as layers (precomps), no cycles       | Precompose           | beta   |
| Integer-frame time model, seconds only at the API edge         | —                    | beta   |
| Layer in/out points, start offset                              | Layer bar, trim      | beta   |
| Time stretch, reverse                                          | Time stretch         | v1.x   |
| Time remap (keyframed source time)                             | Time remap           | v1.x   |
| Markers on compositions and layers (named, with duration)      | Markers              | beta   |
| Beat markers on audio layers; snap keyframes and cuts to beats | Audio + markers      | beta   |
| Work area / render range                                       | Work area            | v1.x   |

## 2. Layers

| Capability                                                | AE equivalent    | Status |
| --------------------------------------------------------- | ---------------- | ------ |
| Shape layer (contents tree, see §4)                       | Shape layer      | beta   |
| Text layer (see §5)                                       | Text layer       | beta   |
| Image layer                                               | Footage          | beta   |
| Video layer (pre-decoded to frames with FFmpeg, see note) | Footage          | beta   |
| Solid                                                     | Solid            | beta   |
| Null (invisible parent / controller)                      | Null object      | beta   |
| Precomp layer                                             | Precomp layer    | beta   |
| Collapse transformations on precomp layers                | Collapse         | v1.x   |
| Adjustment layer (effects apply to everything below)      | Adjustment layer | beta   |
| Component instance (typed props, see §8)                  | MOGRT            | beta   |
| Shader generator layer (built-in or custom GLSL, see §8)  | —                | beta   |
| Audio layer (mixed into exports, carries beat markers)    | Audio            | beta   |
| 3D compositing: 3D layers (Z), cameras, lights, depth     | 3D               | v1.x   |
| 3D model layer (glTF / GLB), shader materials             | 3D models        | v1.x   |
| Lottie import → editable layers (unsupported reported)    | —                | v1.x   |
| After Effects project (`.aep`) import                     | Open project     | no     |
| Stable layer ids, human-readable names                    | —                | beta   |
| Render switches: hidden, solo                             | Layer switches   | beta   |
| Editor-only metadata: lock, shy, label color              | Layer switches   | beta   |

Video note: frame-accurate decoding through `<video>` in Chromium isn't deterministic. Video assets are normalized to constant frame rate and decoded to frames with FFmpeg at upload, and the renderer draws those frames. Source frames map to composition frames with exact rational time (source fps / composition fps), never floating-point seconds. An embedded audio track is extracted into its own audio asset at upload. Limits and storage: ADR-0032 (frames as JPEG at most 1920 px and 60 fps, clips up to 60 s, audio as 48 kHz FLAC).

## 3. Transform, hierarchy and compositing

| Capability                                                                          | AE equivalent  | Status |
| ----------------------------------------------------------------------------------- | -------------- | ------ |
| Anchor point, position (or separate X/Y), scale, rotation, skew, opacity            | Transform      | beta   |
| Parenting (any layer, including nulls), no cycles                                   | Parent & link  | beta   |
| Auto-orient along motion path                                                       | Auto-orient    | v1.x   |
| Blend modes (normal, multiply, screen, overlay, add, soft light, difference, …)     | Blending modes | beta   |
| Track mattes: alpha, alpha inverted, luma, luma inverted; matte from any layer      | Track matte    | beta   |
| Masks: path, feather, expansion, opacity, mode (add, subtract, intersect), inverted | Masks          | beta   |
| Motion blur (shutter angle/phase, fixed sample count)                               | Motion blur    | v1.x   |
| Preserve transparency / stencils                                                    | Stencil        | later  |

## 4. Shapes

| Capability                                                    | AE equivalent                   | Status |
| ------------------------------------------------------------- | ------------------------------- | ------ |
| Primitives: rectangle (corner radius), ellipse, polygon, star | Shape primitives                | beta   |
| Bezier paths, animatable vertex by vertex                     | Path                            | beta   |
| Groups with their own transform                               | Group                           | beta   |
| Fill: solid, linear and radial gradient; fill rule            | Fill / gradient fill            | beta   |
| Stroke: width, caps, joins, dashes + offset                   | Stroke                          | beta   |
| Gradient stroke                                               | Gradient stroke                 | beta   |
| Taper                                                         | Taper                           | v1.x   |
| Operators: trim paths, repeater, round corners                | Path operators                  | beta   |
| Operators: offset paths, merge paths                          | Path operators                  | v1.x   |
| Operators: wiggle paths, zig-zag, pucker & bloat, twist       | Path operators                  | later  |
| Morphing between paths with equal vertex counts               | Path keyframes                  | beta   |
| Morphing between paths with different vertex counts           | —                               | v1.x   |
| SVG import → shape layer                                      | Create Shapes from Vector Layer | beta   |

## 5. Text

Kinetic type is the most-requested motion graphic, so text gets the deepest model.

| Capability                                                                                                                                                   | AE equivalent         | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------ |
| Point and box text; font family, weight, size, tracking, leading, alignment, case                                                                            | Character / Paragraph | beta   |
| Bundled fonts + uploaded custom fonts, pinned by content hash (deterministic shaping)                                                                        | —                     | beta   |
| Auto-fit text to box                                                                                                                                         | —                     | beta   |
| Keyframed source text                                                                                                                                        | Source text           | v1.x   |
| Rich runs (mixed weight/color in one layer)                                                                                                                  | Per-character style   | v1.x   |
| Text animators: per-glyph position, scale, rotation, opacity, fill, blur, tracking                                                                           | Text animators        | beta   |
| Range selectors: by character / word / line; start, end, offset; shapes square, ramp up/down, triangle, round, smooth; ease high/low; seeded randomize order | Range selector        | beta   |
| Additional orders: reverse, center-out, edges-in                                                                                                             | — (Kynimo extension)  | beta   |
| Text on a path                                                                                                                                               | Path options          | later  |

## 6. Animation

| Capability                                                                                                                                                   | AE equivalent          | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------ |
| Keyframe tracks on every animatable property (numbers, vectors, colors, paths, gradients)                                                                    | Keyframes              | beta   |
| Interpolation: linear, cubic bezier (temporal handles), hold                                                                                                 | Keyframe interpolation | beta   |
| Springs (damping + response) as a keyframe interpolation, see note                                                                                           | —                      | beta   |
| Spatial interpolation: bezier motion paths with handles                                                                                                      | Motion path            | beta   |
| Separate X/Y tracks for position                                                                                                                             | Separate dimensions    | beta   |
| Separate dimensions on other properties (scale, anchor)                                                                                                      | Separate dimensions    | v1.x   |
| Roving keyframes (constant speed through a path)                                                                                                             | Rove across time       | later  |
| Easing and spring **tokens** from the pinned guideline pack                                                                                                  | —                      | beta   |
| Behaviors, typed and seeded, in place of expressions: wiggle, loop (cycle, ping-pong, offset), inertia/overshoot, follow/link to another property, oscillate | Expressions            | beta   |
| Presets: named animation recipes (fade-up, scale-in, mask-reveal, typewriter, …) expanded into keyframes                                                     | Animation presets      | beta   |
| Stagger: apply an animation across layers or glyphs with offset, order and rhythm token                                                                      | Sequence layers        | beta   |
| Free-form JavaScript expressions                                                                                                                             | Expressions            | no     |

Behaviors cover what expressions are mostly used for without arbitrary code (ADR-0001, determinism invariant). Motion that really needs code goes into a custom component or shader (§8).

Behaviors today (ADR-0039, format v7): up to 16 per transform layer, on `anchorPoint`, `position`, `scale`, `rotation`, `skew` and `opacity`. Types: `wiggle` (seeded value noise, octaves, `linked` axes), `oscillate` (sine, triangle, square, sawtooth), `loop` (in or out; cycle, pingpong, offset, continue), `inertia` (overshoot and settle after a keyframe lands) and `link` (another layer's property × multiply + offset, optionally `delay` frames later; cycles refused). Ops `addBehavior`, `updateBehavior`, `removeBehavior` through `apply_ops`; `describe_motion` lists each behavior as a line and the manifest states the limits, including a per-frame budget of 100 000 link steps. `add_behavior` is a tool (ADR-0040); behavior presets are later.

Spring note: a spring segment runs from its keyframe toward the next keyframe's value, and its length is set by the spring's settle time. The next keyframe must sit at or after that settle frame. Placing it earlier is a validation error, and the error suggests a fix op: move the keyframe to the settle frame, or switch the segment to bezier. Every stored keyframe value is therefore the value rendered at its frame, and no velocity carries into the next segment. `animate` places keyframes at settle frames automatically.

## 7. Effects

Effects stack per layer and on adjustment layers (ADR-0042). Use `add_effect` to insert an effect, `get_layer` to inspect the stack, and `setEffects` via `apply_ops` to edit, reorder or remove effects. Parameters use `{ value }` or `{ keyframes }` in layer time. Look up the fields in `get_layer_schema`.

Adjustment layers filter the composite below them in the same composition. Their masks, track mattes and opacity control where and how strongly the finished filter appears. `blur-in` animates a layer from blurred and transparent to sharp at its original opacity.

| Capability                                                                       | AE equivalent               | Status |
| -------------------------------------------------------------------------------- | --------------------------- | ------ |
| Gaussian blur                                                                    | Gaussian blur               | beta   |
| Drop shadow, glow                                                                | Drop shadow, glow           | beta   |
| Color: brightness/contrast, hue/saturation, tint, fill                           | Color correction            | beta   |
| Directional blur, levels, gradient ramp, seeded noise / grain                    | Various                     | v1.x   |
| Inner shadow                                                                     | Layer style (not an effect) | v1.x   |
| Turbulent displace (seeded), chromatic aberration, vignette                      | Various                     | later  |
| Shader effects: built-in library + custom GLSL with animatable uniforms (see §8) | Third-party plugins         | beta   |
| Particles                                                                        | Third-party plugins         | later  |

## 8. Components, code, guidelines, quality

Code is a first-class way to build (ADR-0012, ADR-0036). **Scripts** run once at authoring time: the agent writes TypeScript against an SDK generated from the operation schemas, and the result is an ordinary batch of operations, so nothing of the script is in the render path. Components and shaders run at render time: Agents and users write custom components (TypeScript, `evaluate(props, frame, style) → layer subtree`) and shaders (GLSL fragment shaders with declared uniforms). Both are sandboxed, validated on submit, stored per project as versioned, content-hashed definitions, and pinned by id + version in the document. A component's `evaluate` runs every frame and returns a layer subtree derived at render time (not stored), so the instance is edited through its props. A shader's props are animatable uniforms; effect shaders get their input texture(s), the layer-local frame, fps, resolution and a document-derived seed. Code runs under resource limits. Nothing draws outside these nodes.

| Capability                                                                                       | Status |
| ------------------------------------------------------------------------------------------------ | ------ |
| Components: typed props schema, style-aware, deterministic `evaluate` → layer subtree            | beta   |
| Built-in library: kinetic type, logo reveal, lower third, transitions, backgrounds               | beta   |
| Built-in library: charts, device mockups                                                         | v1.x   |
| Custom components in sandboxed TypeScript, defined over MCP (`define_component`)                 | beta   |
| Custom 2D shaders in GLSL (effect or generator layer), defined over MCP (`define_shader`)        | beta   |
| Built-in shader library: backgrounds, textures, transitions, looks                               | beta   |
| Shaders on 3D layers and models (materials)                                                      | v1.x   |
| Scripts: TypeScript run once in a sandbox, compiled to scene operations (`run_script`, ADR-0041) | beta   |
| Code panel in the web editor; local CLI / dev mode                                               | later  |
| Guideline packs: visual + motion tokens, choreography rules                                      | beta   |
| Quality report: rule id, severity, scene-graph location, frame range, suggested fix op           | beta   |

## 9. Output

| Capability                                 | Status |
| ------------------------------------------ | ------ |
| Preview frames (PNG), contact sheets       | beta   |
| Short preview clips                        | beta   |
| Export MP4 (H.264), WebM (VP9, alpha), GIF | beta   |
| ProRes 4444 / PNG sequence with alpha      | later  |
| Lottie export (subset)                     | later  |
| Shareable preview links                    | beta   |
| Share page: player, frame-pinned comments  | beta   |
| In-chat player where the client renders UI | beta   |

## Determinism

The invariant is "same document + same frame → same pixels". It's guaranteed where frames are produced: headless Chromium workers on a pinned browser version and a pinned software rasterizer, with bundled and uploaded fonts pinned by content hash (missing glyphs fall back to a pinned bundled font), pre-decoded video and seeded randomness. The live preview in a user's browser uses the same drawing code and is visually equivalent but not bit-identical across GPUs and drivers. Drawing is split (ADR-0016): CanvasKit (Skia WASM) rasterizes shapes, images and text on the CPU, and our own **WebGL2** compositor runs blend modes, mattes, mask application (mask coverage is rasterized on the CPU, ADR-0020), the effect list and shaders, on SwiftShader in workers. Shaders get only their declared inputs (ADR-0012), never wall-clock time.

## MCP surface

The MCP tools are where most users meet Kynimo, so they're designed for how agents actually work.

### Design principles

1. **Same operations as the editor.** Every tool compiles to the typed scene operations in `@kynimo/scene`. Anything an agent does is undoable and editable in the UI.
2. **Batch and transactional.** `apply_ops` applies a list of operations atomically and returns one new document version. A full entrance animation is one call, not forty.
3. **Intent over math.** Agents are unreliable at bezier handles and frame arithmetic, and good at stating intent. Intent tools (`animate`, `apply_preset`, `stagger`, `retime`) take tokens or milliseconds, then expand them into exact keyframes the agent can still inspect and adjust.
4. **Typed selectors.** Layers are addressed by id, by name, or by a structured, schema-validated selector, e.g. `{ "name": "title*" }`, `{ "type": "text", "composition": "scene-2" }`. Selectors resolve against the document as it stands when each op runs (so later ops in a batch see earlier ones), and change records store the concrete layer ids, so undo, replay and conflict detection always hit the same layers.
5. **Compact reads.** `get_scene` returns a summary by default (layers, timing, what animates when) and full detail on request, so large projects don't flood the context window.
6. **The agent sees its work.** Frames, contact sheets and a motion timeline summary are returned in the tool result.
7. **Actionable feedback.** Validation errors and quality findings name the exact location and the operation that fixes it.
8. **Optimistic concurrency.** Writes carry the base version, so agent edits and edits in the open editor never silently overwrite each other. The editor shows agent edits live.
9. **Per-actor undo.** `undo` reverts the caller's own most recent batch, not whatever changed last. It's version-checked: if a later edit by someone else touches the same properties, undo fails with a conflict instead of discarding that edit. Property edits are checked per property; adding or removing a layer or marker is checked on the whole item, and reordering on the layer's position.
10. **Versioned contracts.** Schema-validated input and output on every tool; breaking change → new tool name.
11. **Honest capabilities.** A capability manifest generated from code says what this build renders, accepts without rendering (and why), or lacks. Every render result lists what it skipped. Nothing is dropped silently (ADR-0018).
12. **Retry-safe writes.** Every mutating tool takes an idempotency key: a retry after a dropped connection returns the original result instead of applying twice, and `get_write_outcome` tells the agent whether a write landed (ADR-0018).
13. **Bounded renders.** Render tools declare their limits in their schemas and reject oversized requests with values that fit. Deterministic results are cached; long renders are cancellable jobs with progress (ADR-0018).
14. **Fidelity reports.** Imports and exports report missing assets and fonts, dropped, flattened and approximated features. Imports support a dry run (ADR-0018).
15. **A bounded listing.** `tools/list` stays under a byte budget (60 KB, raised to 70 KB for the intent tools in ADR-0040 and to 75 KB for `run_script` in ADR-0041) as tools are added (ADR-0030, ADR-0035); detail lives in on-demand schemas and resources.

### Tool groups (target)

| Group    | Tools                                                                                                                                                                | Milestone |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Project  | `create_project`, `list_projects`, `get_project`, `upload_asset`, `list_assets`                                                                                      | M3        |
| Read     | `get_scene` (summary/full), `get_layer`, `find_layers` (selector), `describe_motion` (timeline summary), `get_capabilities`, `get_write_outcome`, `get_layer_schema` | M3        |
| Precise  | `apply_ops` (batch), `add_layer`, `update_layer`, `set_keyframes`, `add_mask`, `set_matte`, `precompose`, `undo`, `redo`                                             | M3        |
| Precise  | `add_behavior` (M4, ADR-0040), `add_effect` (with Effects)                                                                                                           | M4        |
| Intent   | `animate`, `apply_preset`, `list_presets`, `stagger`, `retime` (ADR-0040; `dry_run` on each)                                                                         | M4        |
| Code     | `run_script` (TypeScript → one validated batch of at most 500 operations, `dry_run`; ADR-0036, ADR-0041)                                                             | M4        |
| Intent   | `add_component`, `build_from_brief`                                                                                                                                  | M6        |
| Code     | `define_component`, `define_shader`, `list_definitions`                                                                                                              | M6        |
| Intent   | `sync_to_beats`                                                                                                                                                      | M7        |
| Style    | `list_styles`, `apply_style`, `get_tokens`, `check_quality`                                                                                                          | M5        |
| Feedback | `render_frames`, `render_contact_sheet`                                                                                                                              | M3        |
| Output   | `render_preview_clip`, `export`, `get_export_status`, `cancel_export`, `get_preview_link`                                                                            | M7        |
| Review   | `list_comments`, `resolve_comment` (frame-pinned comments from the share page)                                                                                       | M8        |

MCP **resources** expose the scene schema, the token list of the pinned style, the preset catalog, the component catalog, the shader catalog (built-in and project definitions) and the capability manifest, so agents can look things up instead of guessing. The scene, operation and layer schemas and the manifest ship in M3 (ADR-0028); each catalog arrives with the milestone that creates its data (the preset catalog is live: `kynimo://presets` and `list_presets`, ADR-0040; the SDK declarations for scripts are `kynimo://sdk`, ADR-0041).
