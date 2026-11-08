# 0022 — Headless capture: the whole pipeline in the pinned Chromium

- Status: accepted (completes ADR-0016's determinism test; the capture path that render workers and `render_frames` build on)
- Date: 2026-11-08

## Context

ADR-0016 guarantees bit-identical frames only for the pinned Chromium on SwiftShader with pinned CanvasKit and fonts. Node producing the same raster bytes is expected but not relied on. Until now nothing turned a document into an image file: the rasterizer ran in Node tests and the compositor was tested in a browser through a JSON bridge of frame plans. This item adds "document + frame → PNG" and the determinism test with golden hashes that ADR-0016 called for. Render workers (M7) and `render_frames` (M3) build on it.

## Decision

- **A new Node-only package, `@kynimo/capture`.** It needs Playwright at runtime, so it stays out of `@kynimo/renderer`, which the web preview imports and which stays browser-safe. The package map in ARCHITECTURE.md is updated.
- **The whole pipeline runs in the page, on the guaranteed path.**
  - The page does `evaluateFrame` → `rasterizeFrame` (CanvasKit) → the WebGL2 compositor → CanvasKit's PNG encoder, then a SHA-256 of the composited pixels.
  - Only the validated document, asset bytes and the result cross the process boundary. Frame plans, which are large, never cross it.
  - Vite bundles the page into `dist/page/capture.js` at build time. Tests bundle it from source instead, so they never run a stale build.
- **No network from the page.**
  - The page lives at `https://capture.kynimo.invalid`. The host answers every request to that origin from memory: the page, CanvasKit's wasm, the bundled fonts, and the asset bytes of the call in progress. It aborts HTTP(S) requests to any other origin, closes every WebSocket and blocks service workers. A test checks this from inside the page.
  - WebRTC is not routed. Today only our own code runs in the page; before agent-authored components or shaders run there (ADR-0012), the M6 sandbox ADR must close that path too.
  - `.invalid` never resolves. Https makes the page a secure context, which Web Crypto needs.
  - The caller passes asset bytes by asset id. Capture never fetches, and the renderer still checks every file against its pin.
- **Launch.**
  - The host launches Chromium with ADR-0016's flags.
  - It refuses to run unless `UNMASKED_RENDERER_WEBGL` reports SwiftShader.
  - It exposes the Chromium version and the GPU string, so outputs can record the build that made them.
- **API.**
  - `launchCapture()` returns a session.
  - `session.captureFrames(document, frames, { composition, assets })` first migrates and validates the document (`migrateProject`).
  - It returns, per frame: the PNG, `pixelsSha256`, `pngSha256`, the skipped layers and the warnings of the frame and every nested precomp.
  - Calls on one session run one at a time, so each call sees only its own asset bytes.
  - One call renders at most `MAX_FRAMES_PER_CALL` (64) frames, because all of its PNGs come back in one response. Callers (`render_frames`, workers) split longer ranges into several calls (ADR-0018).
  - Errors are a `CaptureError`. When the error came from the page, its `pageError` keeps the original name: `RenderError`, `ImageAssetError`, `RangeError` and so on. A failed launch, a crashed page and a call after `close()` are `CaptureError`s too. A session whose browser disconnected stays closed.
- **What the invariant is stated on.**
  - `pixelsSha256` hashes the composited premultiplied sRGB RGBA8 bytes. This is the determinism invariant itself.
  - `pngSha256` hashes the file, which straight alpha encodes losslessly only where pixels are opaque or fully transparent. It is pinned too, by CanvasKit's encoder.
  - Both are golden. When they drift, the pixel hash tells you whether the frame changed or only the encoding did.
- **The determinism test.**
  - The test uses one scene: gradients, a dashed stroke, text with a fallback glyph, an image, an animated feathered mask, a luma matte from a hidden layer, screen and overlay blending, and a rotated, scaled precomp holding an image parented to an animated null.
  - It renders three frames and compares them with `packages/capture/golden/determinism.json`, which records the Chromium version.
  - It also checks that the bytes are the same in reverse order and after a fresh browser launch, that the frames differ from each other, and that each PNG decodes back to exactly the hashed pixels.
  - On a mismatch it writes the frames to `renders/capture/` (gitignored), so a person can look at what changed.
  - `KYNIMO_UPDATE_GOLDEN=1` regenerates the golden file. Bumping a pin does that in the same PR (ADR-0016).

## Consequences

- Frames used for checks, previews over MCP and exports all come from one path, so "what the agent checked is what gets exported" holds by construction.
- Each call re-decodes images and re-loads fonts, and each frame re-uploads its rasters. Caching decoded assets per session, keyed by hash, is an optimization for when workers land (M7).
- Asset bytes and PNGs cross Playwright's channel as base64, about a third larger than raw. That is fine for previews; exports at scale may want a binary channel, and M7 revisits it.
- **The golden hashes so far have been produced on one x86-64 host.** Whether CI's runners match is the first test of ADR-0016's CPU-family caveat. If they differ, workers and CI must be pinned to one CPU family, and the golden file records which one.
- Reference scenes with approved PNGs (ADR-0018) reuse this session and test layout (ADR-0023).
- The launch flags now exist twice: privately in capture and in the renderer's compositor test helper. The renderer cannot depend on capture, so the duplicate stays until the worker app owns the launch.
- `page.evaluate` has no timeout yet. The pixel budget bounds a frame's memory, but not its time. Job timeouts and cancellation arrive with the workers (M7).
