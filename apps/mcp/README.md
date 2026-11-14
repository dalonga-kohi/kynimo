# @kynimo/mcp

Kynimo's MCP server: locally over stdio, or remotely over Streamable HTTP with OAuth (`--http`). Contracts and decisions: [ADR-0018](../../docs/decisions/0018-agent-reliability-contracts.md), [ADR-0024](../../docs/decisions/0024-local-mcp-server.md), [ADR-0029](../../docs/decisions/0029-postgres-project-store.md), [ADR-0031](../../docs/decisions/0031-asset-storage.md), [ADR-0033](../../docs/decisions/0033-remote-transport-oauth.md), [ADR-0040](../../docs/decisions/0040-intent-tools.md), [ADR-0041](../../docs/decisions/0041-run-script.md), [ADR-0048](../../docs/decisions/0048-export-pipeline.md).

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

Tools: `create_project`, `list_projects`, `get_project`, `upload_asset`, `list_assets`, `get_scene`, `get_layer`, `find_layers`, `get_layer_schema`, `get_write_outcome`, `describe_motion`, `apply_ops`, `add_layer`, `update_layer`, `animate`, `apply_preset`, `list_presets`, `stagger`, `retime`, `mark_beats`, `sync_to_beats`, `import_svg`, `add_behavior`, `add_effect`, `add_transition`, `set_keyframes`, `add_mask`, `set_matte`, `precompose`, `run_script`, `get_script`, `undo`, `redo`, `render_frames`, `render_contact_sheet`, `export`, `render_preview_clip`, `get_export_status`, `cancel_export`. Scene edits take `base_version` and `idempotency_key`. Use `define_shader` to publish a project definition with an idempotency key and `list_definitions` to discover versions. Resources include `kynimo://presets` and `kynimo://sdk` (the type declarations `run_script` scripts are written against).

Audio uploads are analysed for a steady beat; `list_assets` shows `bpm` and `beat_count` for audio that has one. `mark_beats` puts the beats on an audio layer as markers (`beat 1`, `beat 2`, ...), or a grid from `grid: { bpm, first_beat_frame, count }`; `replace: true` clears the layer's markers first. `sync_to_beats` snaps keyframes and/or cuts (`snap`) of `layers` to the markers of `audio_layer`, optionally every nth beat (`every`, `phase`), within `max_distance` frames (`window` is judged on the frames before the call, so a cut slide never moves a keyframe in or out of it). Both take `dry_run` (ADR-0052).

`import_svg` takes SVG text (up to 512 KB) and adds one shape layer, with the viewBox centre at `position` (default: the composition centre). It returns a fidelity report listing what was dropped, flattened or approximated. Use `dry_run: true` to preview the `addLayer` operation (ADR-0043).

`add_transition` adds a built-in shader transition (dissolve, noise-dissolve, wipe, clock, iris, blinds, pixelate, push, zoom, glitch) to a drawn layer: `edge: "in"` reveals it over what is beneath, `"out"` lets it give way; call again with the same kind for the other edge. Durations and easings are style tokens or ms; `params` overrides the kind's fields.

`add_effect` accepts a layer selector and a typed effect body, for example `{ "type": "gaussian-blur", "radius": { "value": 12 } }`. Use `dry_run: true` to preview its `setEffects` operation. Inspect the full parameter schema under `effects` in `get_layer_schema`, or use `apply_preset` with `blur-in` for a blur-to-sharp entrance.

Motion blur (ADR-0053) is a layer field: `apply_ops` or `update_layer` with `set: { motionBlur: {} }` stores the defaults (shutter angle 180, phase -90, 16 samples), `null` turns it off. It blurs transform motion (position, scale, rotation, parents, behaviors), not animated contents, and cost grows with samples. `get_capabilities` lists its limits.

3D layers and cameras (ADR-0054) are layer fields: `set: { threeD: true }` puts a layer in 3D (`positionZ`, `rotationX`, `rotationY` in its transform), and a `camera` layer (`zoom`, `pointOfInterest`) sets the view; without a camera a default 50 mm one is used. Contiguous 3D layers are depth-sorted, a 2D layer or adjustment layer ends the run and ignores the camera, and precomps are flat cards. There are no lights, materials or models yet. `get_capabilities` lists `features.three_d`.

Set puppet pins (ADR-0056, scene format 15) with `update_layer` or the `updateLayer` op in `apply_ops`. For example, `set: { deform: { pins: [{ id: "tip", rest: [120, 20], position: { value: [120, 40] } }] } }` displaces the nearest mesh vertex by 20 layer units vertically. Use `position: { keyframes: [...] }` to animate it and `deform: null` to clear the mesh. `retime` and `stagger` can move pin keyframes. Each drawn source layer supports up to 32 pins, density 4–64 (default 24), and 1–30 solver iterations (default 10). `get_capabilities` reports triangle and frame work limits under `limits.deform`. See `get_layer_schema` for the pin track schema.

Backgrounds and textures are generator layers (`gradient`, `noise`, `pattern`, `aurora`, ADR-0045): add one with `add_layer` (or `apply_ops` `addLayer`) and change it with the `setGenerator` operation; `get_layer_schema` with type `generator` lists the fields. Looks (`vignette`, `grain`, `chromatic-aberration`, `posterize`, `scanlines`) are effects, so they go through `add_effect`, usually on an adjustment layer. There is no separate generator tool. `get_capabilities` lists the generators and the limits of generators and looks.

Use `list_components` or `kynimo://components` for built-in versions and prop descriptors. `add_component` validates props and writes a component layer pinned to `component_version` (latest if omitted). Missing props take their defaults. The layer starts at `in_frame` (default 0), with an exclusive `out_frame` (default composition duration). Use `dry_run: true` to preview the operation.

### Custom components

Call `define_component` with `project_id`, `idempotency_key`, a `custom-` id, a version such as `1.0.0`, `title`, `description`, `props`, and the TypeScript `source`. Publishing leaves the scene version unchanged. Each project keeps up to 64 immutable component versions. Publish a new version to change the source or prop descriptors.

```ts
export function evaluate(props: { label: string }, ctx) {
  const layers = [];
  const fill = ctx.style.color("text");
  const size = ctx.style.type("title").size;
  layers.push(text("title", 32 + ctx.frame, 64, props.label, size, fill));
  return { width: ctx.width, height: ctx.height, layers };
}
```

Declare the example's prop as `props: { label: { type: "string", description: "Title text", default: "Hello", maxLength: 80 } }`. Read `kynimo://components` for the supported expressions, drawing helpers, descriptors, and limits. `list_definitions` returns component summaries under `component_definitions`, and `kynimo://components/{project_id}` includes them with the authoring guide. Place the component with `add_component`, then use `render_frames` or `render_contact_sheet` to check its output. Instances remain editable through their props. Render-time errors identify the instance and invalid output.

### Build a storyboard

The MCP client turns the user's brief into the structured `shots` passed to `build_from_brief`. The server assembles them deterministically into one editable, undoable write. Create a project with enough frames, upload media, and call the tool with the write metadata and storyboard.

```json
{
  "project_id": "YOUR_PROJECT_ID",
  "base_version": 2,
  "idempotency_key": "preview-launch",
  "dry_run": true,
  "transition": "wipe",
  "shots": [
    { "type": "headline", "text": "Meet Atlas", "duration_frames": 45 },
    { "type": "image", "asset_id": "atlas-screen", "duration_frames": 60 },
    { "type": "logo", "wordmark": "Atlas", "duration_frames": 45 }
  ]
}
```

Shots are contiguous from `start_frame` (default 0) in the selected composition (default main). A shot can include `lower_third: { title, subtitle? }`. The shared background follows the project's style. Use `background: "transparent"` to leave the existing background visible through uncovered areas. Media is centered and contained by default. Use `fit: "cover"` for a centered crop. A video shot's `source_offset_frames` trims its visual track in composition frames. Use a separate audio layer for sound.

The dry run returns the planned operations and resolved shot and transition windows. A requested wipe becomes a hard cut when adjacent shots are too short. When the timing fits, submit the write and use `render_contact_sheet` to inspect the result.

The render tools need the pinned Chromium (`pnpm --filter @kynimo/renderer exec playwright install chromium`) and a built `@kynimo/capture` (`pnpm build`). Rendering and publishing a new shader version start Chromium on demand.

### Custom shaders

Call the `define_shader` tool to publish a generator or a single-input effect. For example, the following request publishes a generator that scales its red channel with an editable uniform.

```json
{
  "project_id": "p-00000000000000000000000000000000",
  "idempotency_key": "define-poster-1",
  "id": "custom-poster",
  "version": "1.0.0",
  "title": "Poster",
  "kind": "generator",
  "source": "return vec4(uv.x * u_amount, uv.y, 0.2, 1.0);",
  "uniforms": { "u_amount": { "type": "float", "default": 0.8 } }
}
```

Place it with `add_layer` using a generator layer and a generator body of `{"type":"custom-shader","shaderId":"custom-poster","shaderVersion":"1.0.0","uniforms":{}}`. Use the same pin fields in `add_effect` for an effect. Uniforms take the usual `value` or `keyframes` track. Missing values use the definition defaults. A new shader version leaves existing scene pins in place.

The catalog at `kynimo://shaders` describes the language and built-ins. Read `kynimo://projects/{project_id}/shaders` or call `list_definitions` for the project versions.

## Export (MP4, WebM, GIF; ADR-0048)

Four tools run exports as background jobs. They need FFmpeg (see below) and the pinned Chromium.

- `export` takes `format` (`mp4` default, `webm` with transparency, `gif` without sound), `composition`, `from_frame`, `to_frame`, `max_size` and an `idempotency_key`. Limits: mp4/webm up to 1920 px and 60 s; gif 480 px by default, up to 960 px and 15 s. It returns a job at once.
- `render_preview_clip` makes a short mp4 (up to 480 px, default 360; up to 10 s); its finished status also carries a contact sheet of 6 frames.
- `get_export_status` takes `job_id` and `wait_seconds` (0 to 25) and returns state, progress and, when done, the result: size, duration, `url` (HTTP) or `path` (stdio), `expires_at`, a fidelity report (what the format dropped, flattened or approximated) and skipped layers and warnings as frame ranges.
- `cancel_export` stops a queued or running job.

Jobs run inside the server process, one at a time, with at most 4 queued or running per account (32 server-wide); more is answered with the `busy` error. Job records are kept for 24 hours. A restart loses queued and running jobs and download links.

Finished files are kept for 24 hours (at most 4 GiB in total) in `<dir>/exports` with `--dir`, otherwise in a temporary folder that is removed when the server shuts down (`<dir>/exports` is never removed). Over HTTP, `GET /exports/<token>` (and `HEAD`) downloads a file: the unguessable token in the link is the only credential and the link expires with the file. Over stdio the result gives the file's `path` instead. The same export of the same document is not rendered twice.

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

## Native local server

The [native bundle](../../scripts/local/README.md) packages this server with Node.js,
pinned Chromium and FFmpeg. It starts on loopback with persistent per-user storage,
and supports stdio for clients that launch their own process.

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

## Docker

One image runs the server with the pinned Chromium and FFmpeg, locally and deployed. Build it from the repository root:

```bash
docker compose up --build
```

That is the local shape: one account, no sign-in, at `http://127.0.0.1:8787/mcp`. Projects, uploaded assets and exports are kept in the `kynimo-data` volume. The port is published on the host's loopback only, because without OAuth anyone who can reach it is the local account. Export download links name port 8787, so keep that port (or set `KYNIMO_PORT` and rewrite the links yourself).

To connect Claude Code:

```bash
claude mcp add --transport http kynimo http://127.0.0.1:8787/mcp
```

To deploy, run the same image with the remote server's settings. Setting `KYNIMO_OAUTH_ISSUER` switches the container to OAuth on every interface:

```bash
docker run -d --shm-size=1g -p 8787:8787 \
  -e KYNIMO_PUBLIC_URL=https://mcp.example.com/mcp \
  -e KYNIMO_OAUTH_ISSUER=https://your-tenant.authkit.app \
  -e KYNIMO_DATABASE_URL -e KYNIMO_S3_ENDPOINT -e KYNIMO_S3_BUCKET \
  -e KYNIMO_S3_ACCESS_KEY_ID -e KYNIMO_S3_SECRET_ACCESS_KEY \
  kynimo-mcp
```

- **Shared memory:** give the container at least 1 GB of `/dev/shm` (`--shm-size=1g`; `shm_size` in Compose). Chromium keeps its render buffers there and Docker's 64 MB default makes renders fail.
- **Stopping:** `SIGTERM` closes the server, the renderer and the store; allow about 30 s (`stop_grace_period`).
- **Health:** the image's health check passes once the server accepts connections on its port.
- **Exports** are kept in a temporary folder inside the container when a database is set, so they do not survive a restart (ADR-0048).
- **Port:** the server listens on `PORT` (default 8787).
