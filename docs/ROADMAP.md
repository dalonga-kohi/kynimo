# Kynimo — Roadmap

Feature by feature. Each item is one branch + PR unless noted. Check items off as their PRs merge.

## M0 — Foundation

- [x] Repo, working agreement (CLAUDE.md), reviewer agent, design skills, docs, monorepo skeleton, CI

## M1 — Scene format + engine core

- [ ] Scene schema v1 (project, composition, scene, layers, keyframe tracks) + types
- [ ] Scene operations (pure `(doc, op) → doc'`) + change records + undo
- [ ] Migration framework + first migration test
- [ ] Engine: frame-based timeline, interpolation, easing curves, springs (damping + response)
- [ ] Engine: evaluate a document at frame N → resolved layer tree (deterministic, tested)

## M2 — Renderer (frames)

- [ ] Draw a resolved layer tree in the browser (shapes, text, images)
- [ ] Headless capture: document + frame → PNG
- [ ] Determinism test: same doc + frame → identical pixels
- [ ] Font loading strategy

## M3 — MCP server

- [ ] Local stdio MCP server with precise tools (`create_project`, `get_scene`, `add_layer`, `set_keyframes`, …)
- [ ] `render_frames` tool returning images
- [ ] Project store (database) + versioned documents
- [ ] Remote transport (Streamable HTTP) + OAuth
- [ ] Deploy to the first hosting environment; connect from Claude and ChatGPT

## M4 — Guidelines + quality checks

- [ ] Token model (visual + motion) and guideline pack format
- [ ] First pack, authored with a motion designer
- [ ] Quality rules engine + report format
- [ ] `apply_style` and `check_quality` tools

## M5 — Component library v1

- [ ] Component model (props schema, evaluate, style-aware)
- [ ] First components: kinetic type, logo reveal, lower third, transition set, background
- [ ] `add_component` + intent-level tools
- [ ] Sandbox for custom components (spike → decision ADR)

## M6 — Export pipeline + preview links

- [ ] Render workers + job queue
- [ ] MP4 / WebM / GIF export
- [ ] Music track + beat markers
- [ ] Shareable preview links

## M7 — Web app

- [ ] Design language in Paper → `DESIGN.md`
- [ ] Sign in, project list, preview player with scrubbing, share links

## Private beta

- [ ] Onboarding for MCP clients, usage limits, billing direction, open-core decision
