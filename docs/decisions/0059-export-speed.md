# 0059 — Export speed: layer bounds, bottom-layer reuse and an optional host GPU

- Status: accepted
- Date: 2026-11-13
- Amends: ADR-0016 (SwiftShader only), ADR-0048 (rendering fast path and its follow-ups)

## Context

Exports must be fast on the cheapest server that can run them. A per-stage benchmark of whole reference scenes (`packages/capture/bench/export.mjs`) showed where a frame's time went after ADR-0048:

- **The compositor on SwiftShader was 80 to 95 % of every frame.** Each layer cost three passes (prepare, place, blend) and two of them covered the whole composition, whatever the layer's size. On SwiftShader even a pass that only copies costs about 9 ms per megapixel of RGBA16F.
- **Moving the pixels to the host was second**: about 130 ms for one 1080p frame, almost all of it the protocol message, not the base64.
- Rasterization and evaluation were small.

ADR-0048 listed scissoring, fixed-function blending and a static-prefix cache as follow-ups that "change output bytes". Measured, they do not have to: each is done here so that the bytes stay the same, and every golden passes unchanged.

## Decision

### Compositor (`packages/renderer/src/compositor`), byte-identical

- **A placed layer is a region.** The placement pass renders into a target the size of the rectangle the layer can reach (its source rectangle, grown by the reach of bilinear sampling at its deepest mip level, mapped by its placement, plus a pixel of slack), not the size of the composition. Sizes are rounded up to 32 px so animated layers keep reusing pooled targets. A 3D layer keeps the whole frame. The shaders take the region's origin as a uniform, so each pixel runs the arithmetic it ran before. A matte is a region too; outside it the matte is transparent, as it was.
- **Blending is in place.** The accumulated frame is one target for the whole composition. Normal mode is fixed-function blending (`ONE, ONE_MINUS_SRC_ALPHA`) of a copy pass over the region; any other mode blends into a spare target of the region's size and copies that back, because a pass cannot read the target it writes. A transition still needs both frames and copies the accumulated one first.
- **A plain layer is one pass.** A layer with no effects, deform, matte, motion blur or 3D, placed by a whole-pixel offset under the normal blend mode, is drawn straight onto the accumulated frame: source texel times mask times opacity, blended. The three-pass path stored two of those products in RGBA16F targets, so the shader rounds them to half floats itself (`packHalf2x16` / `unpackHalf2x16`) and the result is the same bits.
- **Bottom layers that did not change are kept** (`CompositePrefix`). The caller may ask the compositor to keep the frame composited from the root plan's bottom N layers, and later pass a plan holding only the layers above them. One result is held; a call that does not use it drops it, as does a failed frame.

### Export page (`packages/capture`)

- **Per-layer keys.** The repeat check of ADR-0048 serialised the evaluated frame as one string. It is now one string per layer plus one for the rest of the frame. An evaluated layer carries its matte chain and nested composition, so two layers with equal keys draw equal pixels for the same reason two frames with equal keys did.
- **Reuse.** The bottom run of layers whose keys equal the previous frame's is composited once and kept; the following frames neither rasterize nor composite those layers while they still match. Their skipped-layer and warning reports are kept with them. The kept frame is rebuilt when a longer run becomes stable.
- **Frames cross in slices.** The page keeps the frame and the host reads it as 192 KiB slices requested together. Same bytes, about half the time. A loopback HTTP or WebSocket channel was measured and was no faster (117 ms and worse), and would have opened the page to a network endpoint.
- **Stage timings.** `ExportSession.timings()` reports milliseconds per stage. It reads the wall clock in the page, only to report; nothing in evaluation or rendering sees it.

### Optional host GPU

- `launchCapture({ gpu: "hardware" })`, set for the server with `KYNIMO_GPU=hardware` (flags overridable with `KYNIMO_GPU_ARGS`), draws on the host's GPU through ANGLE instead of SwiftShader. The session refuses to start if WebGL2 then reports a software renderer.
- **SwiftShader stays the default and the only backend the guarantees are stated on**: goldens, "same document and frame, same bytes on any host", and shader validation. On a GPU the output is visually equivalent, not identical: on an RTX 2060 (Direct3D 11) every sampled frame of five reference scenes was within 2/255 per channel of SwiftShader's, almost all within 1/255.
- Caches stay sound: the build id every cache key holds already includes the GPU string.

### Numbers

Milliseconds per frame, whole scene, capture only (no encode), 12-thread desktop:

| Scene                       | Before | After, SwiftShader | After, RTX 2060 |
| --------------------------- | ------ | ------------------ | --------------- |
| title-card 640x360          | 73     | 36                 | 27              |
| product-card 640x360        | 68     | 25                 | 21              |
| shader-backgrounds 1280x720 | 419    | 369                | 60              |
| components 1920x1080        | 806    | 537                | 125             |
| motion-blur 1280x720        | 1490   | 163                | 50              |

What is left on SwiftShader is per-pixel shader work over the whole frame (noise at 720p is about 120 ms a frame on its own): only a GPU removes that. On a GPU the largest remaining stage is moving the pixels (about 65 ms at 1080p).

## Alternatives considered

- **Draw the placement straight into the accumulated frame for every layer.** One pass fewer for transformed layers, but the blend would then see values that were never rounded to half floats, so some bytes change. Left for a change that re-approves goldens.
- **Skip the RGBA8 to RGBA16F prepare pass for transformed layers.** Same reason.
- **A direct pixel channel (loopback HTTP, WebSocket, protocol blob streams).** Measured: no better than slices, and the first two weaken the page's isolation.
- **Parallel browsers or range rendering on one host.** Still not worth it on SwiftShader, which already uses the cores (ADR-0048 measured 1.16x with two). It becomes interesting on a GPU host, where the GPU is idle most of a frame.

## Consequences

- Exports of typical scenes (small animated layers over a still background) are two to nine times faster on the same CPU-only host, with unchanged bytes.
- The compositor has more paths: the one-pass path, the region path and the reuse path must stay byte-identical to each other. The capture goldens and the export-equals-capture tests pin that; `webgl.test.ts` pins save and reuse against a plain frame.
- A frame that reuses kept layers charges less of the per-frame raster and effect budgets than the same frame drawn whole. The first frame of every kept run is drawn whole, so a document over budget still fails.
- The compositor holds one more composition-sized RGBA16F target while an export reuses bottom layers (about 16 MB at 1080p).
- Running on a GPU is a deploy decision: per frame it is 4 to 6 times faster on shader-heavy 720p to 1080p scenes, per hour the host costs more, and output is no longer byte-reproducible across hosts. The Linux launch flags are ANGLE's defaults and have not been run on a Linux GPU host yet.
- Follow-ups:
  - Cache layer rasters by layer key, so a still layer above a moving one is not rasterized again.
  - Hand the encoder YUV 4:2:0 from the page (1.5 bytes per pixel instead of 4) for opaque formats; this changes the encoded bytes.
  - Parallel range rendering on GPU hosts.
  - Measure the encoder's share with the worker's FFmpeg and core count; x264 `medium` competes with SwiftShader for the same cores.
