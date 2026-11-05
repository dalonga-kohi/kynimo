# Kynimo — Roadmap

Feature by feature. Each item is one branch + PR unless noted. Check items off as their PRs merge. Scope per item comes from [CAPABILITIES.md](CAPABILITIES.md): this roadmap covers everything marked `beta`; `v1.x` items follow after the private beta (ADR-0008).

## M0 — Foundation

- [x] Repo, working agreement (CLAUDE.md), reviewer agent, design skills, docs, monorepo skeleton, CI
- [x] Capability map + ADR-0008 (AE-grade engine, simple editor)

## M1 — Scene format + engine core

- [ ] Scene schema v1, part 1: project, assets, compositions, layer union, transform + parenting, in/out, markers, render switches, pinned style reference. Schema library decided here. Designed to leave room for every `v1.x` item.
- [ ] Scene schema v1, part 2: keyframe tracks (linear, bezier, hold, spring), spatial paths, precomp references with cycle validation
- [ ] Migration framework + first migration test
- [ ] Scene operations: pure `(doc, op) → doc'` + change records (concrete ids), batches, per-actor undo/redo, typed selectors
- [ ] Engine: interpolation (scalars, vectors, colors), cubic-bezier easing, springs (damping + response), spatial motion paths
- [ ] Engine: evaluate a document at frame N → resolved layer tree (parenting, precomps; deterministic, tested)

## M2 — Renderer (frames)

- [ ] Drawing backend decision (ADR): blend modes, mattes, masks and the effect list, deterministic in workers (see CAPABILITIES.md, "Determinism")
- [ ] Draw shapes (fill, stroke, gradients, dashes), images, solids
- [ ] Text: font loading strategy (bundled fonts), shaping, layout (point/box, auto-fit)
- [ ] Masks, track mattes, blend modes
- [ ] Headless capture: document + frame → PNG; determinism test (same doc + frame → identical pixels)

## M3 — MCP server v1

- [ ] Local stdio MCP server: project, read (`get_scene` summary/full, `find_layers`) and precise tools incl. batched `apply_ops`
- [ ] `render_frames` + `render_contact_sheet` returning images; `describe_motion` timeline summary
- [ ] MCP resources: scene schema, preset/component/token catalogs
- [ ] Project store (database) + versioned documents + optimistic concurrency
- [ ] Asset storage (object storage decision) + `upload_asset` / `list_assets`
- [ ] Remote transport (Streamable HTTP) + OAuth
- [ ] Deploy to the first hosting environment; connect from Claude and ChatGPT

## M4 — Motion depth

- [ ] Shape operators: trim paths, repeater, round corners; path morphing (equal vertex counts)
- [ ] Text animators + range selectors (character / word / line, shapes, ease, seeded randomize, reverse / center-out)
- [ ] Behaviors: wiggle, loop, inertia/overshoot, follow/link, oscillate (seeded)
- [ ] Intent tools: `animate`, `apply_preset` (preset catalog), `stagger`, `retime`; `add_effect`, `add_behavior`. They take raw values or a small built-in default token set; M5 replaces the defaults with the pinned pack's tokens
- [ ] Effects: gaussian blur, drop shadow, glow, brightness/contrast, hue/saturation, tint, fill; adjustment layers
- [ ] SVG import → shape layer

## M5 — Guidelines + quality checks

- [ ] Token model (visual + motion) and guideline pack format; easing/spring tokens referenced by name, resolved against the pack version pinned in the document
- [ ] First pack, authored with a motion designer
- [ ] Quality rules engine + report format (location, frame range, suggested fix op)
- [ ] `list_styles`, `apply_style`, `get_tokens` and `check_quality` tools

## M6 — Component library v1

- [ ] Component model (props schema, evaluate, style-aware)
- [ ] First components: kinetic type, logo reveal, lower third, transition set, background
- [ ] `add_component` + `build_from_brief`
- [ ] Sandbox for custom components (spike → decision ADR)

## M7 — Export pipeline + preview links

- [ ] Render workers + job queue
- [ ] MP4 / WebM / GIF export with audio layers mixed in; `render_preview_clip`, `export`, `get_export_status`
- [ ] Beat markers on audio layers (detection + manual); `sync_to_beats`
- [ ] Shareable preview links; `get_preview_link`

## M8 — Editor (simple)

- [ ] Design language in Paper → `DESIGN.md`
- [ ] Sign in, project list
- [ ] Viewer + timeline scrubbing, layer list, inspector, basic keyframe editing, all on scene operations
- [ ] Live view of agent edits (same document versions as MCP)

## Private beta

- [ ] Onboarding for MCP clients, usage limits, billing direction, open-core decision
