# 0059 — Shareable preview links

- Status: accepted
- Date: 2026-11-13

## Context

M7 needs a link a recipient can open to watch a rendered video. ADR-0048 already gives each finished export a capability URL for downloading it. The author needs a playback URL for the exact MP4 they reviewed. The designed share page and review tools are M8 work.

## Decision

- `get_preview_link` takes the `job_id` of a succeeded MP4 job from `render_preview_clip` or `export`. It returns `{url, expires_at}` over HTTP. The caller must own the job. Queued or running jobs return `conflict` with polling guidance. Failed, cancelled, or non-MP4 jobs return `invalid`. Unknown jobs and unavailable files return `not_found`. Stdio returns `unavailable` for an owned job.
- The URL is `/previews/<token>` on the server's configured public origin, or its bound loopback origin with `--no-auth`. It uses the existing export file's capability token and expiry. Repeated calls and cache hits resolve to the same file without extending its lifetime. The link exposes the rendered MP4 to anyone with the URL.
- The preview route serves `video/mp4` inline for the browser's native player. It accepts `GET` and `HEAD`. Single byte ranges on `GET` support seeking with `206` and `Content-Range`. Unsatisfiable ranges return `416`. Malformed or multiple ranges fall back to the full file. Successful previews use `private, no-store` and `no-referrer`.
- Job replies retain the `/exports/<token>` download URL. The raw token stays internal to the job result and content cache.

## Consequences

- A link continues to show the rendered version after later scene edits. Rendering another version produces another file and link.
- Export storage keeps files for up to 24 hours. Storage pressure can evict them earlier. Server restarts invalidate links on the current in-process runtime. The bound origin in `--no-auth` mode is loopback, so remote recipients need a deployed HTTP origin.
- Playback uses the same MP4 bytes as the download, including the export's audio mix and fidelity limits.
- The MCP tool listing cap is 121.5 KB. M8 tracks compaction to 60 KB.
