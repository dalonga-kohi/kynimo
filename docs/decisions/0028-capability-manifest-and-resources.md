# 0028 — Capability manifest and schema resources

- Status: accepted (implements ADR-0018's capability manifest; resolves ADR-0024's note on a scene schema resource)
- Date: 2026-11-09

## Context

ADR-0018 asks for a manifest, generated from code, that says per layer type and feature whether this build `renders` it, accepts it without rendering (and why), or lacks it, served as a resource **and** a tool. The format already admits adjustment, component and audio layers that frames do not draw, and tool schemas declare layer bodies loosely (ADR-0024), so agents need a cheap place to look things up. The roadmap item also lists preset, token, component and shader catalogs, but none of that data exists before M4–M6.

## Decision

- **Support tables live in the renderer.** `@kynimo/renderer` exports `LAYER_SUPPORT`, `SHAPE_ITEM_SUPPORT`, `PAINT_SUPPORT`, `MASK_MODE_SUPPORT`, `MATTE_MODE_SUPPORT` and `BLEND_MODE_SUPPORT`, each a `Record` over the scene's own union, so adding a layer type, shape item or mode to the format does not compile until the renderer declares what it does with it. A `Support` is `{ status: "renders", note? }` or `{ status: "accepted", reason }`. Blend modes come from the compositor's shader table, formats from the tables the loaders check against, and the frame planner takes its skip reasons from `LAYER_SUPPORT` (and throws if a type it skips is marked `renders`). A renderer test plans one layer of every type and checks it is skipped exactly when the table says `accepted`, with the same reason, so a render result and the manifest cannot disagree. Runtime tests check every layer type, paint, blend, mask and matte mode and asset type has an entry; shape items are checked by the `Record` type only, since their union is recursive. Audio is `accepted` but never in `skipped`: the engine resolves it as sound, not as a frame layer, and the manifest's legend says so.
- **Manifest shape** (`apps/mcp`): `server`, `scene_format_version`, a `statuses` legend, `layer_types`, `features` (shape items, paints, blend, mask and track matte modes), `assets` (per asset type, with formats and bundled fonts), `render` (tools and `RENDER_LIMITS`), `unavailable` and `resources`. Every entry is keyed and carries a `status`; anything not `renders` has a `reason`. It is about 5 KB and a test keeps it under 8 KB.
- **`unavailable` is the one hand-kept part**: features with no room in the format or no tool yet (asset upload, video, effects, shape operators, text animators, behaviors, intent tools, SVG import, shaders, styles, components, catalogs, export, keyframed text, 3D), each with the milestone that brings it. The item that ships a feature removes its entry.
- **Served twice, same bytes**: the `get_capabilities` tool (no input, minimal open output schema) and the `kynimo://capabilities` resource. The server instructions tell agents to call it once.
- **Schema resources**: `kynimo://schema/scene` (a whole project document), `kynimo://schema/ops` (one scene operation, the item of `apply_ops.ops`) and the template `kynimo://schema/layer/{type}` (listed per type, with completion), all input-side JSON Schema with `$ref` reuse. The layer resource returns exactly what `get_layer_schema` does; the scene and op schemas are resources only, since they are large (about 27 and 31 KB) and fetched on demand.
- **Catalogs wait for their data.** Preset (M4), token (M5), component and shader (M6) catalog resources are added by the items that create them; until then the manifest lists them under `unavailable`, and each of those roadmap items names its catalog resource. No empty resources are registered, so no URI is fixed before its content is designed.
- **No renderer build id in the manifest.** It comes from the launched Chromium, and a capabilities read should not boot a browser. Render results keep reporting what they skipped.

## Consequences

- New format features cost one line in a renderer table, and the type checker enforces it.
- `unavailable` can go stale if a shipping PR forgets it; the reviewer checks it when an item lands (as with the roadmap).
- The tool listing is at about 59.8 KB of its 60 KB budget. ADR-0025 and ADR-0026 named this item as the point to fix the listing size structurally; it is deferred on purpose, to keep this item to the manifest and resources. The asset storage item owns it now (roadmap): its `upload_asset` and `list_assets` cannot fit otherwise.
- `@kynimo/mcp` now depends on `@kynimo/renderer` directly (it already did through `@kynimo/capture`).
