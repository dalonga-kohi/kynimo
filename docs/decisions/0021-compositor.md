# 0021 — The compositor: blend modes, mattes, placement

- Status: accepted (completes ADR-0016's compositor half; fixes the blend formulas ADR-0020 left open)
- Date: 2026-11-07

## Context

ADR-0016 split rendering into a CPU rasterizer (Skia) and our own WebGL2 compositor. ADR-0020 put blend modes, track mattes and per-layer mask rasters into the frame plan, but nothing drew blend modes or mattes yet. This item builds the compositor. Its GLSL runs only in a browser, while the rest of the renderer is tested in Node. The eight non-W3C blend modes needed formulas, and resampling (bilinear plus mipmaps when minifying) had to be defined precisely enough to test.

## Decision

- **Two implementations of one pipeline.**
  - `compositeReference` is the specification: plain JavaScript in float64, testable in Node. It replaces the Skia-only stand-in and no longer needs CanvasKit.
  - `createCompositor(gl)` runs the same steps as GLSL ES 3.00 passes over premultiplied RGBA16F targets. Shared plan-reading code (matte chains, placement, level of detail, mode ids) lives in one browser-safe module.
- **Per composition, bottom layer first:**
  1. The layer's raster (or its precomp, composited at float precision) is multiplied by its mask coverage.
  2. It is placed into composition space through the inverse of its placement: a whole-pixel offset for vector layers, the layer matrix otherwise. Sampling is bilinear with transparent texels outside the image.
  3. It is multiplied by its track matte and its opacity.
  4. It is blended into the accumulator.

  The root background goes under the result as source-over, so layers never blend with it, as in After Effects. The output is clamped and quantized to premultiplied sRGB RGBA8.
- **Mipmaps are ours, not the GPU's.**
  - Level n+1 averages 2×2 blocks of level n, counting texels past the edge as transparent; sizes are ⌈size / 2⌉ down to 1×1.
  - The level of detail is log₂ of the longer texel-space step per composition pixel. It is constant per layer, because placements are affine. Up to 0 it is plain bilinear; above 0 it is trilinear between the two nearest levels.
  - Every texture read is a `texelFetch`, so GPU filtering, its precision and its mip rules never enter the result.
- **Track mattes.**
  - Alpha mattes use the source's alpha. Luma mattes use the Rec. 709 luma of its premultiplied sRGB-encoded color, so a transparent source has luma 0. The inverted modes use 1 minus that value.
  - The matte source is placed with its own mask, matte and opacity. Chains are evaluated from the far end, with two comp-size targets alive at a time.
- **Blend modes:**
  - **Separable:** each channel combines straight (unpremultiplied) colors `B(Cb, Cs)`, using W3C alpha compositing: `co = cs·(1 − αb) + cb·(1 − αs) + αs·αb·B(Cb, Cs)` and `αo = αs + αb·(1 − αs)`. Where either side is transparent, that is plain source-over.
  - **Non-separable:** hue, saturation, color and luminosity follow the W3C `SetLum` / `SetSat` definitions.
  - **The eight extras use the common Photoshop / After Effects formulas, clamped to 0..1:**
    - add: `b + s`
    - subtract: `b − s`
    - divide: `b / s`, with `s = 0` giving 1, or 0 when `b = 0`
    - linear burn: `b + s − 1`
    - linear light: `b + 2s − 1`
    - vivid light: color burn with `2s` when `s ≤ ½`, color dodge with `2s − 1` otherwise
    - pin light: `min(b, 2s)` when `s ≤ ½`, `max(b, 2s − 1)` otherwise
    - hard mix: 1 when `b + s ≥ 1`, else 0
- **Tests compare the GPU against the reference** in the pinned Chromium on SwiftShader (ADR-0016 flags), driven by Playwright 1.63.0. Vite bundles the compositor for the test page.
  - **Coverage:** every blend mode; every matte mode, including chains and empty mattes; masks; sub-pixel, rotated, magnified and minified placement; degenerate transforms; nested transformed precomps.
  - **Tolerance:** 2/255 per channel. In the blend-mode tests the measured gap is at most 1/255. For the stepped modes (hard mix, divide, color dodge and burn, vivid light), a color channel may differ more only where nudging the inputs by 3/255 crosses a step; alpha must always match. Deliberately broken hard-mix and vivid-light thresholds fail the tests.
  - **Determinism:** the GPU result is byte-identical across runs and fresh browser launches.
  - CI installs the pinned Chromium.
- **The compositor refuses what it cannot do** with a `CompositorError`: a context without float render targets, an image above `MAX_TEXTURE_SIZE`, a lost context, or any GL error during the frame (an out-of-memory allocation would otherwise read back as a blank frame). It reports `UNMASKED_RENDERER_WEBGL`, so workers can refuse to run anywhere but SwiftShader.
- **Nested precomp results are freed after their last read.** Before compositing, the compositor counts how often each nested frame plan is read (once per precomp along every drawn layer's matte chain), keeps a result while reads remain and frees it after the last. The reference does the same.

## Consequences

- The reference and the GPU can only drift apart together with a failing test, and every formula is readable in one file (`blend.ts`).
- The compositor keeps no state between frames and frees every texture and framebuffer it made, also when a frame fails, at the cost of re-uploading rasters each frame. Caching uploads and mip chains is an optimization for later.
- GPU memory per frame: a few composition-size RGBA16F targets (8 bytes per pixel) per nesting level, plus the nested results that still have reads left. Those are usually few, because a precomp is read where it is drawn, but a frame that shows many time-offset copies of a precomp in a matte chain can hold several at once. An 8192² composition needs about 0.5 GiB per target, so render workers need GPU memory limits that match the frame pixel budget. Revisit when workers land (M7).
- `compositeReference` is slow: every layer touches every pixel. It serves tests and Node tools, never exports.
- Golden hashes of whole frames and the PNG capture belong to the next item (headless capture). The worker CPU caveat of ADR-0016 still applies.
- Adjustment layers (M4) will read the accumulator as their source; the pass structure allows it.
