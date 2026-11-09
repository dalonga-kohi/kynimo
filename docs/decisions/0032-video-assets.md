# 0032 — Video assets, video layers and media uploads

- Status: accepted (implements ADR-0013's pre-decoded video; extends ADR-0031)
- Date: 2026-11-09

## Context

ADR-0013 puts video layers in the beta: decoding with `<video>` in Chromium isn't frame-accurate, so footage is normalized to a constant frame rate and decoded to frames with FFmpeg at upload, and the renderer draws those frames. A clip's sound becomes its own audio asset. ADR-0031 shipped image and font uploads and left audio uploads to this item. FFmpeg parses untrusted input, so how it is run is part of the decision.

## Decision

- **Format v4.** Both additions are new variants, so the 3 → 4 step changes nothing. The reference scenes move to v4 with unchanged pixels.
  - **Video asset:** `width`, `height`, `fps` (exact rational) and `frameCount`. Its `uri` and `sha256` pin a JSON **frame manifest** (`kynimo-video-frames` v1). The manifest lists every frame's SHA-256, the size, the rate and the decoder version. The document stays small (a minute of 60 fps footage is 3600 hashes) and every frame is still pinned.
  - **Video layer:** a drawn layer with `assetId`.
- **Time mapping.** Source frame = ⌊layer frame × source fps ÷ composition fps⌋, in exact integer math (the same mapping as precomps). Outside `[0, frameCount)` the layer draws nothing. Playback rate, looping and time remapping come later and are additive.
- **Rendering.**
  - **Engine:** resolves a video layer to `{ assetId, sourceFrame | null }`.
  - **Renderer:** decodes supplied frames into a `VideoFrameLibrary`, checking each against the asset's size, and draws them exactly like image layers.
  - **Capture:** serves frames from memory under `<assetId>/<frame>`, which can't collide with asset ids.
  - **MCP service:** evaluates the requested frames, collects exactly the source frames they show (precomps and matte sources included), and checks each against the manifest. Frames count toward `RENDER_LIMITS.maxAssetBytes`.
  - Nothing in the render path decodes video or touches the network.
- **FFmpeg is the system binary.** It is `ffmpeg`/`ffprobe` on PATH, or `KYNIMO_FFMPEG` / `KYNIMO_FFPROBE`, and its version is recorded in each manifest. Without it, video and audio uploads answer `unavailable` with the reason. Determinism doesn't depend on the version, because frames are decoded once and stored. Deploy images pin it. CI installs it.
- **Running FFmpeg on untrusted files.**
  - The service only hands FFmpeg files whose signature is a media container: ISO BMFF, Matroska/WebM, WAV, MP3, FLAC or Ogg.
  - FFmpeg reads a temp copy with `-protocol_whitelist file` and a container whitelist. HLS playlists, concat lists and network protocols are therefore refused; both tricks are checked against FFmpeg 6.1.
  - It runs through `execFile` (no shell), with `-nostdin`, a 120 s timeout and SIGKILL. The temp directory is removed afterwards. The source file itself isn't stored.
- **Decoding.**
  - **Video:** the first non-cover-art video stream becomes constant-rate JPEG frames (`-q:v 2`) at the source rate, capped at 60 fps, scaled to fit 1920 px on the longest edge (even sizes). Rotation metadata is applied, and the stored size is the displayed size. Clips may be at most 60 s, and decoded frames at most 1 GB per upload.
  - **Audio:** the first audio stream becomes 48 kHz stereo FLAC, and audio-only files take the same path. A video's sound is returned as `audio_asset`, for an audio layer.
  - Encoding is single-threaded and bit-exact, so the same file decodes to the same frames on one build.
- **Retries fingerprint the source.** `upload_asset` fingerprints the uploaded bytes' hash and its own fields, not the derived entries, because scaling may differ in the last bit across CPUs. A request whose key was already used replays the stored outcome without decoding, and the asset entries come from that version's document. This applies to every upload type.
- **Limits stay as ADR-0031 set them:** 8 MB of base64 per call. Longer or larger clips wait for presigned uploads with the remote transport.

## Consequences

- Agents can bring screen recordings and footage, place a clip's sound, and check frames like any other layer. An uploaded clip renders bit-identically to an image of its decoded frame, tested in Chromium.
- JPEG frames are about ten times smaller than PNG but slightly lossy on fine UI text. A lossless option can be added per asset later.
- Storage grows with every frame (a 60 s 1080p clip is a few hundred MB). Garbage collection (ADR-0031) matters more now.
- The tool listing is at 58.1 KB of 60 KB, and `apply_ops` is at its 13 KB cap. The next tool or op has to free room first (ADR-0030).
- Frames decoded by a different FFmpeg build can differ, but a stored asset never changes. Re-uploading the same file on a newer build gives a new asset, not changed pixels in old documents.
