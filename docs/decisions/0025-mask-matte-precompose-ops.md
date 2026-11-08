# 0025 — Mask, track matte and precompose operations

- Status: accepted (extends ADR-0010's op catalog and ADR-0024's tools; amends ADR-0024's 40 KB listing budget)
- Date: 2026-11-08

## Context

Masks and track mattes (ADR-0020) and precomps (ADR-0015) were in the format and the renderer, but nothing could create them except a hand-built `addLayer`. Agents need them as precise operations. Precompose is the one structural edit so far that creates a composition and moves layers between compositions, so it fixes how such edits are recorded and undone.

## Decision

- **Ops.** `addMask` (generated id `mask-N` from the seeded counter, unique within the layer; appended by default or at `index`), `updateMask` (any mask field but `id`, tracks replaced whole), `removeMask`, `setMatte` (source selector resolved within the layer's composition, `null` clears) and `precompose`. Masks and mattes only go on drawing layers: null and audio layers are refused with an op-level error, and the schema's integrity rules (no self-matte, no matte cycles, no non-drawing source) still apply to the result.
- **Mask edits record one `layer.set` on the layer's whole `masks` list.** Indices shift on insert and remove, so a per-mask path could replay against the wrong mask. Undo of a mask edit therefore conflicts with any later edit to any mask of that layer. That fails safe, as ADR-0010 allows.
- **Precompose follows After Effects "move all attributes".** The new composition copies the source's size, frame rate and duration with a transparent background. The selected layers move in, in their stacking order and unchanged (masks, mattes, blend modes, timing, markers). One precomp layer replaces them at the topmost selected position, spanning the whole duration with anchor and position at the composition center, which is an identity mapping. It is soloed when any moved layer was, because solo is per composition. The rendered frames stay byte-identical (tested in `@kynimo/capture`).
- **Links never cross the boundary silently.** If a parent or track matte links a selected layer and an unselected one, in either direction, precompose is refused with the link named and the fix (include the layer, or clear the link). After Effects breaks such links and the frame changes; an agent should decide that, not discover it.
- **New change records `composition.insert` / `composition.remove`** carry the whole composition snapshot, like layer and marker records. A precompose is: insert the empty composition, then remove + insert per moved layer, then insert the precomp layer. Undo replays those inverted and conflicts if the new composition was edited since. Compositions get a third id namespace (`comp-N`).
- **No format change.** Documents look exactly as before, so `SCENE_FORMAT_VERSION` stays. Stored undo histories gain record types and stay valid.
- **MCP tools.** `add_mask` fills `feather`, `opacity`, `expansion`, `mode` and `inverted` defaults, `set_matte` and `precompose` map one-to-one onto their ops. Write results gain optional `compositions_added` / `compositions_removed`. In `apply_ops`, `addMask.mask` and `updateMask.set` are declared loosely (described in prose) and validated in full on the server, as ADR-0024 does for layer bodies and tracks.
- **Listing budget raised to 50 KB.** The three tools take the listing from ~33 KB to ~48 KB: each write tool carries write metadata, selectors and the write output (~3 KB) even with loose bodies. Loosening every selector or dropping tools would cost exact client-side validation or the roadmap surface.

## Consequences

- Every further write tool adds ~3 KB, so the budget will be hit again within M3–M4. Revisit when MCP resources land (M3): shared definitions served as resources, loose selectors, or fewer single-purpose tools.
- Precompose cannot yet trim the new composition to the layers' range or "leave all attributes" on a single layer; both are additive options.
- Precomposing a layer that a precomp elsewhere already shows is fine: compositions are referenced by id and nothing about the moved layers changes.
