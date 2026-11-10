# 0030 — Compact tool listing

- Status: accepted (resolves the listing-size note in ADR-0025, ADR-0026 and ADR-0028)
- Date: 2026-11-09

## Context

Every MCP client sends the full `tools/list` response to the model on connect, and a test caps it at 60 KB. By ADR-0028 it stood at 59.8 KB, with `upload_asset` and `list_assets` next. About an eighth of it said nothing: zod emits `minimum: -2^53+1` / `maximum: 2^53-1` on every `.int()`, a draft-07 `$schema` on each of the 42 input and output schemas, and `additionalProperties: {}` on open output objects. The SDK builds the listing from the zod schemas itself, so the JSON can't be fixed at the source.

## Decision

- **Compact the listing, losslessly apart from the safe-integer range (which the server still enforces).** `compactToolListing` wraps the SDK's own `tools/list` handler as it is installed (through the public `setRequestHandler`) and runs every input and output schema through `compactJsonSchema`, which drops exactly those three things, at schema positions only (property names and `default` / `const` / `enum` values pass through). The handler is matched by its method name, `tools/list`. Everything else (names, titles, annotations, real bounds, closed objects) passes through untouched, and the server still validates input against the full zod schemas.
- **No `$schema`.** MCP reads a schema without one as JSON Schema 2020-12. The listing uses no keyword that means something else under draft-07 (tuple `items`, `additionalItems`, `definitions`, `dependencies`, `$ref`), and a test keeps it that way.
- **Budgets.** The whole listing stays under 60 KB, `apply_ops` under 13 KB and every other tool under 4.5 KB, so one tool can't use up the room unnoticed.
- **Amendment (2026-11-10, ADR-0039):** in `apply_ops`' op union, layer selectors are declared as a one-line described id-or-selector instead of the full selector schema, which each op repeated (436 characters each). The full shape stays in `kynimo://schema/ops`, `find_layers` and `get_layer`, and the server validates every op in full.
- Not chosen: declaring `apply_ops` items loosely (another ~9 KB) would hide the exact op shapes models rely on; it stays an option for later.

## Consequences

- The listing drops from 59.8 KB to 52.2 KB, room for the asset tools and a few more.
- The M4–M6 intent, style and component tools will not fit in what is left. The next lever is loose `apply_ops` items or fewer single-purpose tools, decided when that item comes up.
- If the SDK changes how it installs the `tools/list` handler, the listing tests fail rather than the compaction silently stopping.
