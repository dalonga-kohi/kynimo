# 0017 — Drawing shapes, images and solids

- Status: accepted
- Date: 2026-11-07

## Context

ADR-0016 chose CanvasKit (Skia) on CPU raster surfaces plus our own WebGL2 compositor. The M2 "Draw shapes … images, solids" item has to turn an evaluated frame (ADR-0015) into pixels, and three questions were left open: how fills and strokes bind to geometry inside a shape layer (the schema deferred it to M2), what image formats we accept, and what the rasterizer hands the compositor. The compositor itself, and the headless capture that tests it, come in later M2 items.

## Decision

- **New package `@kynimo/renderer`**, depending on `canvaskit-wasm` 0.42.0 (exact pin, ADR-0016). It runs in Node under Vitest, in the browser and in workers; the caller passes `locateFile` for the WASM.
- **Geometry is ours, built in JavaScript** and handed to Skia as plain moves, lines and cubics, so start points and directions are fixed by us. They decide where dashes start, and where trim paths (M4) will start. Conventions follow After Effects and Lottie: primitives are centered on `position` and run clockwise on screen. Rectangles start on the right edge at the top, and their corner radius clamps to half the shorter side. Ellipses, polygons and stars start at the top. Corners and ellipses use cubic quarter-arcs (κ = 0.5519…). Polygons and stars have straight edges; roundness is not in the schema.
- **Fills and strokes bind with After Effects semantics.** Items are listed top-first. A fill or stroke paints every path listed above it in its own group, including the paths inside groups above it. Items lower in the list draw underneath, and a group's own paints draw at the group's place in that order. A paint with nothing above it draws nothing.
  - A fill over several paths fills them as **one compound path**, so even-odd acts across them, as in After Effects.
  - A paint's **gradient coordinates and stroke width live in the paint's own group space.** A stroke inside a scaled group scales with it; a stroke in an enclosing group that paints the same path does not.
  - **Group opacity** multiplies into the paints the group holds, through every enclosing group, as in After Effects and Lottie. It does not apply when an enclosing paint reaches into the group's paths.
  - Dashes follow SVG: an odd list repeats once, an all-zero pattern draws solid, and the offset wraps within one pattern. A zero-width stroke draws nothing (Skia would draw a hairline).
  - Gradients interpolate in unpremultiplied sRGB (Skia's default, as in After Effects) and clamp past their ends.
- **The rasterizer's output is a `FramePlan`**: per composition, top-first layers with premultiplied sRGB RGBA8 rasters and layer opacity, which the compositor applies.
  - **Shape layers** rasterize in composition space, cropped to their bounds (stroke outline included, plus one pixel for anti-aliasing) within the composition, at a whole-pixel offset. Dashed strokes with round or square caps also cover the path outset by the cap's reach, because each dash end gets a cap. Layers that cover no pixels are left out.
  - **Solids and images** rasterize in layer space, one pixel per unit, and carry their layer → composition matrix.
  - **Precomps** carry their nested plan. A precomp shown at the same local frame twice shares one plan.
  - Text, adjustment and component layers are listed as `skipped`, with a reason, until their items land. They are never drawn wrong.
- **Images: PNG and JPEG only**, detected by file signature and decoded by CanvasKit's codecs. These are the formats the ADR-0016 spike showed decode identically in Node and Chromium. Others are added only after the same check. An `ImageLibrary` holds decoded assets; adding one checks the bytes against the document's SHA-256 pin, the declared size, and a maximum of 8192 px per side (the composition limit, and a texture size every target can upload). Fetching bytes stays with the asset store (M3), so rendering reads only memory, never the network.
- **Each frame may allocate at most 2²⁸ raster pixels** (1 GiB of RGBA8), precomps included, so a small hostile document cannot exhaust a worker. Decoded images are not counted; the library holds them once.
- **`compositeReference`** is a Skia-only composite: normal blending, layer opacity, bilinear placement. Tests and tools use it to see whole frames before the WebGL2 compositor exists. It is not the export path.

## Consequences

- Imported After Effects and Lottie shapes will paint the way their authors expect, and agents can reuse After Effects knowledge. The cost is that item order is meaningful, which the MCP tool docs (M3) must explain.
- Tests here check that output repeats exactly (twice, and on a fresh CanvasKit instance) and probe pixels. Golden hashes come with the "headless capture" item, once they can be checked on the CI and worker CPUs (ADR-0016).
- A plan holds every layer's raster at once. If memory per frame becomes a problem, the compositor can consume layers as they are rasterized; the plan's shape allows that.
- Images larger than 8192 px per side must be downscaled before upload; the upload tool (M3) should do that or say so.
- Moving shape layers re-rasterize every frame (ADR-0016); raster caching is a later optimization.
