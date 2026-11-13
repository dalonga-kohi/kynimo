#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isLoopback } from "./auth.js";
import { remoteEnv } from "./http.js";
import { type RunningServer, startServer } from "./local-server.js";

const USAGE = `kynimo-mcp — Kynimo MCP server (stdio, or Streamable HTTP with --http)

  --dir <path>    Keep projects as JSON files in this folder (default: in memory, lost on exit)
  --actor <id>    Actor id for undo history and idempotency keys (default: "local"; stdio only)
  --http          Serve Streamable HTTP with OAuth instead of stdio
  --host <addr>   HTTP listen address (default 127.0.0.1)
  --port <n>      HTTP port (default $PORT, else 8787)
  --no-auth       HTTP without OAuth: every request is the local account. Loopback hosts only.
  --help          Show this help

Environment, --http (ADR-0033):
  KYNIMO_PUBLIC_URL     The MCP endpoint as clients reach it, e.g. https://mcp.example.com/mcp;
                        its path is the endpoint path. Required with OAuth.
  KYNIMO_OAUTH_ISSUER   The authorization server's issuer (tokens' iss). Required with OAuth.
  [KYNIMO_OAUTH_AUDIENCE]  Accepted token audiences (default: KYNIMO_PUBLIC_URL)
  [KYNIMO_OAUTH_JWKS_URL]  The issuer's signing keys (default: discovered from the issuer)
  [KYNIMO_OAUTH_SCOPES]    Scopes every token must carry (default: none)
  [KYNIMO_ALLOWED_ORIGINS] Browser origins allowed to call the endpoint (default: none)

Environment:
  KYNIMO_DATABASE_URL   Keep projects in Postgres (postgres://…), shared by any number of
                        server processes. Not combinable with --dir.
  KYNIMO_S3_ENDPOINT, KYNIMO_S3_BUCKET, KYNIMO_S3_ACCESS_KEY_ID, KYNIMO_S3_SECRET_ACCESS_KEY
  [KYNIMO_S3_REGION]    Keep uploaded assets in an S3-compatible bucket (Cloudflare R2, S3,
                        MinIO); region defaults to "auto". Without them, assets live in
                        <dir>/blobs with --dir, in memory without a store, and uploads are off
                        with Postgres.
  KYNIMO_FFMPEG, KYNIMO_FFPROBE
                        FFmpeg binaries for video and audio uploads (default: ffmpeg and
                        ffprobe on PATH). Without them those uploads are off.

Exports (MP4, WebM, GIF; tools export and render_preview_clip) are kept for 24 hours in
<dir>/exports with --dir, otherwise in a temporary folder. Over HTTP, results carry a
download link (GET /exports/<token>). get_preview_link returns an inline playback URL
for a completed MP4 job. Over stdio, results carry the file's path. Exports need FFmpeg.`;

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    actor: { type: "string", default: "local" },
    http: { type: "boolean", default: false },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string" },
    "no-auth": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  // stdout is the MCP channel only when serving; --help never serves.
  process.stdout.write(`${USAGE}\n`);
} else if (values.actor.length < 1 || values.actor.length > 100) {
  process.stderr.write("--actor must be 1 to 100 characters\n");
  process.exitCode = 2;
} else {
  const fail = (e: unknown): never => {
    process.stderr.write(`kynimo-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  };
  const databaseUrl = process.env.KYNIMO_DATABASE_URL || undefined;
  if (databaseUrl && values.dir) fail("use either --dir or KYNIMO_DATABASE_URL, not both");
  const noAuth = values["no-auth"];
  if (!values.http && (noAuth || values.port !== undefined))
    fail("--no-auth and --port need --http");
  if (values.http && noAuth && !isLoopback(values.host))
    fail("--no-auth serves everyone as one account: listen on a loopback --host only");
  if (values.http && values.actor !== "local")
    fail("--actor is for stdio; over HTTP the actor is the signed-in user");
  if (values.http && !noAuth && values.dir)
    fail("--dir keeps one local account; a server with OAuth needs KYNIMO_DATABASE_URL or memory");
  const port = Number(values.port ?? process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be 0 to 65535");
  // The remote settings are checked before anything starts, so a typo fails fast.
  if (values.http && !noAuth) {
    try {
      remoteEnv(process.env);
    } catch (e) {
      fail(e);
    }
  }

  // Signals and a vanished stdin or IPC parent can arrive while the server is still starting.
  let running: RunningServer | undefined;
  let stopRequested = false;
  const release = () => {
    stopRequested = true;
    if (running) void running.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", release);
  process.once("SIGTERM", release);
  if (!values.http) process.stdin.once("end", release);

  try {
    running = await startServer({
      ...(values.dir ? { dir: resolve(values.dir) } : {}),
      actor: values.actor,
      ...(values.http ? { http: { host: values.host, port, noAuth } } : {}),
    });
  } catch (e) {
    fail(e);
  }
  process.stderr.write(`kynimo-mcp ready ${running?.readyLine}\n`);
  if (stopRequested) release();
  // An IPC parent can disappear during startup, before the server is ready to close.
  if (process.send) {
    if (process.connected) process.once("disconnect", release);
    else release();
  }
}
