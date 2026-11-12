# 0056 — Puppet pin mesh deformation

- Status: accepted
- Date: 2026-11-12

## Context

Puppet pins let an agent bend artwork while keeping its source, placement, and animation editable. This v1.x feature was pulled forward at the user's request. The deformation lives on the layer and uses the layer-space rendering introduced for 2.5D in ADR-0054.

## Decision

- **Scene format 15.** The 14 → 15 migration adds `deform: null` to shape, text, image, video, solid, generator, precomp and component layers. Older `addLayer` operations may omit it. Set or replace `deform: { pins, density, iterations }` with `updateLayer` through `apply_ops` or `update_layer`. `null` clears it and an empty pin list has no effect. Adjustment, null, camera and audio layers reject the field with a pathed error. Retime and stagger move pin keyframes and write back the deformation field through `updateLayer`.
- **Pins.** Each pin has a layer-unique `id`, a layer-space `rest: [x, y]`, and a `position` track of layer-space points. Position is sampled at the center frame in layer time. Rest snaps to the nearest retained mesh vertex, with row-major order breaking ties. The hard target is that vertex plus the sampled `position - rest` displacement in raster units, so an off-grid neutral pin preserves the pose. When pins share a vertex, the first wins and the renderer emits one `deform-pin-collision` warning per layer with the count and up to five pin IDs.
- **Mesh.** The density is the cell count along the longer side, with `ceil(density × short / long)` along the other side and at least one cell per side. Image, video, shape and text retain cells touched by positive source alpha and positive mask coverage, including any positive-area overlap of a source pixel and a cell. A one-cell margin includes diagonal neighbors and stays within the grid. Solid, generator, precomp and component sources use the full rectangle. The renderer compacts active vertices in row-major order and splits each retained cell along its northwest–southeast diagonal. Empty alpha sources need no solve.
- **Solve.** During frame planning, the renderer runs a fixed number of Float64 as-rigid-as-possible (ARAP) local/global iterations with uniform edge weights. Local rotations use `atan2` of the summed cross and dot products. The global step uses the average endpoint rotations and a graph Laplacian with the pinned coordinates eliminated. One banded Cholesky factor serves both axes and all iterations. Connected components with no pin keep their rest pose. A mesh whose winning pins all have zero displacement needs no warp.
- **Draw order.** Masks multiply source alpha before the triangle pass. Deformation draws into layer space with a one-texel transparent border, followed by effect padding and effects. Deformed shape and text use the camera feature's layer-space raster at 1×, halved as needed to fit. The same affine or projective placement uses the solved origin, and 3D near clipping sees the warped result. Motion blur reuses the center-frame warp and varies placement and opacity across the shutter. A shader transition mixes the backdrop with the warped, placed layer composited over it (ADR-0057).
- **Sampling.** WebGL uses `drawArrays(TRIANGLES)` and four `texelFetch` taps for transparent-outside bilinear sampling of masked premultiplied source texels. The CPU uses a top-left fill rule and barycentric interpolation. Both share destination vertices at 1/16-pixel precision and float32 source coordinates. Later triangles overwrite earlier ones in triangle index order, including transparent samples in folds. WebGL clears recycled targets before the triangle pass.

## Limits and measured costs

Each layer accepts up to 32 pins, density 4–64 (default 24), and 1–30 iterations (default 10). A full 64×64 grid has 8,192 triangles. The renderer checks finite coordinates, displacement, solver pivots and output. Mapped pin rest coordinates, displacements, targets, solved positions and the target origin must fit within ±2²⁰ raster pixels. Each source and each effect-padded warp target is limited to 8,192 pixels per side. The target also counts toward the frame's raster allocation budget. Errors name the affected layer.

Planning and compositing each have a shared 128 million-unit frame budget, including nested compositions and mattes. Let `W,H` be source dimensions, `C,R` grid dimensions, `P` pins, `V` retained vertices, `N` free vertices, `b` the lower matrix bandwidth, `I` iterations, and `T` triangles. Planning charges:

- `32(C+1)(R+1)` for grid and graph work, plus `W×H + (W+C)(H+R)` when scanning alpha.
- `P×V` for snapping pins and `N(b+1)²` for the factorization. The factor takes O(`Nb²`) time and O(`Nb`) memory.
- `I[4N(b+1) + 12T + V]` for local rotations, right-hand sides and substitutions, O(`Nb + E`) per iteration for `E` mesh edges.
- The padded target area, plus `T`, plus the sum of `(ceil(width)+2) × (ceil(height)+2)` over triangle bounding boxes. Each compositor charges that same draw estimate per actual draw, including repeated matte reads.

Warmed medians on an AMD Ryzen 5 3600 with Node 24.19.0, using two pins per layer. CPU composite times include placement and blending.

| Source                 | Density / iterations | Triangles |  Plan work | Draw work |      Factor | GPU vertex buffer |      Plan | CPU composite |
| ---------------------- | -------------------: | --------: | ---------: | --------: | ----------: | ----------------: | --------: | ------------: |
| 256×160 alpha raster   |              24 / 10 |       720 |  1,093,561 |   179,619 |    85,968 B |          34,560 B |   6.00 ms |      16.97 ms |
| 256×256 full rectangle |              64 / 30 |     8,192 | 56,602,063 |   472,576 | 2,263,528 B |         393,216 B | 191.66 ms |      25.40 ms |

The CPU and pinned SwiftShader differed by at most 1/255 per channel at placement scales 1.0, 0.6 and 0.3. The shared-edge, fold and recycled-target cases matched exactly. Repeating each frame on the same compositor produced identical bytes. The `puppet-deform` reference pins a cyan ribbon with inset bands and a purple-and-amber precomp card bending in opposite directions. The ribbon casts a post-deform shadow. The card uses 3D placement and transform motion blur.

## MCP surface

`get_layer_schema` provides the full track schema, while the compact tool listing describes pin position tracks as objects and lists rest points as two-number arrays. `get_capabilities` reports `features.deform` and the limits above under `limits.deform`. With shader transitions and puppet pins, `apply_ops` measures 16,115 bytes against a 16,500 cap. `update_layer` measures 4,311 bytes and keeps its 4,500 cap. The total listing measures 116,112 UTF-8 bytes (116,108 JavaScript string characters measured by the test), raising its cap from 116,000 to 116,500. The manifest measures 13,273 bytes with the test version and 13,274 bytes on the server. Its cap stays at 13,500. The deduplicated scene input resource is 79,984 bytes. The tested output schema is 105,629 bytes, raising its cap from 105,000 to 106,000.

## Alternatives

- **Contour triangulation.** Tighter alpha meshes would need contour extraction and triangulation. The regular grid gives deterministic connectivity and bounded bandwidth.
- **Dense or iterative linear solves.** A dense factor needs quadratic storage. Iterative convergence depends on the pose and tolerance. The banded factor and fixed iteration count give a predictable bound.
- **Composition-space warp.** Pin coordinates would vary with placement, and 3D and shutter samples would require separate warps.

## Consequences

Agents can animate local deformation independently of layer and camera transforms. The fixed vector raster can soften at large placement magnifications. Image or video alpha can change the mesh and snap vertices between frames. Sharp folds follow triangle order, and complex warps may need lower density or fewer iterations to stay within the frame budget.
