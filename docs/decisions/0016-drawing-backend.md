# 0016 — Drawing backend: Skia CPU raster + own WebGL2 compositor

- Status: accepted (narrows ADR-0013's WebGL2 direction to an exact stack)
- Date: 2026-11-06

## Context

ADR-0013 set the renderer direction to WebGL2 and left this ADR to pick the exact stack. The stack has to draw everything in M2 (shapes with fills, strokes, dashes and gradients; images; solids; shaped text) and run blend modes, track mattes, masks, the M4 effect list and custom GLSL shaders (ADR-0012). It must hold "same document + same frame → same pixels" in render workers (ADR-0004, ADR-0008). ADR-0013 also asked us to prove determinism on the pinned software rasterizer and confirm how headless Chromium enables it.

The hard parts of 2D drawing are path rendering (anti-aliasing, stroke joins, caps, dashes, even-odd fills, gradients) and text shaping. Writing those ourselves on raw WebGL2 would take weeks and carry real correctness risk. Skia, compiled to WebAssembly as CanvasKit, already does both, with HarfBuzz shaping inside the WASM module. The open question was how Skia's output reaches a GPU compositor we control.

We measured this with a reproducible spike ([`spikes/renderer-backend`](../../spikes/renderer-backend/README.md)): Chromium 153.0.8010.12 (Playwright 1.63.0), CanvasKit 0.42.0, a 1920×1080 frame, three fresh browser launches.

| Experiment                                        | Result                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| WebGL2 in headless Chromium with the flags below  | ANGLE → Vulkan → SwiftShader (Subzero); float render targets, 4× MSAA                                           |
| GLSL pass (RGBA8), and a two-pass RGBA16F chain   | Identical across launches                                                                                       |
| Skia **CPU raster** of shapes + shaped text       | Identical across launches **and identical in Node and in Chromium**                                             |
| Skia CPU raster → texture → our WebGL2 blend pass | Identical across launches; ~95–110 ms raster + ~60 ms upload/composite/readback incl. shader compile            |
| PNG and JPEG decoded by CanvasKit's codecs        | Identical across launches and identical in Node and in Chromium                                                 |
| Skia **GPU backend sharing our WebGL2 context**   | Frame 0 correct; after one raw GL pass every later frame is corrupted (MAE 53/255), even with `_resetContext()` |
| Skia GPU backend alone, redrawn                   | Stable, so the corruption comes from GL state sharing                                                           |

CanvasKit's GPU backend caches GL state, and its public API has no way to reset that cache. The internal `_resetContext()` only partly resets it. Sharing one context with Skia's GPU backend would therefore tie us to CanvasKit internals and still be wrong.

## Decision

The renderer has two halves that meet at premultiplied RGBA textures.

- **Rasterizer: CanvasKit (Skia WASM) on software raster surfaces only.**
  - Skia draws shape paths (fills, strokes, joins, caps, dashes, gradients, fill rules), text, and mask paths. It decodes images and video frames.
  - Raster space follows After Effects:
    - **Vector and text layers** are rasterized in composition space with their resolved 2D transform applied (After Effects' continuous rasterization), so scaled vectors stay sharp.
    - **Image, video and solid layers, and precomps**, are rasterized or composited in layer space. The compositor then places them with their transform, resampling with one fixed filter: bilinear, plus trilinear mipmaps when minifying.
  - **Effects and shader effects run in the layer's raster space:** composition space for vector and text layers, layer space for the rest. This is the same split as After Effects, and ADR-0012's effect-shader inputs refer to that space.
  - Each raster region is the layer's bounds, padded by its effect stack's bounds expansion (blur radius, shadow offset and so on), so effects don't clip at the frame edge. It is limited to the composition plus that padding.
  - Images and pre-decoded video frames are decoded by CanvasKit's own codecs, not the browser's. The spike checks this for PNG and JPEG. Pre-decoded video frames are stored as lossless PNG. The M2 "Draw shapes … images" item pins the formats we accept, and the M3 video item revisits storage size.
  - Text is shaped and laid out by CanvasKit's Paragraph API (HarfBuzz inside the WASM). Its font manager gets only fonts we hand it (bundled, or uploaded and pinned by hash). System fonts are never consulted, so missing glyphs fall back only to a pinned bundled font (ADR-0013). Font loading, fallback order and layout are decided in the M2 text item.
  - CanvasKit's GPU backend and SkSL runtime effects are not used.
- **Compositor: our own WebGL2 code in `@kynimo/renderer`, no framework.**
  - Blend modes, track mattes, masks (feathering, combining and applying the paths Skia rasterized), adjustment layers, the effect list, and built-in and custom GLSL ES 3.00 shaders are all our own full-screen or bounded passes over layer textures.
  - Intermediate targets are RGBA16F and premultiplied, which avoids the banding of 8-bit chains in blurs and glows. The final output is quantized to RGBA8.
  - Blending runs on sRGB-encoded values, which matches After Effects' default (non-linear) working space. A linear-blending project setting can come later as an additive switch.
- **Workers launch the pinned Chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader`.** On a host with a GPU, Chromium would otherwise use the GPU. The worker reads `UNMASKED_RENDERER_WEBGL` at startup and refuses to render unless it reports SwiftShader.
- **One code path.** The web preview, the workers and the tests run the same CanvasKit and compositor code. Only the GPU under the compositor changes: SwiftShader in workers, the user's GPU in the preview.
- **Pinned and gated upgrades.** Chromium, CanvasKit and the bundled fonts are exact pins. A determinism test with golden hashes runs in CI; it starts with the spike's checks and grows in the M2 "headless capture" item. Bumping any pin regenerates the golden hashes in the same PR, so pixel changes are always deliberate. Rendered outputs and frame caches record the renderer build that made them.

## Consequences

- **Determinism scope, stated precisely.**
  - **Guaranteed:** frames produced in workers (pinned Chromium, SwiftShader, pinned CanvasKit and fonts) are bit-identical.
  - **The preview** is visually equivalent, not bit-identical (ADR-0008), and nothing may rely on it matching the export.
  - **Expected but not relied on:** Skia's half should give the same bytes in any engine, because it is WASM with IEEE floats. So far that is verified only between Node 22 and the pinned Chromium on one host. Re-check it when CI moves to Node 24 (a different V8).
- **Not yet proven.** That results stay identical across CPU families. The spike ran on one x86-64 machine with AVX-512. SwiftShader's JIT, and any WASM SIMD that CanvasKit uses, may generate different code on other CPUs. Until the golden-hash test has run on the worker CPU type, workers stay on one pinned CPU family, and the hashes are checked when the worker hardware changes.
- **Rasterization tests run in Vitest under Node, without a browser,** because CanvasKit runs there and produced the same bytes as Chromium in the spike. Only compositor tests need headless Chromium.
- **CPU cost.** A simple full-frame 1080p scene (two paths and a paragraph, dominated by one full-frame gradient fill) takes about 100 ms to rasterize on one core. Cost scales with covered area. Mitigations:
  - Rasterize only layer bounds within the composition.
  - Cache a layer's raster while its geometry, resolved transform and content are unchanged.
  - Render the preview at reduced resolution while scrubbing.
  - Render frames in parallel across workers. Determinism makes that safe, because a frame never depends on the frames rendered before it, which is exactly what the shared-context path broke.
- **Moving vector layers re-rasterize every frame,** because a sub-pixel transform change invalidates the cache. If profiling shows it matters, the fix is reusing the cached raster for whole-pixel translations. That is an optimization, not a format change.
- **Security: workers run untrusted GLSL.** `--enable-unsafe-swiftshader` is "unsafe" because SwiftShader JIT-compiles WebGL shaders in Chromium's GPU process, and workers will compile agent- and user-authored shaders (ADR-0012) through exactly that path. Treat render workers as untrusted-code hosts:
  - isolate them per job or per tenant;
  - give them no secrets and no network beyond fetching their inputs;
  - make the M6 sandbox ADR cover this path as well as component code.
- **Bundle size.** CanvasKit is about 2.9 MB gzipped. It loads lazily in the editor; MCP clients render server-side and never download it. A trimmed custom CanvasKit build is an option if size becomes a problem.
- **New runtime dependency:** `canvaskit-wasm` (BSD-3-Clause), added to `@kynimo/renderer` when the "Draw shapes" item creates that package.
- **Rejected:**
  - Skia GPU on a shared context: corrupt output, coupling to internals.
  - Skia GPU on a separate context copied across: anti-aliasing would depend on the GPU in the preview, it adds a copy per layer, and it gains nothing on SwiftShader workers, where everything runs on the CPU anyway.
  - A fully in-house path and text renderer: weeks of work and correctness risk.
  - PixiJS or three.js: they bring their own scene graph and blend/mask model, which don't map to After Effects semantics, and they give us less control over determinism.
  - Canvas 2D: already ruled out by ADR-0013.
- **WebGPU** stays a later option (ADR-0004). It would replace only the compositor half.
