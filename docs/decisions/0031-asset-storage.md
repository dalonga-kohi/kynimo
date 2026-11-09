# 0031 — Asset storage and upload

- Status: accepted (implements ADR-0003's object storage for assets; ADR-0018's retry-safe `upload_asset`)
- Date: 2026-11-09

## Context

The format has image, font and audio assets since M2: an entry with a store-relative `uri` and a `sha256` pin, which the renderer checks before drawing. Nothing could add one: there was no op, no place for the bytes, and render tools never passed asset bytes to capture. Remote clients need the server to hold the bytes (ADR-0003), and a retried upload must not apply twice (ADR-0018).

## Decision

- **Assets are scene operations.** `addAsset` appends an entry, `removeAsset` deletes one, with `asset.insert` / `asset.remove` change records, so an upload is undoable like any edit. `removeAsset` refuses while an image or audio layer names the asset, or while text uses the last font file of its family, and names those layers. Write results gain optional `assets_added` / `assets_removed`. No format change.
- **Bytes are content-addressed.** The key is `assets/<sha256>.<ext>` and is the entry's `uri`. Equal bytes share one object, so a put is idempotent. Keys are checked against that pattern everywhere, so a key can never become a path or a URL elsewhere.
- **Object storage: S3-compatible, Cloudflare R2 first.** A `BlobStore` interface (`put`, `get`) with three adapters:
  - memory (default, tests);
  - one file per key under `<dir>/blobs` with `--dir`;
  - an S3-compatible bucket configured by `KYNIMO_S3_*`, with a 30 s timeout per request, so a stalled bucket can't hang an upload or a render. It uses path-style URLs and SigV4 signing through `aws4fetch` (MIT, about 65 KB, no dependencies). It signs a SHA-256 of the body rather than `UNSIGNED-PAYLOAD`, so the bucket rejects bytes altered in transit. The same code serves R2, S3, MinIO and Tigris. R2 comes first because it has no egress fees, and renders and previews read assets often.
  - Postgres projects without a bucket have uploads switched off (`unavailable`, with the reason), never put in memory that other processes can't see.
- **`upload_asset` takes base64 inline, at most 8 MB decoded,** so it works over stdio and any client today. Presigned upload URLs come with the remote transport. The server reads the type and metadata from the file and never trusts the client for them:
  - PNG/JPEG size from IHDR/SOF. For a JPEG this is the size it decodes to: CanvasKit applies EXIF orientation, so orientations 5–8 swap width and height, as camera photos usually need;
  - the font family (name id 16, else 1) and weights (`fvar` wght range, rounded inward to steps of 100, else `OS/2` weight class) from TrueType/OpenType tables.
  - The only override is `family`, for a font whose own name clashes with a bundled family. It is refused for images. Rejections of the generated op are reported on `upload_asset`'s own fields (`family`, `id`, `name`, else `data`).
  - The schema declares the base64 length limit, so a client sees it and oversized calls fail at the boundary.
  - Accepted types are PNG, JPEG, TTF and OTF: exactly what renders. SVG comes with SVG import (M4), audio with the FFmpeg video item.
- **Order and retries.** The server validates the file, stores the bytes, then writes the op through the normal write path (`base_version`, idempotency key, fingerprint over the entry, which includes the hash). A retry with the same key and bytes stores nothing new and replays. The same key with other bytes is `key_reused`. A rejected write leaves an unreferenced object, which is harmless.
- **Renders get the bytes.** Before calling capture, the service loads the bytes of the assets the rendered composition tree uses: image layers, and font files of the families its text uses, following precomps. Assets nothing draws are not loaded, so a stray entry never blocks a render. A render may load at most `RENDER_LIMITS.maxAssetBytes` (64 MB). The service caches them in an in-memory LRU (128 MB by default) and checks each against its pin. Missing or corrupt bytes are a `render_failed` that names the asset, never other pixels. Capture serves them from memory, so nothing in the render path touches the network.
- `list_assets` returns each entry's id, type, hash and metadata, and the layers that use it.

## Consequences

- Agents can bring logos, photos and brand fonts. An uploaded file renders bit-identically to the same pixels drawn without it (tested end to end in Chromium).
- Nothing deletes objects yet. Garbage collection of unreferenced keys (none of any version's documents name them) is a later item; content addressing keeps it safe to add.
- A global content key means one tenant can tell whether another stored the exact same bytes only by already having them. That is acceptable. Revisit per-tenant prefixes when auth lands.
- Base64 costs about a third more bytes on the wire and in the model's output. Large files wait for presigned uploads.
- The tool listing is at 57.6 KB of its 60 KB budget (ADR-0030). The next tool-heavy item has to free room first.
