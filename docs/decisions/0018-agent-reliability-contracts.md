# 0018 — Agent reliability contracts

- Status: accepted (amends ADR-0010: undo history is persisted with the project; amends ADR-0008: the simple editor gains a timing-finish view)
- Date: 2026-11-07

## Context

M1 is done and M2 is drawing pixels. Before the MCP server (M3) fixes its contracts, we compared Kynimo with a broader open-source motion tool that also exposes MCP. MCP support on its own is not what sets Kynimo apart. What does is that an agent **reliably** produces polished, editable motion. Reliability breaks in five places that features don't fix:

1. **Determinism is not correctness.** Golden hashes prove a frame repeats. A frame that is wrong every time still passes.
2. **Accepted is not rendered.** Schema v1 already admits layer types the renderer can't draw yet. The renderer lists them as `skipped` (ADR-0017), but an agent only reading tool schemas can't know that. It wastes calls and context finding out.
3. **Renders cost far more than reads.** An unbounded `render_frames` call can tie up a worker. Long jobs need progress and a way to stop.
4. **Formats lose things.** Imports and exports drop, flatten or substitute features, fonts and assets. Doing so silently breaks the "still editable" promise.
5. **Agents disconnect.** After a dropped connection an agent doesn't know whether its batch was saved, and a blind retry can apply it twice.

## Decision

These are contracts that every feature in the affected area follows. Details (exact limits, field names) are settled in the feature that builds them.

- **Reference scenes.** A small set of acceptance scenes lives in the repo: a document, chosen frames, and approved PNGs. The approved PNG and the golden hash are one artifact: CI renders the frame in the worker environment (headless Chromium compositor on the pinned CPU family, ADR-0016) and compares bytes exactly. Keeping the PNG, not only its hash, is what lets a person check that the output looks right; a PR that adds or changes one shows it. Golden hashes alone guard repeatability; reviewed PNGs guard correctness. The set starts in M2 (title card, masked/matted reveal, nested precomp with parenting, image-and-shape product card) and grows with each milestone (kinetic type in M4, styled scenes in M5, components in M6).
- **Capability manifest.** The build says what it can do, as data generated from code rather than hand-written docs. Each layer type and feature is `renders`, `accepted, not rendered` (with the reason) or `unavailable`. It is exposed as an MCP resource **and** a `get_capabilities` tool, because not every MCP client shows resources to the model. Every render result lists what it skipped and why, gathered from nested precomps too (the renderer keeps skips per composition plan). Nothing is ever dropped silently. A test checks that every layer type in the schema has a manifest entry.
- **Bounded renders.** Each render tool declares its limits in its input schema: maximum size, frames per call, contact-sheet cells. A request over a limit fails validation and suggests values that fit. It is never silently downscaled. Results are cached per project, keyed by document content hash + hashes of the pinned component and shader definitions (ADR-0012) + composition + frame(s) + render options (size, format, quality, sheet layout) + renderer build. That is sound because worker rendering is deterministic (ADR-0016); only worker output is cached, never browser-preview pixels. Long work (preview clips, exports) runs as a job with an id, progress, cancel and a result. Render work is metered separately from reads, for capacity and internal accounting; how it is priced stays with the billing item (PRODUCT.md).
- **Fidelity reports.** Every importer and exporter reports what it couldn't carry: missing assets or fonts (and the fallback used), unsupported features (dropped), features that were flattened or rasterized, and approximations. Imports support a dry run that returns the report without changing the document. We don't promise that every Kynimo feature survives every export format.
- **Retry-safe writes.** Every mutating tool takes a client-supplied `idempotency_key`. Precise and intent tools compile to one `apply_ops` batch and share its handling; `undo`, `redo`, `create_project`, `upload_asset`, `define_component`, `define_shader` and `export` record their keys the same way.
  - Keys are scoped to (project, authenticated actor), or (account, actor) for `create_project`, so one actor can't collide with or read another's.
  - The store keeps key → result for a retention window. A retry with the same key and the same request (ops **and** base version) returns the original result instead of applying again; the same key with a different request is an error.
  - A batch is atomic: it is in exactly one version or in none, never partly saved.
  - `get_write_outcome` (same authorization as the project) answers `applied` (version N), `rejected` (errors), `expired` (past retention) or `unknown` (never arrived). Writes also carry their base version, so even a replay after expiry fails with a conflict instead of applying twice.
  - Per-actor undo history (ADR-0010) is stored with the project, so it survives a server restart.

- **Timing finish in the editor (M8).** Humans finish agent output mostly by adjusting timing. The editor gets an easing-curve and spring editor and motion-path handles in the viewer, on the same operations. It is not a full graph editor; ADR-0008's simple-editor scope otherwise stands.

Not adopted: matching another tool's effect count or panel layout, earlier 3D (stays `v1.x`, ADR-0013), or import of proprietary After Effects project files. Reusing outside code still needs its own license and dependency check.

## Consequences

- M2's capture item ships reference scenes, not only hashes. Changing a reference frame means looking at it.
- M3 contracts get bigger: `get_capabilities`, limit fields on render tools, `idempotency_key` on writes, `get_write_outcome`, persisted undo stacks. All of these are additive, so they can ship from the first version of each tool.
- The manifest must be generated from the code that renders, or it will drift.
- The render cache is only as good as its key. Bumping the renderer build or any pinned definition invalidates entries, as ADR-0016 already requires for outputs.
- Every import/export item (SVG in M4, MP4/WebM/GIF in M7, Lottie in v1.x) owes a fidelity report and its tests.
