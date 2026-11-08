# 0024 — Local MCP server: store, write contract and compact schemas

- Status: accepted (implements ADR-0018's retry-safe writes for the first M3 tools; amends ADR-0010's note that the store owns `SceneState`)
- Date: 2026-11-08

## Context

M3 starts with a local stdio MCP server over `@kynimo/scene`. The tools fix contracts that later items (database store, remote transport, render tools) build on, and adding a required field to a shipped tool would break it (CAPABILITIES.md, principle 10). Two things had to be settled up front: where a local server keeps projects, and how much schema the tools declare, since every tool's schema is sent to the model on connect.

## Decision

- **`apps/mcp` (`@kynimo/mcp`)** on the official `@modelcontextprotocol/sdk` (pinned, Zod 4). `createServer(service)` builds the server and the caller picks the transport. `kynimo-mcp` serves stdio now, and Streamable HTTP is a later M3 item. The tool logic lives in `KynimoService`, which has no MCP types and is tested on its own.
- **Tools in this item.** Project: `create_project`, `list_projects`, `get_project`. Read: `get_scene` (summary by default, `full` on request, optionally one composition), `get_layer`, `find_layers`, `get_layer_schema`, `get_write_outcome`. Precise: `apply_ops`, `add_layer`, `update_layer`, `set_keyframes`, `undo`, `redo`. The precise tools compile to one `apply_ops` batch. `add_mask`, `set_matte` and `precompose` wait for their scene ops (follow-up roadmap item).
- **Store.** A `ProjectStore` interface holds plain-JSON `StoredProject`s: document, id counter, per-actor undo/redo stacks, version and write keys. `MemoryStore` is the default; `FileStore` (`--dir`) keeps one JSON file per project, written atomically (temp file + rename). Documents are migrated on load, and a format change drops the undo history, whose records describe the old format. Project ids are generated (`p-` + 32 hex), and only that pattern ever becomes a path. The database item implements the same interface.
- **Write contract** (every mutating tool, from v1):
  - `base_version` is required. A stale one is rejected as a `conflict` that names the current version. Versions start at 1 and go up by one per write that changes the document, so a no-op batch keeps the version.
  - `idempotency_key` is required, scoped to (project, actor), or (account, actor) for `create_project`. The outcome is stored with a fingerprint of the request (base version + compiled ops, or undo/redo). A retry with the same request returns the stored outcome, applied or rejected, marked `replayed`. The same key with a different request fails with `key_reused`. Rejections are recorded too, so `get_write_outcome` answers `applied`, `rejected` or `unknown`. `expired` is in the contract but only the durable store returns it. The local store keeps the last 1000 keys per project.
  - Writes to one project are serialized by a per-project lock in the service, so a version check and its write never interleave.
  - The local server has a single actor (`--actor`, default `local`). Undo is per actor and conflict-checked by `@kynimo/scene`.
- **Compact tool schemas.** Exported exactly, the op union is ~45 KB of JSON Schema (40 KB of it the layer union), and the SDK inlines every schema. Tools therefore declare everything exactly except two bodies: `addLayer.layer` (an object with a `type` enum) and transform tracks (an object, described in prose). The server validates both in full against `OpSchema` and returns pathed errors. `get_layer_schema` returns the exact JSON Schema of one layer type (with `$ref` reuse) on demand. The whole listing is ~33 KB, and a test keeps it under 40 KB.
- **Errors** are tool results with `isError` and a JSON body (`error` kind, `message`, pathed `errors`, `current_version` where relevant), never protocol errors. A failure does not end the agent's turn, and it can act on the paths.
- **`add_layer` defaults** fill the fields every layer of a type shares: timing over the whole composition, a centered identity transform (filled per property), `normal` blend, no matte, masks or markers. Type-specific fields stay required. `apply_ops` takes layers as they are, with no defaults.

## Consequences

- `get_capabilities`, render tools and resources (later M3 items) add tools; nothing here has to change for them.
- The database store must keep `StoredProject`'s semantics: atomic write of document + history + key, key retention, and actor scoping from authentication instead of `--actor`.
- Loose declarations mean a client cannot validate layer bodies or tracks before sending. The server's pathed errors and `get_layer_schema` cover that. Once MCP resources land (M3 #3), the scene schema resource serves the same data.
- `@kynimo/scene` now exports `matchLayers`, for `find_layers`.
- The SDK brings its HTTP stack (express, hono) along as transitive dependencies even though stdio does not use it. The remote transport item needs it anyway.
