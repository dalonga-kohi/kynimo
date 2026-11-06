# 0010 — Scene operations, change records and per-actor undo

- Status: accepted
- Date: 2026-11-06

## Context

Scene operations (roadmap M1) are the only way to mutate a document. The MCP server (M3), the store and the editor all sit on them, so their shape fixes how batches, history and conflicts behave everywhere.

## Decision

- **Pure write path in `@kynimo/scene`.** `applyOps(doc, ops, idCounter) → { doc', changes, idCounter' }` with typed Zod op schemas (`OpSchema`) and no free-form patch. No I/O, clock or randomness; new ids come from a counter the caller carries (`layer-N`, `marker-N`, skipping used ids), per ADR-0009.
- **Atomic batches.** Ops run on a copy; the whole result is then validated with `ProjectSchema`. Any failure returns the original document and pathed errors (`["ops", i, field]` for an op, `["doc", ...]` for integrity). Nothing throws past the API edge. Integrity is checked once per batch, so a batch may pass through states that are invalid mid-way (reparent, then remove).
- **Selectors** are a layer id, or a structured object (`name` with `*`, `type`, `composition`). Each must match exactly one layer. They resolve against the document as it stands when that op runs, so a later op can target a layer an earlier op added. The glob is a linear matcher, not a regex, because selectors are untrusted input.
- **Change records are invertible and concrete.** Every record holds resolved ids plus what it expects to find (`before`, or an item snapshot) and what it leaves. The same record replays forward (redo) or inverted (undo).
- **Per-actor undo/redo with caller-owned, immutable stacks** (`SceneState.history`, keyed by actor id, capped at 100 batches per actor). Undo and redo replay records against the _current_ document and fail with a `conflict`, changing nothing, when it no longer matches what a record expects. This detects any later edit to the same property regardless of author, so it needs no version bookkeeping. Granularity: property sets are per property; layer or marker add/remove compares the whole item; reorder compares the layer's position. A new batch clears that actor's redo.

## Consequences

- The M3 store owns `SceneState` (document, counter, history) per session and serializes it; history is a `Map` today and becomes plain data there.
- Stricter-than-necessary conflicts are possible (editing a layer another actor added blocks their undo of the add). That fails safe; loosen with finer records if it proves annoying.
- Expanding the catalog means adding an op schema, a handler and, only for a new kind of edit, a change type with its `applyChange` and `invert` cases.
