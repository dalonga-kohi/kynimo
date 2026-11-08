# 0026 — Render tools: sizes, contact sheets and the render cache

- Status: accepted (implements ADR-0018's bounded renders and skip reporting for `render_frames` and `render_contact_sheet`; amends ADR-0025's listing budget)
- Date: 2026-11-08

## Context

Agents need to see their work (CAPABILITIES.md, principle 6). Capture (ADR-0022) turns a document and frames into PNGs at composition size, but a 1920×1080 image costs a model many tokens, and checking an animation frame by frame costs many calls. ADR-0018 requires declared limits, a cache keyed on everything that decides the pixels, and that every result lists what it skipped.

## Decision

- **Size is a longest-edge cap, applied after compositing.** `@kynimo/capture` takes `maxSize`. The frame is composited at full size, then downscaled in the page on the CPU with the pinned CanvasKit (linear filtering between mipmap levels, so large reductions do not alias). It keeps the aspect ratio (`fitSize`) and never upscales. Hashes are of the output pixels, and a downscaled golden in `determinism.json` pins the resampler with the rest. Rendering natively at a smaller scale would be faster and sharper but changes the frame-plan contract; it can come later behind the same option.
- **Contact sheets are tiled in the page.** `captureSheet` downscales each frame, then copies it at whole-pixel offsets onto a transparent sheet, row-major, with no resampling. Each cell is byte-identical to the single-frame render at that size (tested). Cells carry no labels; the result lists the cells' frames in order.
- **`buildId`** hashes the page bundle, CanvasKit's wasm, the bundled fonts, the Chromium version and the GPU string. It is the "renderer build" part of every cache key.
- **Tools.**
  - `render_frames`: 1 to 16 frames, `max_size` 32 to 1920 (default 960).
  - `render_contact_sheet`: explicit `frames`, or `count` frames spread evenly over `from_frame`..`to_frame` (default the whole composition); 2 to 36 cells, up to 8 columns (default about square), `cell_size` 32 to 640 (default 320), 4 px gaps, at most 2048 px per side. A sheet over that is refused, naming the largest `cell_size` that fits.
  - Limits are declared in the input schemas with messages that say what fits. Frames are checked against the composition, with pathed errors naming the valid range. Nothing is silently downscaled past what the caller asked or cropped.
  - Results carry the PNGs as MCP image content and a structured result: per frame (or sheet) the size, `pixels_sha256`, `png_sha256` and `cached`, plus `skipped` and `warnings`, each listed once with the frames it applies to, nested precomps included.
  - Renderer failures (for example an image asset without bytes, until the asset store lands) are `render_failed` tool errors; a server without a renderer answers `unavailable`.
- **Renderer.** The server holds one capture session, launched on the first render so a server that never renders never starts Chromium, and replaced on the next call after the browser is gone or a launch failed.
- **Cache.** In memory, least recently used, bounded at 256 MB of PNGs. Frames are cached one by one, so a request renders only its misses; sheets are cached whole. Keys are project id + SHA-256 of the canonical document + composition + frame(s) + size and layout + `buildId`. Definition hashes (ADR-0012) join the key when definitions exist; today the document holds everything. A `FrameRenderer` interface keeps the service testable and lets workers (M7) replace capture in-process.
- **Listing budget raised to 60 KB.** The two tools take the listing from ~48 KB to ~54 KB, mostly output schemas. We keep exact outputs; the structural fix (shared definitions served as resources, looser selectors) belongs to the MCP resources item.

## Consequences

- An agent can check a whole animation in one call and zoom in on details with a second, at a size it chooses.
- The cache does not survive a restart and is not shared between processes. The database and worker items replace it with a shared, content-addressed store; the key stays.
- Render calls are not metered yet. `cached` per frame is what metering will count.
- Asset bytes are not loaded yet, so documents with image or uploaded font assets fail with `render_failed` until `upload_asset` lands.
- Downscaling after compositing costs a full-size composite per frame. Fine for previews; workers may render natively at scale.
- `describe_motion` completes the roadmap item in its own PR.
