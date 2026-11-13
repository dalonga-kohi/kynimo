import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { KynimoService, RunningServer } from "@kynimo/mcp/local";
import type {
  AnimationActivity,
  AnimationDetail,
  AnimationLayerRow,
  AnimationSummary,
  ExportFormat,
  StudioStatus,
} from "../shared/api.js";
import type { ExportResultReply, ExportStartResult, FileResult } from "../shared/protocol.js";
import type { ActivityLog } from "./activity.js";
import { UNKNOWN_CLIENT } from "./client-label.js";
import { atomicCopy, atomicWrite, atomicWriteJson, readJson } from "./files.js";

/** What the studio uses of a running server; a real `RunningServer` fits. */
export interface StudioServer {
  endpoint?: RunningServer["endpoint"];
  port?: RunningServer["port"];
  store: Pick<RunningServer["store"], "list" | "get">;
  runtime: Pick<RunningServer["runtime"], "exportFiles">;
  service(
    actor: string,
  ): Pick<KynimoService, "renderFrames" | "exportComposition" | "getExportStatus">;
  activeJobs: RunningServer["activeJobs"];
}

type ProjectState = NonNullable<Awaited<ReturnType<StudioServer["store"]["get"]>>>;
type Doc = ProjectState["doc"];

export interface StudioOptions {
  server: StudioServer;
  activity: ActivityLog;
  now: () => number;
  /** Thumbnails and previews live under here, in `thumbs` and `previews`. */
  cacheDir: string;
  dataDir: string;
  /** How the data folder reads on screen. Default: the real path. */
  projectsDir?: string;
  settingsFile: string;
  /** Wait before a change event goes out. Default 300 ms. */
  debounceMs?: number;
}

/** The actor the studio's own renders and exports run as. */
export const STUDIO_ACTOR = "desktop";

export const THUMBNAIL_WIDTH = 832;
/** Fraction of the duration the thumbnail frame sits at. */
export const THUMBNAIL_AT = 0.4;
/** A frame or contact-sheet render this recent means the agent is checking its work. */
export const CHECKING_MS = 20_000;
export const POLL_MS = 1000;
export const MAX_LAYER_ROWS = 12;
export const MAX_KEY_TIMES = 24;
/** Render limits of the server: longest edge of a still frame. */
const MIN_EDGE = 32;
const MAX_EDGE = 1920;
/** Longest edge of the Player preview (the whole animation, as mp4). */
const PREVIEW_MAX_EDGE = 960;
const GIF_MAX_EDGE = 960;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const exists = async (file: string): Promise<boolean> => {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** What the list needs from a document, cached per version. */
interface Core {
  name: string;
  version: number;
  durationFrames: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  layerCount: number;
  style?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function mainComposition(doc: Doc) {
  return (
    doc.compositions.find((c) => c.id === doc.mainCompositionId) ??
    doc.compositions.find((c) => c.id === "main") ??
    doc.compositions[0]
  );
}

/** Frames (in the layer's own time) of every keyframe in a layer's properties. */
function collectKeyframes(node: unknown, out: Set<number>, budget: { left: number }): void {
  if (budget.left-- <= 0) return;
  if (Array.isArray(node)) {
    for (const item of node) collectKeyframes(item, out, budget);
  } else if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "keyframes" && Array.isArray(value)) {
        for (const kf of value) if (isRecord(kf) && typeof kf.frame === "number") out.add(kf.frame);
      } else {
        collectKeyframes(value, out, budget);
      }
    }
  }
}

/**
 * What the desktop app shows and does, over a running server: the animations and what agents are
 * doing to them, their thumbnails and previews, exports. Every answer is plain JSON.
 */
export class Studio {
  private readonly startedAt: number;
  private readonly cores = new Map<string, Core>();
  private readonly listeners = new Set<() => void>();
  private signature = "";
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private thumbnailQueue: Promise<unknown> = Promise.resolve();
  private readonly thumbnails = new Map<string, Promise<FileResult>>();
  private readonly previews = new Map<string, Promise<FileResult>>();
  private closed = false;
  /** Jobs the desktop started itself (previews, exports): not an agent's activity. */
  private readonly ownJobs = new Set<string>();
  /** The export job per animation that the desktop started and has not yet seen finish. */
  private readonly exports = new Map<string, string>();

  constructor(private readonly options: StudioOptions) {
    this.startedAt = options.now();
  }

  /** Starts watching the store and the jobs, once a second. */
  start(): void {
    if (this.pollTimer !== undefined) return;
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    this.pollTimer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    if (this.emitTimer !== undefined) clearTimeout(this.emitTimer);
    this.pollTimer = undefined;
    this.emitTimer = undefined;
    this.listeners.clear();
  }

  onChanged(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Tells listeners something changed, once per `debounceMs` however often it is called. */
  notify(): void {
    if (this.closed || this.emitTimer !== undefined) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      for (const listener of this.listeners) listener();
    }, this.options.debounceMs ?? 300);
    this.emitTimer.unref();
  }

  /**
   * Reads the cheap metadata (project list, active jobs), feeds the activity log, and notifies
   * when anything the studio shows differs from the last poll.
   */
  async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const projects = await this.options.server.store.list();
      this.options.activity.observeProjects(projects);
      const now = this.options.now();
      const jobs = this.agentJobs().map(
        (j) => `${j.jobId}:${j.state}:${j.framesDone}/${j.framesTotal}`,
      );
      const checking = projects.filter((p) => this.isChecking(p.id, now)).map((p) => p.id);
      const signature = JSON.stringify([
        projects.map((p) => `${p.id}:${p.version}`),
        jobs,
        checking,
      ]);
      if (signature !== this.signature) {
        this.signature = signature;
        this.notify();
      }
    } catch {
      // The store is unreadable for a moment: the next poll tries again.
    } finally {
      this.polling = false;
    }
  }

  status(): StudioStatus {
    const { server, activity } = this.options;
    const options = this.options;
    const client = activity.latestClient();
    const first = activity.firstRequestAt;
    return {
      server: "running",
      ...(server.endpoint === undefined ? {} : { endpoint: server.endpoint }),
      ...(server.port === undefined ? {} : { port: server.port }),
      dataDir: options.dataDir,
      projectsDir: options.projectsDir ?? options.dataDir,
      ...(client === undefined ? {} : { client }),
      ...(first === undefined ? {} : { firstRequestAt: first }),
      startedAt: this.startedAt,
    };
  }

  async listAnimations(): Promise<AnimationSummary[]> {
    const metas = await this.options.server.store.list();
    const now = this.options.now();
    const live = new Set(metas.map((m) => m.id));
    for (const id of this.cores.keys()) if (!live.has(id)) this.cores.delete(id);
    const out: AnimationSummary[] = [];
    for (const meta of metas) {
      const core = await this.core(meta.id, meta.version);
      if (core !== undefined) out.push(this.summary(meta.id, core, now));
    }
    out.sort(
      (a, b) =>
        (b.updatedAt ?? Number.NEGATIVE_INFINITY) - (a.updatedAt ?? Number.NEGATIVE_INFINITY) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
    return out;
  }

  async animation(id: string): Promise<AnimationDetail | null> {
    const state = await this.options.server.store.get(id);
    if (state === undefined) return null;
    const core = this.coreOf(state);
    const comp = mainComposition(state.doc);
    if (comp === undefined) return null;
    const secs = (frames: number) => round3((frames * core.fpsDen) / core.fpsNum);
    const layers: AnimationLayerRow[] = comp.layers.slice(0, MAX_LAYER_ROWS).map((layer) => {
      const frames = new Set<number>();
      collectKeyframes(layer, frames, { left: 50_000 });
      const times = [...new Set([...frames].map((f) => secs(layer.startFrame + f)))].sort(
        (a, b) => a - b,
      );
      return {
        id: layer.id,
        name: layer.name,
        start: secs(layer.inFrame),
        end: secs(layer.outFrame),
        keyTimes: times.slice(0, MAX_KEY_TIMES),
      };
    });
    return {
      ...this.summary(id, core, this.options.now()),
      compositionId: comp.id,
      layers,
    };
  }

  /** The PNG of the current version, rendered at most one at a time. */
  thumbnail(id: string): Promise<FileResult> {
    return this.guarded(async () => {
      const core = await this.currentCore(id);
      const file = join(this.options.cacheDir, "thumbs", `${id}-v${core.version}.png`);
      if (await exists(file)) return { path: file };
      const key = `${id}-v${core.version}`;
      const running = this.thumbnails.get(key);
      if (running !== undefined) return running;
      const job = this.queueThumbnail(id, core).finally(() => this.thumbnails.delete(key));
      this.thumbnails.set(key, job);
      return job;
    });
  }

  /** The MP4 preview of the current version; one render per project at a time. */
  preview(id: string): Promise<FileResult> {
    return this.guarded(async () => {
      const core = await this.currentCore(id);
      const file = join(this.options.cacheDir, "previews", `${id}-v${core.version}.mp4`);
      if (await exists(file)) return { path: file };
      const running = this.previews.get(id);
      if (running !== undefined) return running;
      const job = this.renderPreview(id, core).finally(() => this.previews.delete(id));
      this.previews.set(id, job);
      return job;
    });
  }

  async exportVideo(id: string, format: ExportFormat): Promise<ExportStartResult> {
    try {
      const core = await this.currentCore(id);
      const longest = Math.max(core.width, core.height);
      // The most the server allows: its default would be a small gif.
      const maxSize = Math.max(
        MIN_EDGE,
        Math.min(longest, format === "gif" ? GIF_MAX_EDGE : MAX_EDGE),
      );
      const reply = await this.options.server.service(STUDIO_ACTOR).exportComposition(id, {
        format,
        max_size: maxSize,
        idempotency_key: `desktop-export-${randomUUID()}`,
      });
      this.ownJobs.add(reply.job_id);
      this.exports.set(id, reply.job_id);
      this.notify();
      return { jobId: reply.job_id };
    } catch (e) {
      return { error: message(e) };
    }
  }

  /** Progress (0 to 1) of the export the desktop started for `id`, while there is one. */
  exportProgress(id: string): { progress: number } | undefined {
    const jobId = this.exports.get(id);
    if (jobId === undefined) return undefined;
    const job = this.options.server.activeJobs().find((j) => j.jobId === jobId);
    if (job === undefined || job.framesTotal <= 0) return { progress: 0 };
    return { progress: Math.min(1, Math.max(0, round3(job.framesDone / job.framesTotal))) };
  }

  async exportResult(jobId: string): Promise<ExportResultReply> {
    try {
      const { result } = await this.options.server.service(STUDIO_ACTOR).getExportStatus(jobId, 0);
      if (result.state === "succeeded" || result.state === "failed" || result.state === "cancelled")
        this.forgetExport(jobId);
      if (result.state === "succeeded") {
        const file = this.fileOf(result.result);
        return file === undefined
          ? { state: "failed", error: "the exported file is no longer available" }
          : { state: "succeeded", file };
      }
      if (result.state === "failed")
        return { state: "failed", error: result.error?.message ?? "the export failed" };
      return { state: result.state };
    } catch (e) {
      return { state: "failed", error: message(e) };
    }
  }

  async welcomeSeen(): Promise<boolean> {
    try {
      const settings = await readJson(this.options.settingsFile);
      return isRecord(settings) && settings.welcomeSeen === true;
    } catch {
      return false;
    }
  }

  async markWelcomeSeen(): Promise<void> {
    let settings: Record<string, unknown> = {};
    try {
      const read = await readJson(this.options.settingsFile);
      if (isRecord(read)) settings = read;
    } catch {
      // A corrupt settings file is replaced.
    }
    await atomicWriteJson(this.options.settingsFile, { ...settings, welcomeSeen: true });
  }

  // ---- internals ----

  private async guarded(fn: () => Promise<FileResult>): Promise<FileResult> {
    try {
      return await fn();
    } catch (e) {
      return { error: message(e) };
    }
  }

  private coreOf(state: ProjectState): Core {
    const comp = mainComposition(state.doc);
    const core: Core = {
      name: state.doc.name,
      version: state.version,
      durationFrames: comp?.durationFrames ?? 1,
      fpsNum: comp?.fps.num ?? 30,
      fpsDen: comp?.fps.den ?? 1,
      width: comp?.width ?? 1,
      height: comp?.height ?? 1,
      layerCount: comp?.layers.length ?? 0,
      ...(state.doc.style === null ? {} : { style: state.doc.style.packId }),
    };
    this.cores.set(state.id, core);
    return core;
  }

  /** The summary core of a project at `version`, read from the store only when it changed. */
  private async core(id: string, version: number): Promise<Core | undefined> {
    const known = this.cores.get(id);
    if (known?.version === version) return known;
    const state = await this.options.server.store.get(id);
    return state === undefined ? undefined : this.coreOf(state);
  }

  private async currentCore(id: string): Promise<Core> {
    const state = await this.options.server.store.get(id);
    if (state === undefined) throw new Error(`there is no animation '${id}'`);
    return this.coreOf(state);
  }

  private summary(id: string, core: Core, now: number): AnimationSummary {
    const log = this.options.activity.project(id);
    const activity = this.activityOf(id, now);
    return {
      id,
      name: core.name,
      version: core.version,
      durationSec: round3((core.durationFrames * core.fpsDen) / core.fpsNum),
      width: core.width,
      height: core.height,
      fps: round3(core.fpsNum / core.fpsDen),
      layerCount: core.layerCount,
      ...(core.style === undefined ? {} : { style: core.style }),
      ...(log?.createdBy === undefined ? {} : { createdBy: log.createdBy }),
      ...(log?.createdAt === undefined ? {} : { createdAt: log.createdAt }),
      ...(log?.updatedAt === undefined ? {} : { updatedAt: log.updatedAt }),
      ...(activity === undefined ? {} : { activity }),
    };
  }

  private forgetExport(jobId: string): void {
    this.ownJobs.delete(jobId);
    for (const [id, job] of this.exports) if (job === jobId) this.exports.delete(id);
  }

  /** Active jobs an agent started: the desktop's own previews and exports are left out. */
  private agentJobs() {
    return this.options.server.activeJobs().filter((j) => !this.ownJobs.has(j.jobId));
  }

  private isChecking(id: string, now: number): boolean {
    const at = this.options.activity.project(id)?.lastCheckAt;
    return at !== undefined && now - at <= CHECKING_MS && now - at >= -CHECKING_MS;
  }

  private activityOf(id: string, now: number): AnimationActivity | undefined {
    const jobs = this.agentJobs().filter((j) => j.projectId === id);
    const job = jobs.find((j) => j.state === "running") ?? jobs[0];
    if (job !== undefined) {
      const progress = job.framesTotal > 0 ? job.framesDone / job.framesTotal : 0;
      return { kind: "rendering", progress: Math.min(1, Math.max(0, round3(progress))) };
    }
    if (this.isChecking(id, now))
      return {
        kind: "checking",
        client: this.options.activity.project(id)?.lastClient ?? UNKNOWN_CLIENT,
      };
    return undefined;
  }

  private queueThumbnail(id: string, core: Core): Promise<FileResult> {
    const run = async (): Promise<FileResult> => {
      try {
        const frame = Math.min(
          core.durationFrames - 1,
          Math.max(0, Math.round(core.durationFrames * THUMBNAIL_AT)),
        );
        // max_size is the longest edge; the thumbnail is THUMBNAIL_WIDTH wide.
        const longest = Math.round(
          (THUMBNAIL_WIDTH * Math.max(core.width, core.height)) / core.width,
        );
        const reply = await this.options.server.service(STUDIO_ACTOR).renderFrames(id, {
          frames: [frame],
          max_size: Math.min(MAX_EDGE, Math.max(MIN_EDGE, longest)),
        });
        const png = reply.images[0];
        if (png === undefined) return { error: "the renderer returned no frame" };
        const dir = join(this.options.cacheDir, "thumbs");
        const file = join(dir, `${id}-v${reply.result.version}.png`);
        await atomicWrite(file, png);
        await this.dropOldVersions(dir, id, file);
        return { path: file };
      } catch (e) {
        return { error: message(e) };
      }
    };
    const next = this.thumbnailQueue.then(run, run);
    this.thumbnailQueue = next;
    return next;
  }

  private async renderPreview(id: string, core: Core): Promise<FileResult> {
    const svc = this.options.server.service(STUDIO_ACTOR);
    const longest = Math.max(core.width, core.height);
    const reply = await svc.exportComposition(id, {
      format: "mp4",
      max_size: Math.max(MIN_EDGE, Math.min(longest, PREVIEW_MAX_EDGE)),
      idempotency_key: `desktop-preview-${randomUUID()}`,
    });
    this.ownJobs.add(reply.job_id);
    try {
      for (;;) {
        const { result } = await svc.getExportStatus(reply.job_id, 2);
        if (result.state === "queued" || result.state === "running") continue;
        if (result.state !== "succeeded")
          return { error: result.error?.message ?? `the preview ${result.state}` };
        const source = this.fileOf(result.result);
        if (source === undefined) return { error: "the preview file is no longer available" };
        const dir = join(this.options.cacheDir, "previews");
        const file = join(dir, `${id}-v${result.result?.version ?? core.version}.mp4`);
        // Exports expire; the cached copy does not.
        await atomicCopy(source, file);
        await this.dropOldVersions(dir, id, file);
        return { path: file };
      }
    } finally {
      this.ownJobs.delete(reply.job_id);
    }
  }

  /** The file a finished job made: its local path, or the file behind its download token. */
  private fileOf(result: { path?: string; url?: string } | undefined): string | undefined {
    if (result?.path !== undefined) return result.path;
    const token = result?.url?.split("/").pop();
    if (token === undefined || token === "") return undefined;
    return this.options.server.runtime.exportFiles?.lookup(token)?.file;
  }

  private async dropOldVersions(dir: string, id: string, keep: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const file = join(dir, name);
      if (file !== keep && name.startsWith(`${id}-v`) && !name.endsWith(".tmp"))
        await rm(file, { force: true });
    }
  }
}
