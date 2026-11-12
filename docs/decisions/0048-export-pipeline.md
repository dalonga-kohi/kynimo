# 0048 — Export pipeline: jobs, MP4/WebM/GIF, delivery, fast capture path

- Status: accepted
- Date: 2026-11-12

## Context

M7 needs an agent to turn a document into a finished video: `export` (MP4, WebM, GIF), a cheap `render_preview_clip`, and a way to poll and cancel (ADR-0018 asked for cancellable jobs with progress, idempotent submits and fidelity reports). The renderer so far returned PNG frames one capture call at a time; at 1080p a frame cost far too much to export a 10-second clip within a tool-call's patience (components 1080p was about 4.3 s per frame in the compositor alone). We also have no worker fleet yet (it comes with deploy), so the first version runs in the MCP server process and must say so honestly.

## Decision

### Jobs

- **In-process `JobQueue`** (`apps/mcp/src/jobs.ts`), FIFO. Limits (`JOB_LIMITS`): **concurrency 1** (one capture session at a time), **4 queued + running per account**, **32 server-wide**, finished records kept **24 h** and at most **100 per account** (oldest finished dropped first).
- **States:** `queued`, `running`, `succeeded`, `failed`, `cancelled`. **Phases:** `queued`, `rendering`, `encoding`, `storing`, `done`. Progress is `frames_done` / `frames_total`, updated per frame while `rendering`.
- **Cancel.** A queued job leaves the queue and is `cancelled` at once. A running job has its `AbortSignal` aborted: the render loop checks it before every frame, the encoder is killed, and the job ends `cancelled` even if the body then threw. A finished job is returned unchanged (`cancelled: false`). `close()` (server shutdown) cancels queued jobs, aborts running ones and waits for them.
- **Idempotency.** `export` takes an `idempotency_key`, scoped to (account, actor, project) and kept with the job record, so it lives as long as the job (24 h). The same key with the same request returns the original job (`replayed: true`); with a different request it fails with `key_reused`. The request fingerprint covers tool, project, composition, format, frame range and `max_size` but **not the document version**: a retry after an edit returns the original job instead of silently exporting something new. `render_preview_clip` takes no key.
- **Scoping.** Jobs are looked up by actor, which equals the account on every current transport (OAuth subject over HTTP, the local account otherwise). Another account's job id answers `not_found`.
- **Restart.** A restart loses queued and running jobs and every download link. The Postgres-backed queue and `apps/worker` come with deploy; the in-process queue keeps the same `JobQueue` surface so the swap does not change the tools.
- Over a limit the submit fails with the new tool error kind **`busy`** (account at 4, or server at 32), naming the limit.

### Tools

- **`export`**: `format` `mp4` (default), `webm` or `gif`; `composition`, `from_frame`, `to_frame` (default: whole composition), `max_size` (longest edge, never upscaled). Limits (`EXPORT_LIMITS`): mp4/webm **at most 1920 px and 60 s**, minimum 32 px, default the composition's size capped at 1920; gif **default 480, at most 960 px, at most 15 s**. Returns a job reply at once.
- **`render_preview_clip`**: always mp4, **at most 480 px (default 360), at most 10 s**. When done, the job status also carries a **contact sheet** (PNG, **6 cells at 160 px**, 3 columns) as image content, never in structured output. A one-frame clip has no sheet.
- **`get_export_status`**: `job_id` plus `wait_seconds` **0 to 25** (default 0): waits up to that long for the job to finish, so 10-20 saves polling calls.
- **`cancel_export`**: as above; `cancelled` says whether it stopped anything.
- **Validation before queueing.** Composition exists, frames in range, `from_frame <= to_frame`, duration limit as exact integers (`(frames * den) <= seconds * num`), size limit for that kind and format. Failures are tool errors with the value that fits (for example a `to_frame` that fits the duration), never failed jobs. The project version is captured at submit time; the job renders that version.
- **Result** (`result` on a succeeded job): `format`, `composition`, `version`, `from_frame`, `to_frame`, `frames`, `width`, `height`, `fps`, `duration_seconds`, `bytes`, `content_type`, `url` (HTTP) and/or `path` (stdio), `expires_at`, `audio_layers`, `cached`, `repeated_frames`, `render_seconds`, `fidelity`, `skipped`, `warnings`. A failed job has `error: { code, message }` where `code` is the tool error kind, `encode_failed` (FFmpeg) or `render_failed`.
- **Fidelity entries** (`kind` is `dropped`, `flattened` or `approximated`; sorted by kind then feature; at most 5 layer ids each):
  - `transparency` (flattened): mp4 and gif when the composition background is null or not opaque; composited over black.
  - `audio` (dropped): gif with audio layers playing in the range.
  - `nested-audio` (dropped): audio layers inside precomps reachable from the composition (not mixed yet).
  - `audio-clipping` (approximated): the mix went over full scale; the entry counts the clipped sample values.
  - `even-size` (approximated): mp4 whose width or height is odd, padded by 1 px of black.
  - `gif-palette` (approximated): always for gif, 256 colors with dithering.
  - `gif-timing` (approximated): gif when `100 * den / num` is not an integer (delays are whole hundredths).
- **Skipped layers and warnings** come from the renderer's per-frame reports and are merged into **frame ranges** (`{from, to}`), at most 20 per entry with `more_ranges` counting the rest, instead of one entry per frame.
- **Content cache.** Finished results are cached (at most 256) by a fingerprint of: tool kind, project id, document hash, composition, format, range, output size, the renderer build id and the FFmpeg version. A hit whose file is still downloadable returns the result at once with `cached: true`; a stale hit is dropped. The document hash is part of the key, so the same export of the same content is not rendered again.

### Delivery

- Finished files live on local disk: `<dir>/exports` with `--dir`, otherwise a temp directory made at start (`kynimo-exports-*`). **24 h TTL**, **4 GiB total cap** (oldest saves are removed first), names are the job id. Files left by an earlier process are deleted once older than the TTL but have no token.
- Each file is behind a **43-character base64url capability token** (32 random bytes). Over HTTP, the result carries `url` = `<origin>/exports/<token>` (the public origin with OAuth, otherwise the bound address). `GET` and `HEAD /exports/<token>` are **unauthenticated by design**: the unguessable token is the capability, like a signed URL, and it expires with the file. Headers: `content-type` by format, `content-length`, `content-disposition: attachment; filename="kynimo-<job>.<ext>"`, `cache-control: private, max-age=3600`, `x-content-type-options: nosniff`. Other methods answer 405; an unknown, malformed or expired token answers 404. Range requests are not supported yet.
- Over stdio, the result carries the file's absolute `path` instead (one local user); no link is built.
- R2 with presigned URLs replaces the local directory with deploy (ADR-0031 storage, same result shape).

### Rendering fast path

Measured on a shared 4-vCPU box with SwiftShader.

- **Capture export session** (`ExportSession`, `openExport` in `@kynimo/capture`): one page per export, in the same browser as other captures but not waiting on them. The document, fonts and images are loaded once; video frames are passed per frame and released from the page when the next frame no longer names them. Each call returns **raw RGBA, one frame per call**, read in the page with the native `Uint8Array.toBase64`. **Premultiplied** frames are exactly the pixels `captureFrames` produces (tested by hash); **straight** alpha (CanvasKit's un-premultiplying read) is used for webm only.
- **Repeated-frame skipping.** The evaluated frame is serialised with only its root `frame` index zeroed and every numeric `layerFrame` reduced to `>= 0` (the renderer reads it only that way); when the result equals the previous frame's, nothing is drawn and the same buffer is returned (`repeated: true`; counted in `repeated_frames`). Nothing else is dropped: a resolved effect's own `frame` (animated grain) and nested precomp `frame` values stay in the key, which can only miss a dedupe, never repeat wrong pixels. Sound because the evaluated frame already holds everything that decides the pixels (effects, grain, generators and video source frames are resolved into it).
- **Compositor specialisation** (`packages/renderer/src/compositor`): programs are compiled lazily per variant (blend mode and adjustment, effect type, generator type, placement/matte) so a draw runs no runtime switch; render targets are pooled by size and format and recycled (a target idle for two frames is deleted, and idle targets are capped at 64 MiB: past it the least recently released goes, even mid-frame; 60 layers of distinct 1280x720 raster sizes peaked at about 445 MB before and about 85 MB after); the placement shader copies one texel only when the placement is an exact integer translation at level 0. Output is byte-identical: the existing goldens pass unchanged.
- **Numbers (ms per frame, before to after).** Title-card about 530 to about 120; product-card about 865 to about 127; components at 1080p (compositor only) about 4300 to about 1200. The GPU breakdown of one frame's blend work went from 2331 ms to 163 ms. End to end, components at 1080p, 30-frame mp4: **about 793 ms per frame including encode**.

### Encoding

- FFmpeg (no shell, no user text in arguments) reads **`rawvideo`** from stdin: `rgb0` for mp4 and gif (premultiplied pixels with alpha ignored are exactly "over black") and `rgba` straight for webm that keeps alpha. Audio, when present, comes from a raw `f32le` 48 kHz stereo file.
- **mp4:** filter `pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:black,format=yuv420p`; `-c:v libx264 -preset medium -crf 18 -profile:v high -movflags +faststart`; audio `-c:a aac -b:a 192k`.
- **webm:** `format=yuv420p` (or `yuva420p` with alpha); `-c:v libvpx-vp9 -crf 30 -b:v 0 -row-mt 1 -tile-columns 2 -threads 4 -deadline good -cpu-used 2` (plus `-auto-alt-ref 0` with alpha); audio `-c:a libopus -b:a 128k`.
- **gif:** two passes so memory stays bounded. Pass 1 writes `palettegen=stats_mode=diff` and a lossless **ffv1** copy of the frames into a temp directory next to the output; pass 2 maps the copy through the palette with `paletteuse=dither=sierra2_4a`, `-loop 0`. The single-graph `split` form would buffer every frame in FFmpeg.
- **Timeouts.** Stall timeout **120 s** (no write drained and no encoder output while frames are written); finish timeout **max(120 s, 200 ms x frames)** from the last frame until FFmpeg exits. Either kills FFmpeg and fails the job with `encode_failed`. The abort signal kills the encoder too; the temp directory is always removed.

### Audio

- Audio layers of the exported composition are **mixed in TypeScript** (`audio-mix.ts`), not by an FFmpeg filter graph: the result is deterministic and testable without FFmpeg, and animated volume is sampled from the document's own keyframe evaluation.
- Frame `f` starts at sample `floor(f * 48000 * den / num)` (exact integers, negative frames too); a layer is placed at its `startFrame`, gated by its in/out frames and by hidden/solo as the evaluator does. Volume is sampled per frame and **ramps linearly across the frame** toward the next frame's value while the layer stays active. The sum is **clamped to [-1, 1]** and the number of clamped sample values is reported (`audio-clipping`).
- Sources are decoded to 48 kHz stereo float with FFmpeg (bounded length) and the mix is written as one raw file of exactly the video's length. Audio layers inside precomps are **reported, not mixed** (`nested-audio`).

## Alternatives considered

- **Postgres-backed queue now.** Needs workers to drain it; with one process it would add a database round trip and no durability anyone could use. Deferred to deploy.
- **MCP resource delivery of the file.** Clients handle large binary resources poorly and base64 in a tool result would blow the context; a link or local path works everywhere.
- **Inline animated GIF preview.** Large, and many clients show only the first frame; a short mp4 plus a 6-cell contact sheet is smaller and shows more.
- **PNG frames over `image2pipe`.** PNG encode in the page and decode in FFmpeg cost more than moving raw RGBA, which also keeps the premultiplied pixels exact.
- **Parallel browsers.** Measured 1.16x with 2 and 1.24x with 4 on 4 vCPU (SwiftShader and FFmpeg already use the cores); not worth the memory here.
- **x264 `-tune animation`.** Slower and larger on our content.
- **FFmpeg `amix` filter graph for audio.** No sample-exact placement by rational frames, no animated volume from our keyframes, and hard to test.
- **Native lower-resolution rendering.** Changes pixels (text hinting, effect radii) and breaks "same frame, same pixels" between preview and export; frames are rendered at the composition's size and downscaled.

## Consequences

- An agent can build, preview and export a finished MP4, WebM or GIF, with a fidelity report and frame-range reports, over stdio and HTTP. Exports need FFmpeg and the pinned Chromium.
- Restart loses jobs and links; one export runs at a time per server. Both are lifted by deploy (durable queue, workers, R2).
- The tool listing budget in `server.test.ts` rises from 78 KB to **89 KB** (77.4 KB before the export tools, 88.3 KB after) and the capability manifest cap from 9 KB to **10 KB**; both are part of the M8 compaction item.
- Follow-ups:
  - Pixel-changing compositor speedups (scissor to layer bounds, fixed-function normal blend, a static-prefix cache) change output bytes and need their own ADR and golden review.
  - Parallel range rendering on bigger hosts (stitching ranges), once workers exist.
  - HTTP range requests on `/exports/<token>`.
  - Audio inside precomps.
  - Clean up the temp exports directory on exit when `--dir` is not set.
  - Texture upload pooling; asynchronous read-back (`fenceSync`) instead of a blocking read.
  - Pooled render targets rely on a stale-sampler behaviour that holds on SwiftShader; re-check on real GPUs.
