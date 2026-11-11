# Kynimo — Roadmap

Feature by feature. Each item is one branch + PR unless noted. Check items off as their PRs merge. Scope per item comes from [CAPABILITIES.md](CAPABILITIES.md): this roadmap covers everything marked `beta`; `v1.x` items follow after the private beta (ADR-0008).

**Where we are (2026-11-11):** M0–M2 done; M3 done except deployment; M4 under way (shape operators, text animators, behaviors and intent tools done); M5's pack format and four draft packs exist (ADR-0037). An agent can build a document and see frames. It can animate with intent tools and presets. It cannot yet export a video, apply a style or get a quality report. The milestone order below was confirmed on 2026-11-09 with its risk recorded (PRODUCT.md, "Risks we carry knowingly"; ADR-0035).

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
- [x] Text animators + range selectors (character / word / line, shapes, ease, seeded randomize, reverse / center-out) → ADR-0038: format v6, windows that select units partly, per-cluster drawing at the full layout's positions, tracking without re-wrap, blur accepted but not drawn until effects, glyph budgets per layer (1 000) and frame (4 000), reference scene
- [x] Behaviors: wiggle, loop, inertia/overshoot, follow/link, oscillate (seeded) → ADR-0039: format v7, per-layer `behaviors` on the transform properties applied in a fixed order after keyframes, analytic velocity for inertia and loop-continue, link cycles refused with a per-frame link-step budget (100 000), `describe_motion` lines and manifest entries, `add_behavior` intent tool left to the intent tools
- [x] Intent tools: `animate`, `apply_preset` (preset catalog, also as an MCP resource), `stagger`, `retime`, `add_behavior` → ADR-0040: new `@kynimo/intent` package of pure expansions over the pinned pack's tokens (Keynote's when none), `animate` replaces keyframes inside its window, presets as functions with params schemas (13 shipped; `count-up` and `blur-in` deferred), stagger shifts keyframes and compounds, `setTextAnimators` and `setShapeContents` ops, `dry_run`, idempotency on the tool input
- [ ] Listing back under 60 KB: compact every tool's output schema (20.5 KB of the 69.6 KB `tools/list` after ADR-0040) and the shared write fields, then lower the `server.test.ts` budget from 70 KB to 60 KB
- [ ] `run_script` (ADR-0036): TypeScript run once in the QuickJS sandbox against an SDK generated from the operation schemas, applied as one validated batch; `dry_run`; SDK types as an MCP resource; declared limits. Token names come from `@kynimo/guidelines`
- [ ] Brief suite v1 (ADR-0035): five briefs run by a real model over MCP; a report of completion, tool calls, rejected calls, tokens and contact sheets, kept per run so milestones can be compared. Runs on demand, not in CI. Lands right after the intent tools; its first report sets the baseline and compares the same briefs with and without `run_script`
- [ ] Reference scene: kinetic type (ADR-0018), built only with MCP tools
- [ ] Effects: gaussian blur, drop shadow, glow, brightness/contrast, hue/saturation, tint, fill; adjustment layers; the `add_effect` tool (moved here from the intent tools, ADR-0040) and the `blur-in` preset
- [ ] SVG import → shape layer, with a fidelity report and dry run (ADR-0018)
- [ ] Built-in 2D shader effects and generator layers (backgrounds, textures, looks)

## M5 — Guidelines + quality checks

- [x] Token model (visual + motion) and guideline pack format → ADR-0037: `@kynimo/guidelines`, packs as versioned JSON with fixed token names, rule thresholds with cited sources, packs validated against their own rules
- [ ] Token references in documents: easing/spring and color tokens referenced by name (format bump), resolved against the pack version pinned in the document (ADR-0037, open question)
- [x] First packs as drafts (0.1.0), authored by us (ADR-0035, ADR-0037): Keynote, Playful SaaS, Editorial, Brutalist; each rule cites its source
- [ ] Packs to 1.0.0: measure reference videos frame by frame, a reference scene per pack that a person looks at, tuning on the brief suite; bundle a serif and a mono family so the packs differ in type. An outside motion designer's critique is a gate before public launch
- [ ] Published pack versions immutable once `apply_style` pins them (ADR-0037): deep-freeze `BUILT_IN_PACKS`, and a test pinning a sha256 of each `id@version`'s canonical JSON
- [ ] Quality rules engine + report format (location, frame range, suggested fix op)
- [ ] `list_styles`, `apply_style`, `get_tokens` and `check_quality` tools; token list of the pinned style as an MCP resource

## M6 — Component library v1

- [ ] Component model (props schema, evaluate, style-aware)
- [ ] First components: kinetic type, logo reveal, lower third, transition set, background
- [ ] `add_component` + `build_from_brief`
- [ ] Sandbox for custom components (spike → decision ADR): can the QuickJS sandbox chosen for scripts (ADR-0036) evaluate component code per frame, in the browser, fast enough
- [ ] Code authoring over MCP: `define_component`, `define_shader` (custom GLSL), `list_definitions`; versioned, content-hashed definitions pinned in documents (ADR-0012); component and shader catalogs as MCP resources
- [ ] Built-in shader transitions

## M7 — Export pipeline + preview links

- [ ] Render workers + job queue; jobs with progress, cancel and idempotent submission (ADR-0018)
- [ ] MP4 / WebM / GIF export with audio layers mixed in and a fidelity report; `render_preview_clip`, `export`, `get_export_status`, `cancel_export`
- [ ] Beat markers on audio layers (detection + manual); `sync_to_beats`
- [ ] Shareable preview links; `get_preview_link`
- [ ] First end-to-end check: every brief in the suite ends in an exported MP4

## M8 — Player and review (ADR-0035)

The human sees the video before any editor exists.

- [ ] Design language in Paper → `DESIGN.md`
- [ ] Share page: sign in, project list, the player on the shared renderer with timeline scrubbing, live view of agent edits (same document versions as MCP)
- [ ] Frame-pinned comments on the share page; `list_comments`, `resolve_comment` so the agent reads and answers them
- [ ] In-chat player: spike MCP UI support in Claude and ChatGPT (decision ADR), then return the player from the render and export tools where the client supports it

## Private beta

Opens after M8. The editor is built during it, from what users finish by hand.

- [ ] Schema check: confirm additive room for 3D (Z, camera/light/model layers; interaction with order, blend modes, mattes, precomps), ADR-0013
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

- 3D compositing: 3D layers, cameras, lights; glTF / GLB model layers; shader materials
- Lottie import → editable layers
