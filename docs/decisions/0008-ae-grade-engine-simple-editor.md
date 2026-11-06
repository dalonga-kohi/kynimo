# 0008 — After Effects-grade engine, simple editor

- Status: accepted (amends ADR-0002: tool groups and web app scope; amends ADR-0004: preview vs export pixel identity; amended by ADR-0013: 3D moves to v1.x)
- Date: 2026-11-05

## Context

ADR-0002 makes the MCP server the primary surface. That still leaves open how capable the engine itself should be. A thin engine would cap what an agent can produce no matter how good the tools are. AI-made motion today looks generic partly because the available primitives are shallow. Kynimo is also a motion design app a person can open and use without an assistant.

## Decision

- The scene format and engine target the **2D core of Adobe After Effects**: precomps, parenting, nulls, adjustment layers, shape layers with path operators, text animators with range selectors, keyframes with bezier, hold and spring interpolation, motion paths, masks, track mattes, blend modes, motion blur and a deterministic effect stack. The full list, split into what ships before the private beta (`beta`) and what the schema leaves room for and ships after (`v1.x`), lives in [CAPABILITIES.md](../CAPABILITIES.md).
- Expressions are replaced by typed, seeded **behaviors** (wiggle, loop, inertia, follow, oscillate), which keeps rendering deterministic and the scene graph inspectable (ADR-0001).
- **Every capability is reachable over MCP.** Tools are batched, transactional, intent-aware and addressable by name or selector (see CAPABILITIES.md, "MCP surface").
- The **editor stays simple**: viewer, timeline, layer list, inspector and basic keyframe editing on the same operations. It doesn't need a control for every engine capability.
- 3D layers, cameras and lights are out of v1.

## Consequences

- The scene schema v1 is designed up front around the whole capability map, so `v1.x` items can be added later without breaking changes. It's built feature by feature, with a migration for each change.
- The M2 drawing-backend ADR has to support blend modes, mattes, masks and the effect list while keeping output deterministic in the render workers (pinned Chromium + software rasterizer). The live browser preview is visually equivalent, not bit-identical (see CAPABILITIES.md, "Determinism").
- MCP tool design (batching, typed selectors, compact reads, motion summaries, per-actor undo) is core work in M3, not plumbing.
- ADR-0002's three tool groups become the seven groups in CAPABILITIES.md, and its "thin companion" web app becomes a simple editor usable on its own. The MCP server stays the primary surface.
- "A full After Effects-style timeline editor" remains a non-goal for the UI, not for the engine.
