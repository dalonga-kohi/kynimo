# Kynimo — Capability map

What the engine can express, and how agents reach it over MCP. Benchmark: the 2D core of Adobe After Effects. Decision: [ADR-0008](decisions/0008-ae-grade-engine-simple-editor.md).

**Principle: deep engine, simple editor.** Most users drive Kynimo through their assistant, so every capability below is in the scene format and exposed as MCP tools. The editor is a usable companion (viewer, timeline, layers, inspector) and doesn't need a control for every capability. If the scene graph can't represent something, neither surface can do it.

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
| Video layer (pre-decoded to frames with FFmpeg, see note) | Footage          | v1.x   |
| Solid                                                     | Solid            | beta   |
| Null (invisible parent / controller)                      | Null object      | beta   |
| Precomp layer                                             | Precomp layer    | beta   |
| Collapse transformations on precomp layers                | Collapse         | v1.x   |
| Adjustment layer (effects apply to everything below)      | Adjustment layer | beta   |
| Component instance (typed props, see §8)                  | MOGRT            | beta   |
| Audio layer (mixed into exports, carries beat markers)    | Audio            | beta   |
| Camera, lights, 3D layers                                 | 3D               | later  |
| Stable layer ids, human-readable names                    | —                | beta   |
| Render switches: hidden, solo                             | Layer switches   | beta   |
| Editor-only metadata: lock, shy, label color              | Layer switches   | beta   |

Video note: frame-accurate decoding through `<video>` in Chromium isn't deterministic. Video assets are decoded to frames with FFmpeg at upload, and the renderer draws those frames.

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
| Bundled, pinned fonts only (deterministic shaping)                                                                                                           | —                     | beta   |
| Auto-fit text to box                                                                                                                                         | —                     | beta   |
| Keyframed source text                                                                                                                                        | Source text           | v1.x   |
| Rich runs (mixed weight/color in one layer)                                                                                                                  | Per-character style   | v1.x   |
| Text animators: per-glyph position, scale, rotation, opacity, fill, blur, tracking                                                                           | Text animators        | beta   |
| Range selectors: by character / word / line; start, end, offset; shapes square, ramp up/down, triangle, round, smooth; ease high/low; seeded randomize order | Range selector        | beta   |
| Additional orders: reverse, center-out                                                                                                                       | — (Kynimo extension)  | beta   |
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

Behaviors cover what expressions are mostly used for without arbitrary code (ADR-0001, determinism invariant).

Spring note: a spring segment runs from its keyframe toward the next keyframe's value, and its length is set by the spring's settle time. The next keyframe must sit at or after that settle frame. Placing it earlier is a validation error, and the error suggests a fix op: move the keyframe to the settle frame, or switch the segment to bezier. Every stored keyframe value is therefore the value rendered at its frame, and no velocity carries into the next segment. `animate` places keyframes at settle frames automatically.

## 7. Effects

Effects stack per layer and on adjustment layers. They render deterministically under the conditions in [Determinism](#determinism).

| Capability                                                    | AE equivalent               | Status |
| ------------------------------------------------------------- | --------------------------- | ------ |
| Gaussian blur                                                 | Gaussian blur               | beta   |
| Drop shadow, glow                                             | Drop shadow, glow           | beta   |
| Color: brightness/contrast, hue/saturation, tint, fill        | Color correction            | beta   |
| Directional blur, levels, gradient ramp, seeded noise / grain | Various                     | v1.x   |
| Inner shadow                                                  | Layer style (not an effect) | v1.x   |
| Turbulent displace (seeded), chromatic aberration, vignette   | Various                     | later  |
| Particles                                                     | Third-party plugins         | later  |

## 8. Components, guidelines, quality

| Capability                                                                             | Status |
| -------------------------------------------------------------------------------------- | ------ |
| Components: typed props schema, style-aware, deterministic `evaluate` → layer subtree  | beta   |
| Built-in library: kinetic type, logo reveal, lower third, transitions, backgrounds     | beta   |
| Built-in library: charts, device mockups                                               | v1.x   |
| Custom components in sandboxed TypeScript                                              | beta   |
| Guideline packs: visual + motion tokens, choreography rules                            | beta   |
| Quality report: rule id, severity, scene-graph location, frame range, suggested fix op | beta   |

## 9. Output

| Capability                                 | Status |
| ------------------------------------------ | ------ |
| Preview frames (PNG), contact sheets       | beta   |
| Short preview clips                        | beta   |
| Export MP4 (H.264), WebM (VP9, alpha), GIF | beta   |
| ProRes 4444 / PNG sequence with alpha      | later  |
| Lottie export (subset)                     | later  |
| Shareable preview links                    | beta   |

## Determinism

The invariant is "same document + same frame → same pixels". It's guaranteed where frames are produced: headless Chromium workers on a pinned browser version and a pinned software rasterizer, with bundled fonts, pre-decoded video and seeded randomness. The live preview in a user's browser uses the same drawing code and is visually equivalent but not bit-identical across GPUs and drivers. The drawing backend is chosen in an M2 ADR. It must support blend modes, mattes, masks and the effect list under these conditions; Canvas 2D, WebGL2 and SVG are all candidates.

## MCP surface

The MCP tools are where most users meet Kynimo, so they're designed for how agents actually work.

### Design principles

1. **Same operations as the editor.** Every tool compiles to the typed scene operations in `@kynimo/scene`. Anything an agent does is undoable and editable in the UI.
2. **Batch and transactional.** `apply_ops` applies a list of operations atomically and returns one new document version. A full entrance animation is one call, not forty.
3. **Intent over math.** Agents are unreliable at bezier handles and frame arithmetic, and good at stating intent. Intent tools (`animate`, `apply_preset`, `stagger`, `retime`) take tokens and seconds, then expand them into exact keyframes the agent can still inspect and adjust.
4. **Typed selectors.** Layers are addressed by id, by name, or by a structured, schema-validated selector, e.g. `{ "name": "title*" }`, `{ "type": "text", "composition": "scene-2" }`. Selectors resolve against the document as it stands when each op runs (so later ops in a batch see earlier ones), and change records store the concrete layer ids, so undo, replay and conflict detection always hit the same layers.
5. **Compact reads.** `get_scene` returns a summary by default (layers, timing, what animates when) and full detail on request, so large projects don't flood the context window.
6. **The agent sees its work.** Frames, contact sheets and a motion timeline summary are returned in the tool result.
7. **Actionable feedback.** Validation errors and quality findings name the exact location and the operation that fixes it.
8. **Optimistic concurrency.** Writes carry the base version, so agent edits and edits in the open editor never silently overwrite each other. The editor shows agent edits live.
9. **Per-actor undo.** `undo` reverts the caller's own most recent batch, not whatever changed last. It's version-checked: if a later edit by someone else touches the same properties, undo fails with a conflict instead of discarding that edit. Property edits are checked per property; adding or removing a layer or marker is checked on the whole item, and reordering on the layer's position.
10. **Versioned contracts.** Schema-validated input and output on every tool; breaking change → new tool name.

### Tool groups (target)

| Group    | Tools                                                                                                            | Milestone |
| -------- | ---------------------------------------------------------------------------------------------------------------- | --------- |
| Project  | `create_project`, `list_projects`, `get_project`, `upload_asset`, `list_assets`                                  | M3        |
| Read     | `get_scene` (summary/full), `get_layer`, `find_layers` (selector), `describe_motion` (timeline summary)          | M3        |
| Precise  | `apply_ops` (batch), `add_layer`, `update_layer`, `set_keyframes`, `add_mask`, `set_matte`, `precompose`, `undo` | M3        |
| Precise  | `add_effect`, `add_behavior`                                                                                     | M4        |
| Intent   | `animate`, `apply_preset`, `stagger`, `retime`                                                                   | M4        |
| Intent   | `add_component`, `build_from_brief`                                                                              | M6        |
| Intent   | `sync_to_beats`                                                                                                  | M7        |
| Style    | `list_styles`, `apply_style`, `get_tokens`, `check_quality`                                                      | M5        |
| Feedback | `render_frames`, `render_contact_sheet`                                                                          | M3        |
| Output   | `render_preview_clip`, `export`, `get_export_status`, `get_preview_link`                                         | M7        |

MCP **resources** expose the scene schema, the token list of the pinned style, the preset catalog and the component catalog, so agents can look things up instead of guessing.
