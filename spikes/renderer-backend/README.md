# Spike: drawing-backend determinism (ADR-0016)

Evidence for [ADR-0016](../../docs/decisions/0016-drawing-backend.md). It checks that WebGL2 on SwiftShader in pinned headless Chromium, and CanvasKit's CPU raster, produce identical bytes across fresh browser launches and between Node and Chromium. It also records why Skia's GPU backend can't share our WebGL2 context.

This directory is a standalone package, outside the pnpm workspace. It is not built, tested or shipped with the product.

## Run

```bash
pnpm install --ignore-workspace
```

```bash
pnpm spike
```

Pass a launch count to run more launches: `node run.mjs 5`. The script exits non-zero if any `PASS` check fails. The shared-context result is printed as `INFO`, because it is the rejected path.

Playwright 1.63.0 is pinned and needs its matching Chromium (153.0.8010.12). If it isn't installed, run `pnpm exec playwright install chromium`.

## What it does

| #   | Experiment                                                          | Expectation                          |
| --- | ------------------------------------------------------------------- | ------------------------------------ |
| 0   | Sanity: text laid out and inked, frame not uniform                  | Guards against "identical but blank" |
| 1   | GLSL pass into RGBA8; two-pass RGBA16F chain (linear sampling)      | Same hash every launch               |
| 2   | Skia CPU raster of `scene.js` → texture → WebGL2 multiply blend     | Same hash every launch, and in Node  |
| 2b  | PNG + JPEG decoded by CanvasKit's codecs                            | Same hash every launch, and in Node  |
| 3   | Skia GPU backend on our WebGL2 context, raw GL pass between redraws | Frames after the first are corrupted |
| 4   | Skia GPU backend alone, redrawn                                     | Stable (control for 3)               |

The PNG and JPEG test images are generated and encoded in Node with CanvasKit's `full` build, because the default build has no JPEG encoder. They are decoded with the default build.

`scene.js` covers what M2 needs from Skia: even-odd fills, gradients, rounded rects, dashed strokes with round joins and caps, and DejaVu Sans text with a ligature, accents, a symbol, tracking and line wrapping.

## Result (2026-11-06, Linux x86-64 with AVX-512, 4 cores)

```text
Chromium 153.0.8010.12 | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)
float render targets: true | MSAA samples: 4
launches: 3 | frame: 1920x1080

PASS  WebGL2 runs on SwiftShader
PASS  Scene is not blank (text line 1291 px, 18323 inked text-area px)
PASS  GLSL shader pass identical across launches
PASS  RGBA16F two-pass chain identical across launches
PASS  Skia CPU raster identical across launches
PASS  Skia CPU raster identical in Node and Chromium
PASS  CPU raster -> WebGL2 composite identical across launches
PASS  PNG + JPEG decode identical across launches
PASS  PNG + JPEG decode identical in Node and Chromium
PASS  Experiment 3 really shares our WebGL2 context
PASS  Skia GPU alone: redraws identical

INFO  Skia GPU on shared context, redraw-stable after a raw GL pass: false (MAE vs CPU raster per frame: 0.066, 53.281, 53.281)
INFO  timings (ms, first launch): CPU raster 119, upload+composite+readback (incl. shader compile) 60; shared-context frames 247, 100, 85
INFO  hashes: shader 8466a851bcc6d9c7, half-float 00ff1a6ae80332b3, cpu raster eb20085e2e5724e3, composite 806e50bf1c5b64fb, png 397dcfb923a7828b, jpeg 2b2e48c7fdd71645
```

Hashes are expected to change across CPU families, Chromium, CanvasKit or font versions. That is what the golden-hash test in M2 guards.
