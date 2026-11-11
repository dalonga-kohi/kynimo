# 0043 — SVG import

- Status: accepted
- Date: 2026-11-11

## Context

ADR-0018 promised SVG import to a shape layer with a fidelity report and a dry run. The shape layer (ADR-0027 and its operator follow-ups) can already hold paths, parametric shapes, fills, strokes, gradients and groups, so an SVG can become native, editable motion graphics instead of a picture. Agents pass SVG text they wrote or fetched, and nothing in it may be trusted. ADR-0030 and ADR-0031 had set SVG aside for this milestone.

## Decision

- **`@kynimo/svg`.** A new pure package: `importSvg(text)` returns shape-layer contents, the viewBox, the intrinsic size, the layer anchor and scale, the root `<title>` and a fidelity report. It has no I/O and is deterministic. It throws `SvgImportError` (`too-large`, `not-svg`, `malformed`, `entities`, `limit`) for input it refuses and reports everything else it cannot carry.
- **Inline text, no new asset kind.** The SVG travels as text, at most 512 KB, in the tool call. There is no SVG asset kind and no scene format bump: the result is an ordinary shape layer.
- **Parsing.** `fast-xml-parser` 5.x. A document containing `<!ENTITY` is rejected before parsing (no entity expansion), and the nesting depth is bounded (`xmlDepth` 256) so every walk over the tree is bounded. Dependency justification: one parser with seven small transitive dependencies, maintained, and it does not touch the network or filesystem. Writing an XML parser ourselves would be more code to get wrong with hostile input.
- **One layer.** The whole SVG becomes one shape layer. SVG user space is kept as it is and mapped by the layer transform: the anchor is the viewBox centre and the scale follows `preserveAspectRatio` (and the optional `width` of the tool).
- **Structure.** SVG document order is reversed into top-first items. Each painted element becomes one group with its stroke above its fill. Subpaths become path items under one compound fill, which keeps `fill-rule` (nonzero and evenodd) and holes. `rect`, `circle` and `ellipse` stay parametric items, so they remain editable; lines, polylines, polygons and paths become path items. Arcs become cubic segments.
- **Transforms.** An element transform is decomposed into a group transform (translate · rotate · shear · scale) when it can be, and baked into the coordinates otherwise, with a `baked-transform` entry. Group opacity on a single child is carried; other group opacity is reported.
- **Style.** The cascade is read from presentation attributes and the inline `style` attribute, with inheritance. `<style>` sheets are not applied and are reported. A style declaration or presentation attribute that is neither carried nor harmless (font and text properties, rendering hints, vendor-prefixed ones, and values equal to the default) is reported as `unsupported-property`, with the distinct property names (up to ten) in the detail. A transform on the root `<svg>` is applied like a group transform.
- **Input hardening.** Every pattern over attribute text is linear-time (one shared unambiguous number pattern; hand-written `url()` parsing), the parser enforces the XML depth limit, and coordinates or sizes that overflow (outside roughly ±1e15, or sizes below 1e-6) are refused with a `limit` error instead of producing non-finite numbers. `import_svg` replies leave out the layer contents (read them with `get_scene`).
- **Gradients.** Linear and radial gradients with `objectBoundingBox` and `userSpaceOnUse` units, `gradientTransform` and `href` inheritance. Stop opacity is carried. Kynimo's gradients are two-point linear and circular radial, so a stretched or skewed radial gradient, a linear gradient whose colour bands would lean, a focal point, a spread method other than pad and more than the supported number of stops are reported as approximated.
- **`<use>`.** Expanded in place with a bounded depth (`useDepth` 8), a bounded total (`expandedElements` 5000) and cycle detection.
- **Limits.** `SVG_LIMITS`: source 512 KB, 5000 parsed elements, 5000 expanded elements, `<use>` depth 8, 50 000 output vertices and XML depth 256. A subpath longer than 1000 vertices is a hard error, not truncated (follow-up: split it instead).
- **Report.** Entries have a kind (`dropped`, `flattened`, `approximated`), a stable kebab-case feature key, a count, up to five examples (`tag#id` or an index path) and one sentence saying what happened and what the agent can do. Entries are aggregated by feature and sorted. A summary counts elements, groups, paths, fills, strokes and vertices. Reported features: dropped `unsupported-property`, `zero-length-cap`, `text`, `image`, `filter`, `mask`, `clip-path`, `pattern`, `marker`, `animation`, `foreign-object`, `style-sheet`, `hidden`, `unknown-element`, `missing-reference`, `invalid-color`, `transform-error`, `gradient-bbox`; flattened `baked-transform`, `group-depth`; approximated `switch`, `viewport-clip`, `gradient-transform`, `gradient-focal` (also a focal radius `fr`), `gradient-stops`, `spread-method`, `group-opacity`, `element-opacity`, `line-join`, `non-uniform-stroke`, `vector-effect`, `dash-invalid`, `dash-count`, `path-data-error`, `preserve-aspect-ratio`, `invalid-viewbox`, `relative-unit`, `nested-svg`, `symbol-viewbox`.
- **`import_svg` tool.** An intent tool in `apps/mcp`: it takes the SVG, optional `layer_id`, `name`, `composition`, `position`, `width` and `index`, and expands into one `addLayer` operation. It has `dry_run`, the shared write fields and idempotency, and returns the layer id, the resulting size, the viewBox and the report. The `tools/list` budget in `server.test.ts` goes from 75 to 77 KB (`import_svg` is about 2.1 KB); shrinking the listing stays an M8 item.
- **Fidelity is measured.** `packages/capture/src/svg-fidelity.test.ts` imports five 320 × 320 fixtures, renders them through the pipeline in the pinned Chromium, rasterizes the same SVG with Chromium's own SVG renderer (an `<img>` drawn on a canvas over white) and compares RGBA. The test requires under 0.5 % of pixels differing by more than 48 in any channel and a mean absolute channel difference under 1.5 of 255, and writes both images and a diff to `renders/svg-fidelity/` on failure. The fixtures cover every path command with arcs, evenodd and nonzero compounds; gradients in both unit systems with `gradientTransform` and stop opacity; nested translate, rotate, scale and skew groups with group opacity; strokes with widths, caps, joins, miter limit and dashes; and `<use>`, basic shapes, named colours and `currentColor`. They avoid what the report lists as approximated, and the test asserts each report is empty. Measured:

  | Fixture    | Pixels over 48 | Mean channel difference |
  | ---------- | -------------- | ----------------------- |
  | paths      | 0.002 %        | 0.020                   |
  | gradients  | 0.023 %        | 0.152                   |
  | transforms | 0.001 %        | 0.019                   |
  | strokes    | 0.000 %        | 0.010                   |
  | shapes     | 0.036 %        | 0.127                   |

  The comparison found one converter gap: a linear gradient on a non-square bounding box with a diagonal vector (or a skewing `gradientTransform`) leans its colour bands in SVG, while ours stay perpendicular, and this was not reported. It is now an approximated `gradient-transform` entry.
- **Reference scene.** `svg-import` (a logo with gradients, a rotated group, an evenodd hole and a stroked gradient, plus an icon at two sizes, entering with keyframes on the layer transform) is generated from its SVG sources by a test and approved like the other reference scenes.

## Alternatives considered

- **Upload the SVG as an asset and bump the format.** A new asset kind and a renderer that rasterizes SVG would make the result a picture, not editable layers.
- **One layer per element.** It floods the layer list and loses grouping and shared transforms; one layer with groups is what After Effects' "Create Shapes from Vector Layer" does.
- **`svgson` or `svg-pathdata`.** Fewer features than we need (entity safety, depth bounds, arcs to cubics) and a second parser to review; `fast-xml-parser` plus our own path reader is smaller.
- **`clipPath` to masks.** Masks are per layer, not per element, so a faithful translation needs layer splitting. Reported as dropped for now.

## Consequences

- An agent can bring existing vector art in as native, animatable shape layers and see exactly what was lost.
- Imports are bounded in size, time and memory, and are deterministic: the same SVG gives the same operation.
- Rendered output matches Chromium's SVG renderer to within edge anti-aliasing for everything not in the report, and the test keeps it so.
- Follow-ups: split subpaths over 1000 vertices instead of refusing them; apply `<style>` class selectors; translate `clipPath` to masks; accept SVG through `upload_asset`; convert `<text>` to text layers.
