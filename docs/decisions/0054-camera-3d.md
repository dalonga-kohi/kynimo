# 0054 — 2.5D layers and cameras

- Status: accepted (amends ADR-0013: answers the parts of its 3D schema check that cover Z, the camera and the stacking model)
- Date: 2026-11-12

## Context

ADR-0013 put 3D compositing in v1.x and asked for a schema check (additive room, interaction with order, blend modes, mattes and precomps) before beta. It was pulled forward at the user's request. The user chose the scope: **flat cards in 3D**. A layer is still a flat 2D picture, now placed in space and seen through a camera. There are no lights, materials, shadows or models. Rendering stays deterministic and the scene graph stays the only source of truth; everything below is additive over format 11 (ADR-0053).

## Decision

- **Format 12.** `SCENE_FORMAT_VERSION` goes from 11 to 12. The migration adds `threeD: false` to every visual layer (drawn layers and null layers) and `positionZ`, `rotationX`, `rotationY` tracks at 0 to every layer transform. Version 12 renders a migrated document exactly as version 11 did; golden frames and `golden/determinism.json` are unchanged.
- **Data model.** Visual layers gain `threeD` (absent means false, so older `addLayer` operations validate). Layer transforms gain `positionZ`, `rotationX` and `rotationY`; they are valid targets for keyframes, behaviors and links, and act only on 3D layers and cameras (kept but ignored on 2D layers, as in After Effects). A new `camera` layer type carries `zoom` (animatable, 1 to 100 000, the distance in composition pixels at which one pixel maps to one screen pixel) and `pointOfInterest` (animatable 3D point, or `null` for a one-node camera). A camera is always 3D, uses only `position`, `positionZ`, `rotation`, `rotationX`, `rotationY` and its parent chain, and keeps `anchorPoint`, `scale`, `skew` and `opacity` without using them. It draws nothing, so it has no blend mode, matte, masks, effects or motion blur. Shape groups keep a 2D-only transform (`GroupTransformSchema`): they live in their layer's own plane.
- **Transform order and signs.** Composition space is +x right, +y down, +z away from the viewer. A 3D layer's local matrix is `translate(position, positionZ) · rotateX · rotateY · (rotateZ · skew · scale · translate(-anchor))`, so `rotation` is the familiar 2D rotation (clockwise on screen). Positive `rotationX` turns the top edge away from the default camera, positive `rotationY` turns the right edge away. A camera is `translate · lookAt(pointOfInterest) · rotateX · rotateY · rotateZ`; the look-at keeps +y (down) as close to screen-down as it can.
- **Active camera.** The topmost camera that is visible and in range is active. Without one, a default 50 mm camera frames the composition (`zoom = width * 50 / 36`, at `positionZ = -zoom`, looking at the centre). A new camera defaults to the same values. A non-finite or singular view throws a `RangeError` naming the layer.
- **Cameras cannot be parents.** Validation rejects a layer whose `parent` is a camera. A camera can itself be parented to a transform layer.
- **Parent chains.** A 3D layer composes the full 3D local of every 3D link and the 2D local of every 2D link. A 2D layer uses the 2D parts of its chain only (position, scale, rotation, skew, anchor), so documents without 3D are byte-identical to format 11.
- **Stacking model (After Effects, no collapse).** Layers still draw bottom to top. Within a contiguous run of 3D layers, the run is sorted by the depth of the layer's anchor point (farthest first, stable on ties); the 2D layers that bound it keep their place. A 2D layer or an adjustment layer ends a run, and an adjustment layer cannot be 3D. Mattes and track-matte sources work in composition space after projection. A precomp is a flat card: its inner layers are rendered flat with the nested composition's own camera, never in the parent's space (no collapse transformations). There is no per-pixel depth buffer and no splitting at intersections: two cards that cross each other are ordered as whole layers.
- **Projection.** The engine folds the camera into a 3x3 homography from layer space to the screen (`projection`), unnormalized: the third row carries `W`, the depth along the camera axis, so the compositor can interpolate perspective-correct coordinates and clip. `matrix` stays as its first-order affine approximation for consumers that cannot use the homography (bounds, hit areas, the blur planner's fallback). The renderer clips per pixel at the near plane `NEAR = 1` (`W <= 1` is not drawn) so a card that crosses the camera plane is cut, not mirrored.
- **Texture sampling.** The level of detail comes per pixel from the projective Jacobian, so a card receding into depth is sharp near and filtered far, instead of one level for the layer. The compositor builds the full mip chain (down to 1 px; a source up to 8192 px has 14 levels) and binds one sampler per level, so a 3D placement needs 14 texture units; the WebGL2 device must offer `MAX_TEXTURE_IMAGE_UNITS` of at least 16 (the renderer fails fast with a clear message when it does not).
- **3D vector raster.** Shapes and text on a 3D layer are rasterized in layer space, not composition space (the plane is no longer axis-aligned on screen). The raster scale `s` is 1 when the layer has effects (they were designed for 1 px layer units), otherwise `2^k` with `k <= 3`, chosen from how large the card appears, and reduced until it fits 8192 px. A 2D layer keeps its composition-space raster.
- **Motion blur.** Each motion blur sample (ADR-0053) carries a full projection, so a layer that flies through depth blurs radially, and camera motion blurs 3D layers (the camera is sampled at each sample time). 2D layers stay unaffected by the camera.
- **Costs.** Mip chains add 4/3 of the texture memory of a 3D layer's source. Each level costs one downsample pass when the texture is built. The per-frame effect-sample budget is unchanged: a 3D layer is charged like a 2D one.
- **Parity.** Measured on the GPU compositor against the reference compositor: the largest gap is 1/255 per channel on the 3D scenes of the tests.
- **Surface.** `get_capabilities` lists `features.three_d` (layers and camera support, limits; lights and models stay `unavailable`). `get_layer_schema` and `apply_ops` carry `threeD`, the three transform tracks and the camera patch fields with their bounds, so an out-of-range value is rejected at the protocol layer. The reference scene `camera-3d` pins a dolly and an orbit, a flat 2D background and title, three cards at different depths (a masked solid, a rounded card with a stroke turning through 70 degrees about Y, 3D text tilted about X) whose depth order changes mid-shot, a precomp card and a motion blurred layer flying through Z.
- **Caps raised.** The scene JSON schema resource limit goes from 90 000 to 100 000 bytes, the capability manifest from 10 500 to 11 300 bytes, the `apply_ops` listing from 15 000 to 15 500 and `tools/list` from 102 000 to 103 500 bytes (102.9 KB measured). These are the budgets that tests enforce so new fields cannot bloat the listing unnoticed.

## Alternatives

- **One global depth sort across all layers.** Reorders 2D layers against 3D ones and breaks the stacking order agents rely on for 2D work; After Effects does not do it.
- **Collapse transformations (3D precomps in the parent's space).** Needs the nested layers in one scene space; deferred as a larger model change.
- **A per-pixel depth buffer.** Exact at intersections, but breaks blend modes, mattes and effects that assume an ordered stack, and transparent cards need sorting anyway.
- **One constant level of detail per layer.** Simpler, but a card receding into depth is either blurry up close or aliased far away.
- **Rasterizing vectors in composition space through the inverse homography.** Re-rasterizes under every camera move and has no good bound on the source resolution; layer-space raster is cached and the GPU does the mapping.

## Consequences

- Agents get depth, perspective and camera moves on the existing layers, with the same operations (`updateLayer`, keyframes, behaviors, links) and a quality bar the reference scene pins; nothing draws outside the scene graph.
- The renderer needs 16 texture units, which every WebGL2 implementation we target offers; the software rasterizer of the export workers does too.
- Two cards that intersect are drawn whole, one over the other, with no visible seam; an agent who needs an exact intersection splits the card itself.
- The listing budgets are close to their caps again; the next field has to pay for itself.

## Follow-ups

- Lights, materials and shadows; glTF / GLB model layers (still ADR-0013).
- Orientation tracks (a single 3D orientation instead of X, Y and Z).
- Z scale and a Z anchor, so a flat card can have depth.
- Collapse transformations for precomps.
- Splitting cards at intersections.
- Parenting to a camera.
- Depth of field.
- An orbit / dolly intent tool that writes the camera keyframes.
- Effect scaling when a huge 3D vector layer drops below 1x of its raster.
