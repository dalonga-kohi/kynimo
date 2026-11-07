# 0018 — Agent reliability contracts

- Status: accepted
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

- **Reference scenes.** A small set of acceptance scenes lives in the repo: a document, chosen frames, and approved PNGs. A person looks at the PNGs when they are added or change, and the PR shows them. Golden hashes guard repeatability. Reference frames guard that the output looks right. The set starts in M2 (title card, masked/matted reveal, nested precomp with parenting, image-and-shape product card) and grows with each milestone (kinetic type in M4, styled scenes in M5, components in M6).
- **Capability manifest.** The build says what it can do, as data generated from code rather than hand-written docs. Each layer type and feature is `renders`, `accepted, not rendered` (with the reason) or `unavailable`. It is exposed as an MCP resource **and** a `get_capabilities` tool, because not every MCP client shows resources to the model. Every render result lists what it skipped and why. Nothing is ever dropped silently.
- **Bounded renders.** Each render tool declares its limits in its input schema: maximum size, frames per call, contact-sheet cells. A request over a limit fails validation and suggests values that fit. It is never silently downscaled. Results are cached by document content hash + composition + frame + size + renderer build, which is sound because rendering is deterministic (ADR-0016). Long work (preview clips, exports) runs as a job with an id, progress, cancel and a result. Usage is measured in render units (frames × pixels), separately from reads, which fits pricing on render minutes (PRODUCT.md).
- **Fidelity reports.** Every importer and exporter reports what it couldn't carry: missing assets or fonts (and the fallback used), unsupported features (dropped), features that were flattened or rasterized, and approximations. Imports support a dry run that returns the report without changing the document. We don't promise that every Kynimo feature survives every export format.
- **Retry-safe writes.** `apply_ops` takes the base version and a client-supplied idempotency key. The store keeps key → result for a retention window. Retrying with the same key returns the original result instead of applying again. The same key with different ops is an error. A batch is atomic: it is in exactly one version or in none, never partly saved. After reconnecting, an agent can look up a key's outcome (applied in version N, rejected with errors, or unknown key). Per-actor undo history (ADR-0010) is stored with the project, so it survives a server restart.

Not adopted: matching another tool's effect count or panel layout, earlier 3D (stays `v1.x`, ADR-0013), or import of proprietary After Effects project files. Reusing outside code still needs its own license and dependency check.

## Consequences

- M2's capture item ships reference scenes, not only hashes. Changing a reference frame means looking at it.
- M3 contracts get bigger: `get_capabilities`, limit fields on render tools, `idempotency_key` on writes, an outcome lookup, persisted undo stacks. All of these are additive, so they can ship from the first version of each tool.
- The manifest must be generated from the code that renders, or it will drift. A test checks that every layer type in the schema has a manifest entry.
- The render cache is only as good as the cache key. Bumping the renderer build invalidates it, as ADR-0016 already requires for outputs.
- Every import/export item (SVG in M4, MP4/WebM/GIF in M7, Lottie in v1.x) owes a fidelity report and its tests.
