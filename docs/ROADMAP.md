# Kynimo — Roadmap

Feature by feature. Each item is one branch + PR unless noted. Check items off as their PRs merge. Scope per item comes from [CAPABILITIES.md](CAPABILITIES.md): this roadmap covers everything marked `beta`; `v1.x` items follow after the private beta (ADR-0008).

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
- [ ] Deploy to the first hosting environment; connect from Claude and ChatGPT

## M4 — Motion depth

- [x] Shape operators: trim paths, repeater, round corners; path morphing (equal vertex counts) → ADR-0034: format v5, After Effects reach (operators change the paths above them, every paint draws the result), our own fixed-work arc length, repeater copies as groups with a 20 000-item budget per layer; morphing already shipped with schema v1 part 2
- [ ] Text animators + range selectors (character / word / line, shapes, ease, seeded randomize, reverse / center-out)
- [ ] Behaviors: wiggle, loop, inertia/overshoot, follow/link, oscillate (seeded)
- [ ] Intent tools: `animate`, `apply_preset` (preset catalog, also as an MCP resource), `stagger`, `retime`; `add_effect`, `add_behavior`. They take raw values or a small built-in default token set; M5 replaces the defaults with the pinned pack's tokens
- [ ] Effects: gaussian blur, drop shadow, glow, brightness/contrast, hue/saturation, tint, fill; adjustment layers
- [ ] SVG import → shape layer, with a fidelity report and dry run (ADR-0018)
- [ ] Built-in 2D shader effects and generator layers (backgrounds, textures, looks)

## M5 — Guidelines + quality checks

- [ ] Token model (visual + motion) and guideline pack format; easing/spring tokens referenced by name, resolved against the pack version pinned in the document
- [ ] First pack, authored with a motion designer
- [ ] Quality rules engine + report format (location, frame range, suggested fix op)
- [ ] `list_styles`, `apply_style`, `get_tokens` and `check_quality` tools; token list of the pinned style as an MCP resource

## M6 — Component library v1

- [ ] Component model (props schema, evaluate, style-aware)
- [ ] First components: kinetic type, logo reveal, lower third, transition set, background
- [ ] `add_component` + `build_from_brief`
- [ ] Sandbox for custom components (spike → decision ADR)
- [ ] Code authoring over MCP: `define_component`, `define_shader` (custom GLSL), `list_definitions`; versioned, content-hashed definitions pinned in documents (ADR-0012); component and shader catalogs as MCP resources
- [ ] Built-in shader transitions

## M7 — Export pipeline + preview links

- [ ] Render workers + job queue; jobs with progress, cancel and idempotent submission (ADR-0018)
- [ ] MP4 / WebM / GIF export with audio layers mixed in and a fidelity report; `render_preview_clip`, `export`, `get_export_status`, `cancel_export`
- [ ] Beat markers on audio layers (detection + manual); `sync_to_beats`
- [ ] Shareable preview links; `get_preview_link`

## M8 — Editor (simple)

- [ ] Design language in Paper → `DESIGN.md`
- [ ] Sign in, project list
- [ ] Viewer + timeline scrubbing, layer list, inspector, basic keyframe editing, all on scene operations
- [ ] Live view of agent edits (same document versions as MCP)
- [ ] Timing finish: easing curve and spring editor, motion-path handles in the viewer (no full graph editor)

## Private beta

- [ ] Schema check: confirm additive room for 3D (Z, camera/light/model layers; interaction with order, blend modes, mattes, precomps), ADR-0013
- [ ] Onboarding for MCP clients, usage limits, billing direction, open-core decision

## After beta: v1.x highlights (ADR-0013)

Not exhaustive; every `v1.x` item in CAPABILITIES.md follows after the private beta.

- 3D compositing: 3D layers, cameras, lights; glTF / GLB model layers; shader materials
- Lottie import → editable layers
