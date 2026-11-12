# 0049 — Built-in component placement over MCP

- Status: accepted
- Date: 2026-11-12

## Context

ADR-0046 added component instances and ADR-0047 shipped five built-ins. Agents had to construct a component layer by hand, and component-specific prop errors first surfaced during rendering.

## Decision

- `list_components` and `kynimo://components` return the same built-in registry entries in id and version order, with titles, descriptions, and prop descriptors.
- `add_component` expands to one `addLayer` operation. An explicit version selects that exact definition. Omitting it selects the latest built-in version and pins it on the layer. The tool takes a target composition (main by default), optional layer id and name, a top-first index, and an in/out frame window. Component time starts at the in frame. The layer uses the composition origin because built-ins already lay out their content in composition coordinates.
- The component prop resolver checks supplied values, all prop keyframes, and asset references against the selected definition and project before the write. The scene stores the caller's props, including any style roles and keyframe tracks. It resolves defaults, roles, and keyframes during evaluation.
- Placement uses the existing intent write path for dry run, version checks, idempotency, and undo.

## Consequences

Agents can discover and place the built-ins without constructing a raw component layer. The existing scene format can store every instance. `build_from_brief` can reuse the placement expansion when its input contract is defined.
