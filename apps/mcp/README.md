# @kynimo/mcp

Kynimo's MCP server. For now it runs locally over stdio; the remote transport comes later in M3. Contracts and decisions: [ADR-0018](../../docs/decisions/0018-agent-reliability-contracts.md), [ADR-0024](../../docs/decisions/0024-local-mcp-server.md), [ADR-0029](../../docs/decisions/0029-postgres-project-store.md), [ADR-0031](../../docs/decisions/0031-asset-storage.md).

```bash
pnpm --filter @kynimo/mcp build
node apps/mcp/dist/main.js --dir ~/kynimo-projects   # omit --dir to keep projects in memory
```

To connect an MCP client (e.g. Claude Desktop or Claude Code), point it at the built entry:

```json
{
  "mcpServers": {
    "kynimo": {
      "command": "node",
      "args": [
        "/absolute/path/to/kynimo/apps/mcp/dist/main.js",
        "--dir",
        "/absolute/path/to/projects"
      ]
    }
  }
}
```

Tools: `create_project`, `list_projects`, `get_project`, `upload_asset`, `list_assets`, `get_scene`, `get_layer`, `find_layers`, `get_layer_schema`, `get_write_outcome`, `describe_motion`, `apply_ops`, `add_layer`, `update_layer`, `set_keyframes`, `add_mask`, `set_matte`, `precompose`, `undo`, `redo`, `render_frames`, `render_contact_sheet`. Every write takes `base_version` and `idempotency_key`.

The render tools need the pinned Chromium (`pnpm --filter @kynimo/renderer exec playwright install chromium`) and a built `@kynimo/capture` (`pnpm build`). Chromium starts on the first render, so every other tool works without it.

Where projects live (ADR-0029):

- **In memory** (default): lost on exit.
- **`--dir <path>`**: JSON files in a folder. One server process owns a folder at a time; a second one on the same folder refuses to start.
- **`KYNIMO_DATABASE_URL=postgres://…`**: Postgres, shared by any number of server processes. The schema is created and migrated on startup. Every version's document is kept; idempotency keys keep their outcome for 7 days (`get_write_outcome` then answers `expired`, and reusing the key fails with `key_expired`) and are forgotten after 90.

```json
{
  "mcpServers": {
    "kynimo": {
      "command": "node",
      "args": ["/absolute/path/to/kynimo/apps/mcp/dist/main.js"],
      "env": { "KYNIMO_DATABASE_URL": "postgresql://user:password@host:5432/kynimo" }
    }
  }
}
```

The store tests run on an in-process Postgres (PGlite). The multi-process tests in `src/store.postgres.test.ts` need a real server: set `KYNIMO_TEST_DATABASE_URL` to an empty, disposable database (CI runs a Postgres 16 service for them).

Where uploaded assets live (ADR-0031). `upload_asset` takes PNG, JPEG, TTF or OTF files, video (MP4, MOV, WebM, MKV; up to 60 s) and audio (WAV, MP3, FLAC, Ogg, M4A), base64-encoded, up to 8 MB. Video and audio need FFmpeg: `ffmpeg` and `ffprobe` on PATH, or `KYNIMO_FFMPEG` / `KYNIMO_FFPROBE` (ADR-0032); without it those uploads are off. Bytes are stored under their SHA-256:

- **In memory** without a store. They are lost on exit.
- **`<dir>/blobs`** with `--dir`.
- **An S3-compatible bucket** (Cloudflare R2, AWS S3, MinIO). Set `KYNIMO_S3_ENDPOINT` (e.g. `https://<account>.r2.cloudflarestorage.com`), `KYNIMO_S3_BUCKET`, `KYNIMO_S3_ACCESS_KEY_ID` and `KYNIMO_S3_SECRET_ACCESS_KEY`, plus `KYNIMO_S3_REGION` if it isn't `auto`. This setting takes precedence over the other two. With Postgres projects, uploads are off until a bucket is set.
