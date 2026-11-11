# @kynimo/mcp

Kynimo's MCP server: locally over stdio, or remotely over Streamable HTTP with OAuth (`--http`). Contracts and decisions: [ADR-0018](../../docs/decisions/0018-agent-reliability-contracts.md), [ADR-0024](../../docs/decisions/0024-local-mcp-server.md), [ADR-0029](../../docs/decisions/0029-postgres-project-store.md), [ADR-0031](../../docs/decisions/0031-asset-storage.md), [ADR-0033](../../docs/decisions/0033-remote-transport-oauth.md), [ADR-0040](../../docs/decisions/0040-intent-tools.md), [ADR-0041](../../docs/decisions/0041-run-script.md).

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

Tools: `create_project`, `list_projects`, `get_project`, `upload_asset`, `list_assets`, `get_scene`, `get_layer`, `find_layers`, `get_layer_schema`, `get_write_outcome`, `describe_motion`, `apply_ops`, `add_layer`, `update_layer`, `animate`, `apply_preset`, `list_presets`, `stagger`, `retime`, `import_svg`, `add_behavior`, `add_effect`, `set_keyframes`, `add_mask`, `set_matte`, `precompose`, `run_script`, `get_script`, `undo`, `redo`, `render_frames`, `render_contact_sheet`. Every write takes `base_version` and `idempotency_key`. Resources include `kynimo://presets` and `kynimo://sdk` (the type declarations `run_script` scripts are written against).

`import_svg` takes SVG text (up to 512 KB) and adds one shape layer, with the viewBox centre at `position` (default: the composition centre). It returns a fidelity report listing what was dropped, flattened or approximated. Use `dry_run: true` to preview the `addLayer` operation (ADR-0043).

`add_effect` accepts a layer selector and a typed effect body, for example `{ "type": "gaussian-blur", "radius": { "value": 12 } }`. Use `dry_run: true` to preview its `setEffects` operation. Inspect the full parameter schema under `effects` in `get_layer_schema`, or use `apply_preset` with `blur-in` for a blur-to-sharp entrance.

Backgrounds and textures are generator layers (`gradient`, `noise`, `pattern`, `aurora`, ADR-0045): add one with `add_layer` (or `apply_ops` `addLayer`) and change it with the `setGenerator` operation; `get_layer_schema` with type `generator` lists the fields. Looks (`vignette`, `grain`, `chromatic-aberration`, `posterize`, `scanlines`) are effects, so they go through `add_effect`, usually on an adjustment layer. There is no separate generator tool. `get_capabilities` lists the generators and the limits of generators and looks.

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

## Remote server (Streamable HTTP + OAuth)

`--http` serves the same tools over stateless Streamable HTTP (ADR-0033). Kynimo is an OAuth resource server: an external authorization server (WorkOS AuthKit first; any issuer of JWT access tokens with a JWKS works) signs users in and registers clients, and Kynimo checks each token. Every signed-in user is their own account: they see only their own projects.

```bash
KYNIMO_PUBLIC_URL=https://mcp.example.com/mcp \
KYNIMO_OAUTH_ISSUER=https://your-tenant.authkit.app \
KYNIMO_DATABASE_URL=postgres://… \
node apps/mcp/dist/main.js --http --host 0.0.0.0 --port 8787
```

- `KYNIMO_PUBLIC_URL`: the endpoint as clients reach it. Its path is the endpoint path, and it is the audience tokens must carry (override with `KYNIMO_OAUTH_AUDIENCE`).
- `KYNIMO_OAUTH_ISSUER`: the tokens' `iss`. The signing keys are discovered from its metadata, or set `KYNIMO_OAUTH_JWKS_URL`.
- Optional: `KYNIMO_OAUTH_SCOPES` (scopes every token must carry), `KYNIMO_ALLOWED_ORIGINS` (browser origins that may call the endpoint; requests without an `Origin` header are unaffected).
- Clients find the authorization server from `/.well-known/oauth-protected-resource/<path>` (RFC 9728), which the `401` challenge points at.
- Projects are kept in Postgres or in memory; `--dir` holds one local account and works only with `--no-auth`.
- `--no-auth` serves every request as the local account, on a loopback `--host` only, for trying the HTTP transport (e.g. with the MCP Inspector) without an authorization server.

TLS is the hosting environment's job: run behind a proxy that terminates HTTPS.
