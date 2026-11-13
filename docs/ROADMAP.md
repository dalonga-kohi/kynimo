# Kynimo — Roadmap

Feature by feature. Each item is one branch + PR unless noted. Check items off as their PRs merge. Scope per item comes from [CAPABILITIES.md](CAPABILITIES.md): this roadmap covers everything marked `beta`; `v1.x` items follow after the private beta (ADR-0008).

**Where we are as of 2026-11-13**

M0–M2 are done. M3 is done except deployment. M4 is done except the brief suite and the MCP-only kinetic-type reference scene (shape operators, text animators, behaviors, intent tools, `run_script` with its source kept per version, effects, SVG import and built-in shaders done). M5's pack format and four draft packs exist (ADR-0037), with rules and tools still open. M6 is complete with the component model, five built-ins, a structured storyboard tool, project shaders, built-in shader transitions and bounded TypeScript component authoring over MCP (ADR-0058). Transform motion blur (ADR-0053), 2.5D layers with cameras (ADR-0054), and puppet pin deformation (ADR-0056) were pulled forward from v1.x. M7 has export, beat markers (`mark_beats`, `sync_to_beats`, ADR-0052), and shareable MP4 playback links (`get_preview_link`, ADR-0059). An agent can build a document and see frames. It can animate with intent tools and presets, or build a scene with a script. It can export MP4, WebM and GIF with jobs, progress, cancel and a fidelity report (ADR-0048). Style application and quality reports are still open. The milestone order below was confirmed on 2026-11-09 with its risk recorded in PRODUCT.md ("Risks we carry knowingly", ADR-0035).

**How milestones are judged from M4 on:** by the brief suite (PRODUCT.md, "How we know it works"), not only by tests. A milestone that adds agent-facing tools is done when the suite's numbers and frames are in its last PR.

## M0 — Foundation

- [x] Repo, working agreement (CLAUDE.md), reviewer agent, design skills, docs, monorepo skeleton, CI
- [x] Capability map + ADR-0008 (AE-grade engine, simple editor)

## M1 — Scene format + engine core

- [x] Scene schema v1, part 1: project, assets, compositions, layer union, transform + parenting, in/out, markers, render switches, pinned style reference. Schema library decided here. Designed to leave room for every `v1.x` item.
- [x] Scene schema v1, part 2: keyframe tracks (linear, bezier, hold, spring), spatial paths, precomp references with cycle validation
- [x] Migration framework + first migration test
- [x] Scene operations: pure `(doc, op) → doc'` + change records (concrete ids), batches, per-actor undo/redo, typed selectors
- [x] Engine: interpolation (scalars, vectors, colors), cubic-bezier easing, springs (damping + response), spatial motion paths
- [x] Engine: evaluate a document at frame N → resolved layer tree (parenting, precomps; deterministic, tested)

## M2 — Renderer (frames)

- [x] Drawing backend decision (ADR): WebGL2 stack (ADR-0013) for blend modes, mattes, masks, the effect list and shaders, deterministic in workers (see CAPABILITIES.md, "Determinism") → ADR-0016: Skia CPU raster + own WebGL2 compositor
- [x] Draw shapes (fill, stroke, gradients, dashes), images, solids → ADR-0017: AE paint binding, PNG + JPEG, frame plan for the compositor
- [x] Text: font loading strategy (bundled + uploaded fonts pinned by hash), shaping, layout (point/box, auto-fit) → ADR-0019: Inter + Noto Sans fallback, font assets (format v2), After Effects point/box semantics, shrink-only auto-fit
- [x] Masks, track mattes, blend modes → ADR-0020: format v3, CPU mask coverage; ADR-0021: WebGL2 compositor with a JavaScript reference it is tested against
- [x] Headless capture: document + frame → PNG; determinism test (same doc + frame → identical pixels) → ADR-0022: `@kynimo/capture`, whole pipeline in the pinned Chromium, golden pixel + PNG hashes
- [x] Reference scenes (ADR-0018): title card, masked/matted reveal, nested precomp with parenting, image-and-shape product card; approved frames checked in and looked at whenever they change → ADR-0023: plain scene documents in `packages/capture/reference/`, 640×360 approved PNGs compared byte for byte

## M3 — MCP server v1

- [x] Local stdio MCP server: project, read (`get_scene` summary/full, `find_layers`) and precise tools incl. batched `apply_ops` → ADR-0024: `apps/mcp`, `ProjectStore` (memory + JSON dir), `base_version` + `idempotency_key` on every write, `get_write_outcome`, compact tool schemas with `get_layer_schema`
- [x] Mask, matte and precompose ops in `@kynimo/scene` + `add_mask`, `set_matte`, `precompose` tools → ADR-0025: mask list recorded as one change, After Effects "move all attributes" precompose that refuses to break cross-boundary links, composition change records, 50 KB listing budget
- [x] `render_frames` + `render_contact_sheet` returning images, with declared limits, a render cache and skipped-feature reporting (ADR-0018); `describe_motion` timeline summary → ADR-0026: longest-edge downscale in the page, byte-exact contact-sheet cells, in-memory LRU keyed by document hash + `buildId`; ADR-0027: `describe_motion` as keyframe segments in composition frames
- [x] MCP resources: scene schema, preset/component/token catalogs; capability manifest as a resource and `get_capabilities` tool (ADR-0018) → ADR-0028: support tables in the renderer typed over the scene unions, manifest + `kynimo://capabilities`, scene/op/layer schema resources; catalog resources are listed on their M4–M6 items
- [x] Project store (database) + versioned documents + optimistic concurrency; idempotency keys on every write, `get_write_outcome`, undo history persisted with the project (ADR-0018) → ADR-0029: Postgres on `pg` (PGlite in tests), a snapshot per version, row-locked transactions in the store, keys kept 7 days then `expired`
- [x] Asset storage (object storage decision) + `upload_asset` / `list_assets` (images, fonts; SVG moves to SVG import in M4); the tool listing was slimmed first → ADR-0030: lossless compaction of `tools/list`, 59.8 → 52.2 KB; ADR-0031: content-addressed blobs (memory, `--dir`, S3-compatible with R2 first), `addAsset`/`removeAsset` ops, base64 uploads up to 8 MB with metadata read from the file
- [x] Video assets: FFmpeg pre-decode to frames at upload; draw video layers; audio uploads (duration from FFmpeg) → ADR-0032: format v4 (video asset with a pinned frame manifest, video layer), exact rational source frames, system FFmpeg sandboxed by protocol/format whitelists, JPEG frames ≤ 1920 px / 60 fps / 60 s, FLAC audio, retries fingerprinted on the source bytes
- [x] Remote transport (Streamable HTTP) + OAuth → ADR-0033: Kynimo as OAuth resource server for an external issuer (WorkOS AuthKit first; JWTs checked against its JWKS, RFC 9728 metadata), stateless Streamable HTTP, accounts from the token subject with per-account stores (Postgres migration 2)
- [ ] Deploy to the first hosting environment; connect from Claude and ChatGPT. Hosting decision ADR (container with the pinned Chromium + FFmpeg, managed Postgres, R2); health check; structured logs with per-tool latency and error kind; per-account limits on projects, storage and render seconds; measure render seconds per frame on the host. Done when one reference scene is rebuilt from a chat in each client

## M4 — Motion depth

- [x] Shape operators: trim paths, repeater, round corners; path morphing (equal vertex counts) → ADR-0034: format v5, After Effects reach (operators change the paths above them, every paint draws the result), our own fixed-work arc length, repeater copies as groups, path work budgets per layer (500 000 units) and per frame (2 000 000) charged before the work; morphing already shipped with schema v1 part 2
- [x] Text animators + range selectors (character / word / line, shapes, ease, seeded randomize, reverse / center-out) → ADR-0038: format v6, windows that select units partly, per-cluster drawing at the full layout's positions, tracking without re-wrap, per-glyph blur accepted with a render warning, glyph budgets per layer (1 000) and frame (4 000), reference scene
- [x] Behaviors: wiggle, loop, inertia/overshoot, follow/link, oscillate (seeded) → ADR-0039: format v7, per-layer `behaviors` on the transform properties applied in a fixed order after keyframes, analytic velocity for inertia and loop-continue, link cycles refused with a per-frame link-step budget (100 000), `describe_motion` lines and manifest entries, `add_behavior` intent tool left to the intent tools
- [x] Intent tools: `animate`, `apply_preset` (preset catalog, also as an MCP resource), `stagger`, `retime`, `add_behavior` → ADR-0040: new `@kynimo/intent` package of pure expansions over the pinned pack's tokens (Keynote's when none), `animate` replaces keyframes inside its window, presets as functions with params schemas (13 shipped; `count-up` and `blur-in` deferred), stagger shifts keyframes and compounds, `setTextAnimators` and `setShapeContents` ops, `dry_run`, idempotency on the tool input
- [x] `run_script` (ADR-0036): TypeScript run once in the QuickJS sandbox against an SDK generated from the operation schemas, applied as one validated batch; `dry_run`; SDK types as an MCP resource; declared limits. Token names come from `@kynimo/guidelines` → ADR-0041: `@kynimo/script` with one worker thread and a fresh QuickJS instance per run, types erased with `module.stripTypeScriptTypes`, limits (source 64 KB, memory 32 MB, stack 512 KB, 15 000 interrupts, result 2 MB, 5 s backstop, 500 ops per run, 50 intent calls per run, 2 concurrent scripts), the sandbox records and the host replays intent calls through `@kynimo/intent`, SDK declarations at `kynimo://sdk`, `dry_run` with `describe_motion`
- [x] Script source kept per version (ADR-0041) → ADR-0044: `run_script` saves its source and effective seed with the version it writes in all three stores (Postgres migration 3), and the read tool `get_script` returns them (default the latest, 20 recent script versions listed); the listing stayed under its 77 KB budget
- [ ] Brief suite v1 (ADR-0035): five briefs run by a real model over MCP; a report of completion, tool calls, rejected calls, tokens and contact sheets, kept per run so milestones can be compared. Runs on demand, not in CI. Lands right after the intent tools; its first report sets the baseline and compares the same briefs with and without `run_script`
- [ ] Reference scene: kinetic type (ADR-0018), built only with MCP tools
- [x] Effects: Gaussian blur, drop shadow, glow, brightness/contrast, hue/saturation, tint, fill, adjustment layers, `add_effect` and the `blur-in` preset → ADR-0042: format v8, ordered keyframeable stacks, `setEffects`, and bounded compositor passes
- [x] SVG import → shape layer, with a fidelity report and dry run (ADR-0018) → ADR-0043: pure `@kynimo/svg` (inline text up to 512 KB, bounded `fast-xml-parser`), one shape layer with groups per painted element, `<use>` expansion, gradients, a fidelity report of dropped, flattened and approximated features, the `import_svg` intent tool, and a pixel comparison against Chromium's own SVG renderer
- [x] Built-in 2D shader effects and generator layers (backgrounds, textures, looks) → ADR-0045: format v9, a typed `generator` layer (gradient, noise, pattern, aurora) and five looks (vignette, grain, chromatic aberration, posterize, scanlines) with `setGenerator`, CPU-side trig and integer hashing so GPU and float64 reference agree within 1/255, a frame sample budget and raster-pixel reservation, a reference scene

## M5 — Guidelines + quality checks

- [x] Token model (visual + motion) and guideline pack format → ADR-0037: `@kynimo/guidelines`, packs as versioned JSON with fixed token names, rule thresholds with cited sources, packs validated against their own rules
- [ ] Token references in documents: easing/spring and color tokens referenced by name (format bump), resolved against the pack version pinned in the document (ADR-0037, open question)
- [x] First packs as drafts (0.1.0), authored by us (ADR-0035, ADR-0037): Keynote, Playful SaaS, Editorial, Brutalist; each rule cites its source
- [ ] Packs to 1.0.0: measure reference videos frame by frame, a reference scene per pack that a person looks at, tuning on the brief suite; bundle a serif and a mono family so the packs differ in type. An outside motion designer's critique is a gate before public launch
- [ ] Published pack versions immutable once `apply_style` pins them (ADR-0037): deep-freeze `BUILT_IN_PACKS`, and a test pinning a sha256 of each `id@version`'s canonical JSON
- [ ] Quality rules engine + report format (location, frame range, suggested fix op)
- [ ] `list_styles`, `apply_style`, `get_tokens` and `check_quality` tools; token list of the pinned style as an MCP resource

## M6 — Component library v1

- [x] Component model (props schema, evaluate, style-aware) → ADR-0046: `@kynimo/components` with typed prop descriptors, `evaluate(props, ctx)` returning a validated subtree, an engine host hook, drawn by the renderer like a precomp
- [x] First components: kinetic type, logo reveal, lower third, transition set, background → ADR-0047: five built-ins on one shared enter/exit envelope, style-aware, with text-layout estimates in place of font metrics, a cover-transition set and a looping background
- [x] `add_component` with write-time prop validation, version pins, dry run, and the built-in catalog (`list_components`, `kynimo://components`) → ADR-0049
- [x] `build_from_brief` with structured headline, logo, image and video shots, style-aware composition, and one atomic write → ADR-0050
- [x] Sandbox spike for custom components → [ADR-0051](decisions/0051-component-sandbox-spike.md): the measured QuickJS WebAssembly paths exceeded the 4 ms p95 browser gate for eight active instances
- [x] Motion blur, pulled forward from v1.x at the user's request → [ADR-0053](decisions/0053-motion-blur.md): per-layer `motionBlur` (shutter angle, phase, 2 to 64 samples; scene format 11) that samples the layer's transform and opacity across the shutter and accumulates the placements additively; animated contents stay at the center frame; moving shapes and text are cropped to the shutter's reach
- [x] 2.5D layers and cameras, pulled forward from v1.x at the user's request → [ADR-0054](decisions/0054-camera-3d.md): flat cards in 3D (`threeD`, `positionZ`, `rotationX`, `rotationY`, a `camera` layer with zoom and point of interest; scene format 12) projected by a homography with per-pixel level of detail and near clipping, contiguous 3D runs depth-sorted After Effects style, precomps flat; no lights, materials or models
- [x] Shader authoring over MCP with `define_shader`, `list_definitions`, and the project shader catalog. Generators and single-input effects pin immutable, content-hashed GLSL definitions → [ADR-0055](decisions/0055-project-shaders.md)
- [x] Puppet pin deformation, pulled forward from v1.x at the user's request → [ADR-0056](decisions/0056-puppet-deform.md). Layer-space pin tracks drive a bounded ARAP mesh after masks and before effects, with 3D placement and center-frame sampling for motion blur (scene format 15).
- [x] Custom component authoring over MCP with `define_component`, project catalogs and exact version pins. The bounded TypeScript evaluator passed the eight-instance browser gate. [ADR-0058](decisions/0058-project-components.md)
- [x] Built-in shader transitions → [ADR-0057](decisions/0057-shader-transitions.md): format 14, a per-layer `transition` (dissolve, noise dissolve, wipe, clock, iris, blinds, pixelate, push, zoom, glitch) from the composite beneath to the layer, CPU-side trig so GPU and float64 reference agree within 1/255, a frame sample cost, the `add_transition` tool, a reference scene

## M7 — Export pipeline + preview links

- [x] Render workers + job queue; jobs with progress, cancel and idempotent submission (ADR-0018) → ADR-0048: an in-process queue (one job at a time, 4 active per account, 24 h records, keys kept with the job); separate workers and a durable Postgres queue come with deploy
- [x] MP4 / WebM / GIF export with audio layers mixed in and a fidelity report; `render_preview_clip`, `export`, `get_export_status`, `cancel_export` → ADR-0048: raw-frame export sessions and specialised compositor programs (about 4x faster), FFmpeg encodes, audio mixed in TypeScript, files behind expiring download tokens (local disk; R2 with deploy)
- [x] Beat markers on audio layers (detection + manual); `sync_to_beats` → ADR-0052: format 10 stores beats on the audio asset at upload (a spectral-flux tempo tracker, bpm and confidence), `mark_beats` turns them or a bpm grid into markers, `sync_to_beats` snaps keyframes and cuts to the nearest beat
- [x] Shareable preview links; `get_preview_link` opens a completed MP4 job in the browser with seeking and the file's existing expiry. [ADR-0059](decisions/0059-shareable-preview-links.md)
- [ ] First end-to-end check: every brief in the suite ends in an exported MP4

## M8 — Player and review (ADR-0035)

The human sees the video before any editor exists.

- [ ] Design language in Paper → `DESIGN.md`
- [ ] Share page: sign in, project list, the player on the shared renderer with timeline scrubbing, live view of agent edits (same document versions as MCP)
- [ ] Frame-pinned comments on the share page; `list_comments`, `resolve_comment` so the agent reads and answers them
- [ ] In-chat player: spike MCP UI support in Claude and ChatGPT (decision ADR), then return the player from the render and export tools where the client supports it
- [ ] Listing back under 60 KB (moved from M4). Compact every tool's output schema (20.5 KB of the 69.6 KB `tools/list` after ADR-0040, with the total about 71.2 KB after `run_script`) and the shared write fields. Lower the current cap of 121.5 KB (ADR-0059) to 60 KB. Earlier caps were 77 KB after SVG import (ADR-0043), 78 KB with generators (ADR-0045), 89 KB with export (ADR-0048), 101 KB with beat tools (ADR-0052), 112 KB with project shaders (ADR-0055), and 116 KB with shader transitions (ADR-0057). ADR-0045 raised the `apply_ops` cap from 14 to 15 KB, the manifest from 8 to 9 KB, and the project JSON schema from 74 to 90 KB. Export raised the manifest cap to 10 KB (ADR-0048). Shader transitions raised the manifest to 13.5 KB and the project schema to 105 KB (ADR-0057). Lower the current `apply_ops` cap of 16.5 KB, manifest cap of 13.5 KB, and project output schema cap of 106 KB as well.

## Private beta

Opens after M8. The editor is built during it, from what users finish by hand.

- [ ] Schema check: confirm additive room for 3D (Z, camera/light/model layers; interaction with order, blend modes, mattes, precomps), ADR-0013 (Z, camera and the stacking model answered by ADR-0054; lights and model layers still open)
- [ ] Onboarding for MCP clients, usage limits, billing direction, open-core decision
- [ ] Brief suite meets the beta targets in PRODUCT.md
- [ ] Landing page with real exported videos and connect steps checked in each client

## M9 — Editor

Starts simple; grows toward an After Effects-like workflow (ADR-0035).

- [ ] Layer list, inspector, basic keyframe editing, all on scene operations
- [ ] Timing finish: easing curve and spring editor, motion-path handles in the viewer (ADR-0018)
- [ ] Next steps chosen from beta usage: graph editor, multi-select and timeline editing, a control for each engine capability

## After beta: v1.x highlights (ADR-0013)

Not exhaustive; every `v1.x` item in CAPABILITIES.md follows after the private beta.

- 3D compositing: lights; glTF / GLB model layers; shader materials (3D layers and cameras shipped early, ADR-0054)
- Lottie import → editable layers
