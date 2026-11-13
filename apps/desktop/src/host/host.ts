import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type RunningServer, startServer } from "@kynimo/mcp/local";
import type { ExportFormat, StudioStatus } from "../shared/api.js";
import { desktopDir, displayDir, endpointFile } from "../shared/paths.js";
import type { HostEvent, HostInit, HostRequest, HostResponse } from "../shared/protocol.js";
import { ActivityLog } from "./activity.js";
import { atomicWriteJson } from "./files.js";
import { DEFAULT_PORTS, startOnFirstFreePort } from "./ports.js";
import { Studio } from "./studio.js";

export interface HostOptions {
  /** Ports to try, in order. Default: 8787 to 8797, then any. */
  ports?: readonly number[];
  now?: () => number;
  /** Where the media tools' paths are set and the server reads KYNIMO_* settings. Default process.env. */
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

// The store's id format; ids reach the host from the renderer, so they are checked here too.
const PROJECT_ID = /^p-[a-f0-9]{32}$/;
const FORMATS: readonly ExportFormat[] = ["mp4", "webm", "gif"];

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The server and everything built on it, in the process main starts for it. Returns at once;
 * `ready` settles when the server is up or has failed (it never rejects: a failure is a status).
 */
export class Host {
  private state: StudioStatus["server"] = "starting";
  private error: string | undefined;
  private studio: Studio | undefined;
  private server: RunningServer | undefined;
  private activity: ActivityLog | undefined;
  private closing: Promise<void> | undefined;
  readonly ready: Promise<void>;
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(
    private readonly init: HostInit,
    private readonly emit: (event: HostEvent) => void,
    private readonly options: HostOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.ready = this.start().catch((e) => {
      this.state = "failed";
      this.error = message(e);
      this.emit({ event: "changed" });
    });
  }

  private async start(): Promise<void> {
    const { init, options } = this;
    const env = options.env ?? process.env;
    const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
    const { ffmpeg, ffprobe, browsers } = init.media;
    if (ffmpeg !== undefined) env.KYNIMO_FFMPEG = ffmpeg;
    if (ffprobe !== undefined) env.KYNIMO_FFPROBE = ffprobe;
    if (browsers !== undefined) env.PLAYWRIGHT_BROWSERS_PATH = browsers;

    const own = desktopDir(init.dataDir);
    await mkdir(own, { recursive: true });
    const activity = await ActivityLog.open({
      file: join(own, "activity.json"),
      now: this.now,
      onChange: () => this.studio?.notify(),
    });
    this.activity = activity;
    const server = await startOnFirstFreePort(options.ports ?? DEFAULT_PORTS, (port) =>
      startServer({
        dir: init.dataDir,
        http: { host: "127.0.0.1", port, noAuth: true },
        env,
        log,
        onRequest: (event) => activity.recordRequest(event),
      }),
    );
    this.server = server;
    const studio = new Studio({
      server,
      activity,
      now: this.now,
      cacheDir: join(own, "cache"),
      dataDir: init.dataDir,
      projectsDir: displayDir(init.dataDir),
      settingsFile: join(own, "settings.json"),
    });
    studio.onChanged(() => this.emit({ event: "changed" }));
    this.studio = studio;
    this.state = "running";
    if (server.endpoint !== undefined && server.port !== undefined)
      await atomicWriteJson(endpointFile(init.dataDir), {
        endpoint: server.endpoint,
        port: server.port,
        pid: process.pid,
      });
    studio.start();
    this.emit({ event: "changed" });
  }

  status(): StudioStatus {
    if (this.studio !== undefined) return this.studio.status();
    return {
      server: this.state,
      ...(this.error === undefined ? {} : { error: this.error }),
      dataDir: this.init.dataDir,
      projectsDir: displayDir(this.init.dataDir),
      startedAt: this.startedAt,
    };
  }

  /** Answers one request from main. Never throws: a failure is an `error` response. */
  async dispatch(request: HostRequest): Promise<HostResponse> {
    const { id } = request;
    try {
      return { id, result: await this.call(request.method, request.params) };
    } catch (e) {
      return { id, error: message(e) };
    }
  }

  private async call(method: HostRequest["method"], params: unknown): Promise<unknown> {
    if (method === "status") return this.status();
    if (method === "close") {
      await this.close();
      return null;
    }
    const studio = this.studio;
    // Until the server is up there is nothing to list yet.
    if (studio === undefined && method === "listAnimations") return [];
    if (studio === undefined)
      throw new Error(
        this.state === "failed"
          ? `the server is not running: ${this.error ?? "it failed to start"}`
          : "the server is still starting",
      );
    const p = (params ?? {}) as Record<string, unknown>;
    const id = () => {
      if (typeof p.id !== "string" || !PROJECT_ID.test(p.id))
        throw new Error("invalid animation id");
      return p.id;
    };
    switch (method) {
      case "listAnimations":
        return studio.listAnimations();
      case "animation":
        return studio.animation(id());
      case "thumbnail":
        return studio.thumbnail(id());
      case "preview":
        return studio.preview(id());
      case "exportVideo": {
        const format = FORMATS.find((f) => f === p.format);
        if (format === undefined) throw new Error("invalid export format");
        return studio.exportVideo(id(), format);
      }
      case "exportProgress":
        return studio.exportProgress(id()) ?? null;
      case "exportResult":
        if (typeof p.jobId !== "string" || p.jobId.length > 200) throw new Error("invalid job id");
        return studio.exportResult(p.jobId);
      case "markWelcomeSeen":
        await studio.markWelcomeSeen();
        return null;
      case "welcomeSeen":
        return studio.welcomeSeen();
      default:
        throw new Error(`unknown method '${String(method)}'`);
    }
  }

  /** Stops watching, saves the log, stops the server and removes the endpoint file. Idempotent. */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    await this.ready;
    this.studio?.close();
    await this.activity?.flush();
    await this.server?.close();
    const file = endpointFile(this.init.dataDir);
    try {
      // Only our own record: another instance may have taken the file since.
      const written = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown };
      if (written.pid === process.pid) await rm(file, { force: true });
    } catch {
      // No file, or not ours to remove.
    }
  }
}
