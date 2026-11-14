import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchCapture } from "@kynimo/capture";
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
import type { McpRequestEvent, McpRequestMessage } from "./request-events.js";
import { createServer } from "./server.js";
import { KynimoService, ServiceRuntime } from "./service.js";
import { type AccountStore, FileStore, MemoryStore, type ProjectStore } from "./store.js";
import { connectPostgres, type Database, PostgresStore } from "./store-postgres.js";

export { describeRequest } from "./request-events.js";
export type { ProjectMeta, ProjectStore } from "./store.js";
export type { KynimoService, McpRequestEvent, McpRequestMessage, ServiceRuntime };

export interface ServerConfig {
  /** FileStore directory; undefined keeps projects in memory. */
  dir?: string;
  /** Actor of the stdio server. Default "local". */
  actor?: string;
  /** Serve Streamable HTTP; undefined serves stdio. */
  http?: { host: string; port: number; noAuth: boolean };
  /** Replaces process.env for KYNIMO_* settings. Default process.env. */
  env?: Record<string, string | undefined>;
  /** HTTP only: told about each request before it is handled. */
  onRequest?: (event: McpRequestEvent) => void;
  /** Where status lines go. Default: stderr (stdout carries the stdio protocol). */
  log?: (line: string) => void;
}

export interface ActiveJob {
  jobId: string;
  projectId: string;
  kind: "export" | "preview";
  state: string;
  phase: string;
  framesDone: number;
  framesTotal: number;
}

export interface RunningServer {
  /** The MCP endpoint, e.g. "http://127.0.0.1:8787/mcp" (HTTP only). */
  endpoint?: string;
  /** The bound port; the real one when 0 was requested (HTTP only). */
  port?: number;
  exportDir: string;
  store: ProjectStore;
  runtime: ServiceRuntime;
  /** The line the CLI prints once ready, after "kynimo-mcp ready ". */
  readyLine: string;
  /** A service on the same store and runtime, for an in-process host. */
  service(actor: string): KynimoService;
  /** Queued and running export and preview jobs. */
  activeJobs(): ActiveJob[];
  /** Stops HTTP, the runtime, the renderer and the store. Idempotent. */
  close(): Promise<void>;
}

const defaultLog = (line: string) => void process.stderr.write(`${line}\n`);

/**
 * Starts the MCP server in this process. Never exits the process, installs signal handlers or
 * reads argv: the CLI (`main.ts`) and an in-process host both call it. Throws, after closing
 * whatever it had opened, when the configuration is invalid or the port cannot be bound.
 */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const env = config.env ?? process.env;
  const log = config.log ?? defaultLog;
  const actor = config.actor ?? "local";
  const dir = config.dir ? resolve(config.dir) : undefined;
  const http = config.http;

  const databaseUrl = env.KYNIMO_DATABASE_URL || undefined;
  if (databaseUrl && dir) throw new Error("use either --dir or KYNIMO_DATABASE_URL, not both");
  if (http?.noAuth && !isLoopback(http.host))
    throw new Error("--no-auth serves everyone as one account: listen on a loopback --host only");
  if (http && !http.noAuth && dir)
    throw new Error(
      "--dir keeps one local account; a server with OAuth needs KYNIMO_DATABASE_URL or memory",
    );
  if (http && (!Number.isInteger(http.port) || http.port < 0 || http.port > 65535))
    throw new Error("--port must be 0 to 65535");
  // The remote settings are checked before anything starts, so a typo fails fast.
  const remote = http && !http.noAuth ? remoteEnv(env) : undefined;
  const s3 = s3ConfigFromEnv(env);
  const gpu = env.KYNIMO_GPU || "swiftshader";
  if (gpu !== "swiftshader" && gpu !== "hardware")
    throw new Error(`KYNIMO_GPU must be 'swiftshader' or 'hardware' (got '${gpu}')`);

  // Undo steps, newest first, for a failed start and for close().
  const stops: Array<() => Promise<unknown>> = [];
  const teardown = async () => {
    for (const stop of stops.splice(0).reverse()) await Promise.allSettled([stop()]);
  };

  // A temporary exports folder (no dir) goes with the server, last; <dir>/exports is never removed.
  let tempExports: string | undefined;
  stops.push(async () => {
    if (tempExports) await rm(tempExports, { recursive: true, force: true });
  });

  try {
    let store: ProjectStore;
    let accounts: AccountStore | undefined;
    let where: string;
    if (databaseUrl) {
      // The URL holds the password: never echo it, and report pool errors by message only.
      const db: Database = connectPostgres(databaseUrl, (e) =>
        log(`kynimo-mcp: database connection error: ${e.message}`),
      );
      stops.push(() => db.close());
      const postgres = await PostgresStore.open(db);
      store = accounts = postgres;
      where = "projects in Postgres";
    } else if (dir) {
      const fileStore = await FileStore.open(dir);
      stops.push(() => fileStore.close());
      store = fileStore;
      where = `projects in ${dir}`;
    } else {
      store = accounts = new MemoryStore();
      where = "in-memory projects";
    }
    let blobs: BlobStore | undefined;
    let assetsWhere: string;
    if (s3) {
      blobs = new S3BlobStore(s3);
      assetsWhere = `assets in bucket ${s3.bucket}`;
    } else if (dir) {
      blobs = new DirBlobStore(resolve(dir, "blobs"));
      assetsWhere = `assets in ${resolve(dir, "blobs")}`;
    } else if (databaseUrl) {
      assetsWhere = "asset upload off: set KYNIMO_S3_* to keep assets with Postgres projects";
    } else {
      blobs = new MemoryBlobStore();
      assetsWhere = "in-memory assets";
    }
    const media = new Ffmpeg({
      ffmpeg: env.KYNIMO_FFMPEG || "ffmpeg",
      ffprobe: env.KYNIMO_FFPROBE || "ffprobe",
    });
    const hasMedia = await media.available();
    const mediaWhere = hasMedia
      ? `video via ${await media.version()}`
      : "video upload off: no FFmpeg";
    // Chromium starts on the first render, not here. KYNIMO_GPU=hardware draws on the host's GPU
    // instead of SwiftShader: much faster, but the pixels then depend on that GPU (ADR-0059).
    const gpuArgs = env.KYNIMO_GPU_ARGS?.split(/\s+/).filter((arg) => arg !== "");
    const renderer = new CaptureRenderer(() =>
      launchCapture({
        gpu: gpu === "hardware" ? "hardware" : "swiftshader",
        ...(gpuArgs === undefined || gpuArgs.length === 0 ? {} : { gpuArgs }),
      }),
    );
    stops.push(() => renderer.close());
    const exportDir = dir
      ? resolve(dir, "exports")
      : await mkdtemp(join(tmpdir(), "kynimo-exports-"));
    tempExports = dir ? undefined : exportDir;
    const exportFiles = await ExportFiles.open(exportDir);
    // The media links' origin: set once the server is listening (no auth) or from the public URL.
    let mediaOrigin: string | undefined;
    const runtime = new ServiceRuntime({
      renderer,
      exportFiles,
      localExportPaths: !http,
      ...(http
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
    stops.push(() => runtime.close());
    const ready = `${where}; ${assetsWhere}; ${mediaWhere}; exports in ${exportDir}`;

    let endpoint: string | undefined;
    let port: number | undefined;
    let readyLine: string;
    if (!http) {
      const server = createServer(new KynimoService(store, actor, runtime));
      await server.connect(new StdioServerTransport());
      readyLine = `(${ready})`;
    } else {
      let auth: AuthConfig | undefined;
      if (remote) {
        const jwksUri = remote.jwksUri ?? (await discoverJwksUri(remote.issuer));
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
        ...(config.onRequest ? { onRequest: config.onRequest } : {}),
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
          log(`kynimo-mcp: request failed: ${text(e)}${cause}`);
        },
      });
      const server = createHttpServer(handler);
      // Stopped first: nothing new may reach the runtime while it closes.
      stops.push(
        () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeIdleConnections();
          }),
      );
      await new Promise<void>((r, j) => {
        server.once("error", j);
        server.listen(http.port, http.host, () => r());
      });
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : http.port;
      // OAuth: links are on the public origin; otherwise on the address the server bound.
      mediaOrigin = remote
        ? remote.resource.origin
        : `http://${http.host.includes(":") ? `[${http.host}]` : http.host}:${bound}`;
      const at = typeof address === "object" && address ? `${http.host}:${address.port}` : "";
      const mode = auth ? `OAuth from ${auth.issuer}` : "no auth: local account";
      port = bound;
      endpoint = `http://${at}${path}`;
      readyLine = `on ${endpoint} (${mode}; ${ready})`;
    }

    let closing: Promise<void> | undefined;
    return {
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(port === undefined ? {} : { port }),
      exportDir,
      store,
      runtime,
      readyLine,
      service: (who) => new KynimoService(store, who, runtime),
      activeJobs: () =>
        runtime.activeJobs().map((job) => ({
          jobId: job.id,
          projectId: job.projectId,
          kind: job.kind === "preview" ? "preview" : "export",
          state: job.state,
          phase: job.progress.phase,
          framesDone: job.progress.frames_done,
          framesTotal: job.progress.frames_total,
        })),
      close: () => {
        closing ??= teardown();
        return closing;
      },
    };
  } catch (e) {
    await teardown();
    throw e;
  }
}
