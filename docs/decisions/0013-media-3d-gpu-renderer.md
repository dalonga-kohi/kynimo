# 0013 — User media, 3D direction and a GPU renderer

- Status: accepted (amends ADR-0008: 3D moves from out-of-scope to v1.x; amends ADR-0004: the renderer is GPU-based; narrows the M2 drawing-backend decision; the exact stack is ADR-0016)
- Date: 2026-11-06

## Context

Product promos and UI clips are built from the user's own material: screen recordings, photos, logos, brand fonts, existing animations and increasingly 3D product renders. The capability map had video at v1.x, fonts as bundled-only, no Lottie import, and 3D out of scope. Built-in and custom shaders (ADR-0012) need a GPU drawing path, which Canvas 2D and SVG can't provide.

## Decision

- **v1 (beta):** image layers, **video layers** (normalized to constant frame rate and pre-decoded to frames with FFmpeg at upload; an embedded audio track is extracted into its own audio asset that can be placed as an audio layer), SVG import to editable shape layers, **uploaded custom fonts** pinned by content hash next to the bundled ones, and **2D shaders** (built-in + custom GLSL, ADR-0012).
- **v1.x:** **3D compositing** (3D layers with Z, cameras, lights, depth), **glTF/GLB 3D model layers**, shaders on 3D layers and models (materials), and **Lottie import** to editable layers (unsupported features reported, never silently dropped).
- **Renderer direction: WebGL2.** Canvas 2D and SVG are no longer candidates for the main backend. The M2 ADR still picks the exact stack and must prove determinism on the pinned software rasterizer in workers; it must also confirm how the pinned headless Chromium enables that rasterizer (recent versions may no longer fall back to SwiftShader automatically). WebGPU is a later option.

## Consequences

- Users can bring their own photos, videos, vectors, fonts and (from v1.x) Lottie and 3D models; everything imported becomes scene-graph layers or pinned assets, so it stays editable.
- The scene schema v1 must leave room for 3D so v1.x adds it without a breaking change. Today's transform is strictly 2D, so "room" means additive changes only: an optional per-layer 3D switch, optional Z / orientation tracks, and new camera, light and model layer variants. How 3D layers interact with layer order, blend modes, mattes and precomps is designed in a schema check before beta (roadmap).
- M2 builds on WebGL2: blend modes, mattes, masks and effects are implemented as GPU passes. Text and vector paths need a GPU-friendly path renderer, which is more work than Canvas 2D.
- Video decoding at upload needs FFmpeg in the cloud before export workers exist (M3 asset pipeline).
- Custom fonts need validation at upload (format, size) and we record their license metadata. Shaping must stay deterministic with them, including glyph fallback: characters missing from an uploaded font fall back to a pinned bundled font.
- In PRODUCT.md, 3D moves from a plain non-goal to "not in v1, planned for v1.x".
