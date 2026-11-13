#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type AuthConfig, discoverJwksUri, isLoopback, remoteKeys } from "./auth.js";
import {
  type BlobStore,
  DirBlobStore,
  MemoryBlobStore,
  S3BlobStore,
  s3ConfigFromEnv,
} from "./blobs.js";
import { ExportFiles } from "./export-files.js";
import { createHttpHandler, remoteEnv } from "./http.js";
import { Ffmpeg } from "./media.js";
import { CaptureRenderer } from "./render.js";
import { createServer } from "./server.js";
import { KynimoService, ServiceRuntime } from "./service.js";
import { type AccountStore, FileStore, MemoryStore, type ProjectStore } from "./store.js";
import { connectPostgres, type Database, PostgresStore } from "./store-postgres.js";

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
  const remote =
    values.http && !noAuth
      ? (() => {
          try {
            return remoteEnv(process.env);
          } catch (e) {
            return fail(e);
          }
        })()
      : undefined;
  let store: ProjectStore;
  let accounts: AccountStore | undefined;
  let where: string;
  let close: () => Promise<void> = async () => undefined;
  if (databaseUrl) {
    // The URL holds the password: never echo it, and report pool errors by message only.
    const db: Database = connectPostgres(databaseUrl, (e) =>
      process.stderr.write(`kynimo-mcp: database connection error: ${e.message}\n`),
    );
    const postgres = await PostgresStore.open(db).catch(fail);
    store = accounts = postgres;
    close = () => db.close();
    where = "projects in Postgres";
  } else if (values.dir) {
    const fileStore = await FileStore.open(resolve(values.dir)).catch(fail);
    store = fileStore;
    close = () => fileStore.close();
    where = `projects in ${resolve(values.dir)}`;
  } else {
    store = accounts = new MemoryStore();
    where = "in-memory projects";
  }
  let blobs: BlobStore | undefined;
  let assetsWhere: string;
  const s3 = (() => {
    try {
      return s3ConfigFromEnv(process.env);
    } catch (e) {
      return fail(e);
    }
  })();
  if (s3) {
    blobs = new S3BlobStore(s3);
    assetsWhere = `assets in bucket ${s3.bucket}`;
  } else if (values.dir) {
    blobs = new DirBlobStore(resolve(values.dir, "blobs"));
    assetsWhere = `assets in ${resolve(values.dir, "blobs")}`;
  } else if (databaseUrl) {
    assetsWhere = "asset upload off: set KYNIMO_S3_* to keep assets with Postgres projects";
  } else {
    blobs = new MemoryBlobStore();
    assetsWhere = "in-memory assets";
  }
  const media = new Ffmpeg({
    ffmpeg: process.env.KYNIMO_FFMPEG || "ffmpeg",
    ffprobe: process.env.KYNIMO_FFPROBE || "ffprobe",
  });
  const hasMedia = await media.available();
  const mediaWhere = hasMedia
    ? `video via ${await media.version()}`
    : "video upload off: no FFmpeg";
  // Chromium starts on the first render, not here.
  const renderer = new CaptureRenderer();
  const exportDir = values.dir
    ? resolve(values.dir, "exports")
    : await mkdtemp(join(tmpdir(), "kynimo-exports-")).catch(fail);
  const exportFiles = await ExportFiles.open(exportDir).catch(fail);
  // The media links' origin: set once the server is listening (--no-auth) or from the public URL.
  let mediaOrigin: string | undefined;
  const runtime = new ServiceRuntime({
    renderer,
    exportFiles,
    localExportPaths: !values.http,
    ...(values.http
      ? {
          downloadUrl: (token: string) => `${mediaOrigin}/exports/${token}`,
          previewUrl: (token: string) => `${mediaOrigin}/previews/${token}`,
        }
      : {}),
    ...(hasMedia ? { media } : {}),
    ...(blobs === undefined
      ? {
          blobsUnavailable:
            "this server keeps projects in Postgres but has no asset bucket (KYNIMO_S3_*)",
        }
      : { blobs }),
  });
  let stopHttp: () => Promise<void> = async () => undefined;
  const release = () => {
    void stopHttp()
      .then(() => runtime.close())
      .then(() => Promise.allSettled([renderer.close(), close()]))
      // A temporary exports folder (no --dir) goes with the server; <dir>/exports is never removed.
      .then(() =>
        values.dir ? undefined : rm(exportDir, { recursive: true, force: true }).catch(() => {}),
      )
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", release);
  process.once("SIGTERM", release);
  const ready = `${where}; ${assetsWhere}; ${mediaWhere}; exports in ${exportDir}`;

  if (!values.http) {
    process.stdin.once("end", release);
    const server = createServer(new KynimoService(store, values.actor, runtime));
    await server.connect(new StdioServerTransport());
    // Logs go to stderr: stdout carries the protocol.
    process.stderr.write(`kynimo-mcp ready (${ready})\n`);
  } else {
    let auth: AuthConfig | undefined;
    if (remote) {
      const jwksUri = remote.jwksUri ?? (await discoverJwksUri(remote.issuer).catch(fail));
      auth = { ...remote, keys: remoteKeys(jwksUri) };
    }
    const path = remote?.resource.pathname ?? "/mcp";
    const scoped = accounts;
    const accountView = (account: string) => {
      // Never fall back to one shared store when users are signed in.
      if (!scoped) throw new Error("a server with OAuth needs a store with accounts");
      return scoped.forAccount(account);
    };
    const handler = createHttpHandler({
      path,
      auth,
      allowedOrigins: remote?.allowedOrigins ?? [],
      exports: exportFiles,
      serve: (caller) =>
        createServer(
          new KynimoService(
            // Without auth every caller is the local account: the plain store serves it.
            auth ? accountView(caller.account) : store,
            caller.actor,
            runtime,
          ),
        ),
      onError: (e) => {
        const text = (x: unknown) => (x instanceof Error ? x.message : String(x));
        const cause = e instanceof Error && e.cause !== undefined ? ` (${text(e.cause)})` : "";
        process.stderr.write(`kynimo-mcp: request failed: ${text(e)}${cause}\n`);
      },
    });
    const http = createHttpServer(handler);
    stopHttp = () => new Promise((r) => http.close(() => r()));
    await new Promise<void>((r, j) => {
      http.once("error", j);
      http.listen(port, values.host, () => r());
    }).catch(fail);
    const address = http.address();
    // OAuth: links are on the public origin; otherwise on the address the server bound.
    mediaOrigin = remote
      ? remote.resource.origin
      : `http://${values.host.includes(":") ? `[${values.host}]` : values.host}:${typeof address === "object" && address ? address.port : port}`;
    const at = typeof address === "object" && address ? `${values.host}:${address.port}` : "";
    const mode = auth ? `OAuth from ${auth.issuer}` : "no auth: local account";
    process.stderr.write(`kynimo-mcp ready on http://${at}${path} (${mode}; ${ready})\n`);
  }
}
