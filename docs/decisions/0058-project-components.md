# 0058 — Project component authoring

- Status: accepted (extends ADR-0012, ADR-0046, and ADR-0051)
- Date: 2026-11-13

## Context

M6 needs editable components authored over MCP, with exact version pins and repeatable frame output. ADR-0051 measured QuickJS variants against a 4 ms p95 browser round-trip budget for eight active instances. Every isolated variant missed that budget.

## Decision

- Accept one `export function evaluate(props, ctx)` in bounded TypeScript. Node erases types at publication, and Acorn parses the resulting source. An allowlisted compiler constructs trusted closures with fresh per-call locals and an engine-seeded random stream. The program can read declared sampled props, frame data, style tokens and asset dimensions. It can use data literals, arithmetic, conditionals, initialized locals and literal-count loops to emit a typed scene subtree. The runtime provides no ambient APIs, dynamic calls, arbitrary property indexing, mutable shared state, or guest JavaScript execution.
- Cap source at 8,192 UTF-8 bytes, syntax at 1,024 tokens, nesting at 24, and each loop at 32 iterations. Compute a conservative static work bound including loop bodies and all branches, with an 8,192-step limit per program. Charge that bound to the engine's existing frame budget before execution. Limit output to 32 layers, 12,288 expanded nodes and 65,536 UTF-16 string units. An individual string can contain up to 10,000 units. Browser capture applies a 30-second deadline per requested frame for documents with custom components.
- Validate general `layer(fields)` output through the existing component host and project schema. The `solid` and `text` helpers build fixed-shape layers from individually checked arguments. When all layers come directly from these helpers, the host validates the composition header, unique ids, and timing without re-parsing each layer. Project components and custom shaders require explicit scene pins. Emitted subtrees can use built-in components and shaders.
- `define_component` publishes a project-local `custom-` id with immutable versions, typed prop descriptors, an idempotency key, and a SHA-256 hash of canonical metadata, original source and the stripped program. Store the definition and its outcome atomically in memory, on disk or in Postgres. Each project can publish 64 versions, with up to 64 props per version. Scene writes validate exact project pins and prop values, including keyframes. `add_component` can pin the latest version at placement time. Scene format 15 already carries the instance, version and props.
- `list_definitions` adds the optional `component_definitions` field and preserves the shader `definitions` field. `kynimo://components` describes the authoring interface and the built-ins. `kynimo://components/{project_id}` adds project versions and their prop descriptors. Capture and export receive the compiled-source inputs for the definitions pinned by the scene. The `tools/list` cap moves from 116.5 KB to 120.5 KB, with 120,141 characters measured.

## Evidence

The ADR-0051 fixture runs eight components and 68 child layers with animated props, Unicode text, style tokens, and seeded random motion. Three fresh launches of pinned Chromium 153.0.8010.12 on Windows 11 and Ryzen 5 3600 measured 240 warmed frames each. Sequential round-trip p95 was 2.50, 2.50 and 2.60 ms. Shuffled p95 was 2.50, 2.40 and 2.50 ms. Sampled output matched cold evaluation, scrub order, Node, and all three launches. Capture and raw export matched pixel hashes for a version-pinned component and the equivalent ordinary layer.

The drawing benchmark also includes CanvasKit rasterization, WebGL compositing, and synchronous pixel readback. On the RTX 2060, evaluation round-trip p95 was 3.80 ms at 640×360 and 5.90 ms at 1920×1080. Combined frame-work p95 was 44.00 ms and 76.80 ms, respectively. This measures the current capture renderer under a 60 Hz clock. For MCP capture and export, the isolated browser round-trip benchmark is the release gate. ADR-0051's supported preview device and live drawing requirements apply when a real-time presentation path ships. [Benchmark commands](../../spikes/component-sandbox/README.md)

## Alternatives considered

- Fresh QuickJS realms accept more of JavaScript and exceeded the 4 ms budget in ADR-0051.
- Reusing a mutable guest realm risks playback-order-dependent output and also missed the benchmark.

## Consequences

- MCP authors can publish editable project components and inspect their frames or export them. The authoring catalog lists the supported language and helpers.
- Previously published component pins retain their metadata and program across scene revisions. The versioned language and helper semantics are part of the renderer contract.
