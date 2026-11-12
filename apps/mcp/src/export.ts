import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportSession } from "@kynimo/capture";
import type { Asset, Composition, Project } from "@kynimo/scene";
import { mixAudio, planAudio } from "./audio-mix.js";
import {
  EXPORT_CONTENT_TYPES,
  type ExportFiles,
  type ExportFormat,
  type SavedExport,
} from "./export-files.js";
import { fingerprint } from "./hash.js";
import type { JobContext, JobError, JobPhase, JobState } from "./jobs.js";
import type { Encoder, MediaTools } from "./media.js";
import {
  aggregateReports,
  type FrameRenderer,
  RENDER_LIMITS,
  type RenderMedia,
  sampleFrames,
} from "./render.js";

/** Declared limits of the export tools (ADR-0048); stated in their input schemas. */
export const EXPORT_LIMITS = {
  /** Longest edge of an mp4 or webm. */
  maxSize: 1920,
  minSize: 32,
  /** Longest mp4 or webm, in seconds. */
  maxSeconds: 60,
  gifMaxSize: 960,
  gifDefaultSize: 480,
  gifMaxSeconds: 15,
  previewMaxSize: 480,
  previewDefaultSize: 360,
  previewMaxSeconds: 10,
  previewSheetCells: 6,
  previewSheetCellSize: 160,
  previewSheetColumns: 3,
} as const;

export type ExportKind = "export" | "preview";

/** What a validated export request asks for. */
export interface ExportPlan {
  kind: ExportKind;
  project: { id: string; version: number; doc: Project };
  comp: Composition;
  format: ExportFormat;
  from: number;
  to: number;
  /** The output size (`fitSize` of the composition at the request's `max_size`). */
  width: number;
  height: number;
  maxSize: number;
}

export interface FidelityEntry {
  kind: "dropped" | "flattened" | "approximated";
  feature: string;
  detail: string;
  /** At most {@link FIDELITY_LAYERS} layer ids. */
  layers?: string[];
}

export const FIDELITY_LAYERS = 5;
export const MAX_RANGES = 20;

export interface FrameRange {
  from: number;
  to: number;
}

/** A renderer report entry with consecutive frames merged into ranges. */
export type RangedReport<T> = Omit<T, "frames"> & { ranges: FrameRange[]; more_ranges?: number };

export interface ExportResult {
  format: ExportFormat;
  composition: string;
  version: number;
  from_frame: number;
  to_frame: number;
  frames: number;
  width: number;
  height: number;
  fps: { num: number; den: number };
  duration_seconds: number;
  bytes: number;
  content_type: string;
  url?: string;
  path?: string;
  expires_at: string;
  audio_layers: string[];
  cached: boolean;
  /** Frames not redrawn because they equal the previous frame. */
  repeated_frames: number;
  /** Wall time of the job, in seconds. */
  render_seconds: number;
  fidelity: FidelityEntry[];
  skipped: RangedReport<{ layer: string; type: string; reason: string }>[];
  warnings: RangedReport<{
    layer: string;
    kind: string;
    message: string;
    codepoints: number[];
  }>[];
  /** Preview only: a contact sheet of the clip (PNG); sent as image content, never as structured output. */
  sheet?: Uint8Array;
}

export interface JobReply {
  job_id: string;
  kind: ExportKind;
  project_id: string;
  state: JobState;
  progress: { phase: JobPhase; frames_done: number; frames_total: number };
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  replayed?: boolean;
  result?: Omit<ExportResult, "sheet">;
  error?: JobError;
}

/** Consecutive frames merged: [3, 4, 5, 9] gives [{3, 5}, {9, 9}]. Input is sorted and unique. */
export function toRanges(frames: readonly number[]): FrameRange[] {
  const out: FrameRange[] = [];
  for (const f of frames) {
    const last = out[out.length - 1];
    if (last !== undefined && f === last.to + 1) last.to = f;
    else out.push({ from: f, to: f });
  }
  return out;
}

function ranged<T extends { frames: number[] }>(entry: T): RangedReport<T> {
  const { frames, ...rest } = entry;
  const all = toRanges([...frames].sort((a, b) => a - b));
  return {
    ...rest,
    ranges: all.slice(0, MAX_RANGES),
    ...(all.length > MAX_RANGES ? { more_ranges: all.length - MAX_RANGES } : {}),
  };
}

const MAX_SECONDS = (kind: ExportKind, format: ExportFormat) =>
  kind === "preview"
    ? EXPORT_LIMITS.previewMaxSeconds
    : format === "gif"
      ? EXPORT_LIMITS.gifMaxSeconds
      : EXPORT_LIMITS.maxSeconds;

/** Most frames a clip of this kind and format may have at the composition's rate. */
export function maxFrames(kind: ExportKind, format: ExportFormat, fps: Composition["fps"]): number {
  return Math.max(1, Math.floor((MAX_SECONDS(kind, format) * fps.num) / fps.den));
}

/** "an mp4 export", "a preview clip": how messages name what is being made. */
export function clipLabel(kind: ExportKind, format: ExportFormat): string {
  return kind === "preview"
    ? "a preview clip"
    : `${format === "mp4" ? "an" : "a"} ${format} export`;
}

/** The duration check as exact integers; the message names the limit and a `to_frame` that fits. */
export function durationError(
  kind: ExportKind,
  format: ExportFormat,
  fps: Composition["fps"],
  from: number,
  to: number,
): string | undefined {
  const seconds = MAX_SECONDS(kind, format);
  if ((to - from + 1) * fps.den <= seconds * fps.num) return undefined;
  const most = maxFrames(kind, format, fps);
  const rate = fps.den === 1 ? `${fps.num}` : `${fps.num}/${fps.den}`;
  return `${clipLabel(kind, format)} may be at most ${seconds} s (${most} frames at ${rate} fps); use to_frame ${from + most - 1} or less, or export in parts`;
}

/** The longest edge a request may ask for, and the one it gets when it asks for nothing. */
export function sizeLimits(
  kind: ExportKind,
  format: ExportFormat,
  comp: Pick<Composition, "width" | "height">,
): { max: number; default: number } {
  const longest = Math.max(comp.width, comp.height);
  if (kind === "preview")
    return {
      max: EXPORT_LIMITS.previewMaxSize,
      default: Math.min(longest, EXPORT_LIMITS.previewDefaultSize),
    };
  if (format === "gif")
    return {
      max: EXPORT_LIMITS.gifMaxSize,
      default: Math.min(longest, EXPORT_LIMITS.gifDefaultSize),
    };
  return { max: EXPORT_LIMITS.maxSize, default: Math.min(longest, EXPORT_LIMITS.maxSize) };
}

const translucent = (background: string | null): boolean =>
  background === null || (/^#[0-9a-f]{8}$/i.test(background) && background.slice(7) !== "ff");

/** What the chosen format could not carry, sorted by kind then feature. */
export function fidelityReport(o: {
  format: ExportFormat;
  comp: Pick<Composition, "background" | "fps">;
  width: number;
  height: number;
  audio: { playing: string[]; nested: string[]; clipped: number; mixed: string[] };
}): FidelityEntry[] {
  const { format, comp } = o;
  const out: FidelityEntry[] = [];
  const ids = (list: string[]) => ({ layers: list.slice(0, FIDELITY_LAYERS) });
  if (format !== "webm" && translucent(comp.background))
    out.push({
      kind: "flattened",
      feature: "transparency",
      detail:
        "transparent areas are composited over black; export webm to keep transparency, or give the composition an opaque background",
    });
  if (format === "gif" && o.audio.playing.length > 0)
    out.push({
      kind: "dropped",
      feature: "audio",
      detail: "GIF has no sound; export mp4 or webm to keep it",
      ...ids(o.audio.playing),
    });
  if (o.audio.nested.length > 0)
    out.push({
      kind: "dropped",
      feature: "nested-audio",
      detail:
        "audio layers inside precomps are not mixed yet; move them into the exported composition",
      ...ids(o.audio.nested),
    });
  if (o.audio.clipped > 0)
    out.push({
      kind: "approximated",
      feature: "audio-clipping",
      detail: `the mix went over full scale in ${o.audio.clipped} sample values and was clipped; lower the layers' volume`,
      ...ids(o.audio.mixed),
    });
  if (format === "mp4" && (o.width % 2 !== 0 || o.height % 2 !== 0))
    out.push({
      kind: "approximated",
      feature: "even-size",
      detail: "padded with 1 px of black to an even size, which H.264 needs",
    });
  if (format === "gif") {
    out.push({
      kind: "approximated",
      feature: "gif-palette",
      detail: "colors are reduced to a 256-color palette with dithering",
    });
    if ((100 * comp.fps.den) % comp.fps.num !== 0)
      out.push({
        kind: "approximated",
        feature: "gif-timing",
        detail: "GIF frame delays are whole hundredths of a second, so frame timing is rounded",
      });
  }
  return out.sort(
    (a, b) => a.kind.localeCompare(b.kind, "en") || a.feature.localeCompare(b.feature, "en"),
  );
}

export interface CachedExport {
  result: ExportResult;
  token: string;
}

/** Everything a job needs from the service; the service owns validation, storage and errors. */
export interface ExportDeps {
  renderer: FrameRenderer;
  media: MediaTools;
  files: ExportFiles;
  /** Runs the renderer, turning its failures into tool errors. */
  draw<T>(fn: () => Promise<T>): Promise<T>;
  /** Image and font bytes the frames draw; no video frames (those load per frame). */
  stillAssets(doc: Project, composition: string, frames: readonly number[]): Promise<RenderMedia>;
  /** The video frames one frame shows. */
  videoFrames(
    doc: Project,
    composition: string,
    frame: number,
  ): Promise<ReadonlyMap<string, Uint8Array>>;
  /** Everything the frames draw, video frames included (for the preview's contact sheet). */
  allAssets(doc: Project, composition: string, frames: readonly number[]): Promise<RenderMedia>;
  /** The stored bytes of an audio asset. */
  audioBytes(asset: Extract<Asset, { type: "audio" }>): Promise<Uint8Array>;
  /** The download link and local path of a saved file. */
  link(saved: SavedExport): { url?: string; path?: string };
  /** Finished results by content; at most {@link EXPORT_CACHE_ENTRIES}. */
  cache: Map<string, CachedExport>;
}

export const EXPORT_CACHE_ENTRIES = 256;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The body of an export or preview job: mixes the audio, draws the frames through an export
 * session, pipes them to the encoder and stores the file. Always closes the session, stops the
 * encoder and removes its temp directory, whatever happens.
 */
export async function runExport(
  plan: ExportPlan,
  deps: ExportDeps,
  ctx: JobContext,
): Promise<ExportResult> {
  // Wall-clock time is fine here: it only reports how long the job took and is not part of
  // evaluation or any render path.
  const started = Date.now();
  const { project, comp, format, from, to, kind } = plan;
  const doc = project.doc;
  const frameCount = to - from + 1;
  const flatten = format !== "webm";
  const seconds = () => round3((Date.now() - started) / 1000);

  const build = await deps.draw(() => deps.renderer.build());
  const ffmpeg = await deps.media.version();
  const key = fingerprint([
    "export",
    kind,
    project.id,
    fingerprint(doc),
    comp.id,
    format,
    from,
    to,
    plan.width,
    plan.height,
    build,
    ffmpeg,
  ]);
  const hit = deps.cache.get(key);
  if (hit !== undefined) {
    const stillThere = deps.files.lookup(hit.token) !== undefined;
    if (stillThere && (kind === "export" || frameCount < 2 || hit.result.sheet !== undefined))
      return { ...hit.result, cached: true, render_seconds: seconds() };
    deps.cache.delete(key);
  }

  const dir = await mkdtemp(join(tmpdir(), "kynimo-export-"));
  // The encoder is stopped on a cancel and on any failure, so FFmpeg never waits on a dead job.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (ctx.signal.aborted) stop.abort();
  else ctx.signal.addEventListener("abort", onAbort, { once: true });
  let session: ExportSession | undefined;
  let finished = false;
  try {
    // Audio (mp4 and webm); a gif only reports what it drops.
    const audio = planAudio(doc, comp.id, from, to);
    let audioFile: string | null = null;
    let mix = { clipped: 0, mixed: [] as string[] };
    if (format !== "gif" && audio.layers.length > 0) {
      const pcm = new Map<string, Float32Array>();
      for (const { assetId } of audio.layers) {
        if (pcm.has(assetId)) continue;
        const asset = doc.assets.find((a) => a.id === assetId);
        if (asset?.type !== "audio")
          throw new Error(`audio layer asset '${assetId}' is not an audio asset of this project`);
        const bytes = await deps.audioBytes(asset);
        pcm.set(
          assetId,
          await deps.media.decodePcm(bytes, Math.ceil(asset.durationMs * 48) + 48_000),
        );
      }
      const mixed = mixAudio(doc, comp.id, from, to, pcm);
      mix = { clipped: mixed.clipped, mixed: mixed.mixed };
      if (mixed.mixed.length > 0) {
        audioFile = join(dir, "audio.f32");
        const { samples } = mixed;
        await writeFile(
          audioFile,
          Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
        );
      }
    }

    const out = join(dir, `out.${format}`);
    const encoder: Encoder = deps.media.encode({
      format,
      width: plan.width,
      height: plan.height,
      fps: comp.fps,
      frameCount,
      audio: audioFile,
      flatten,
      out,
      signal: stop.signal,
    });

    const frames = Array.from({ length: frameCount }, (_, i) => from + i);
    const still = await deps.stillAssets(doc, comp.id, frames);
    session = await deps.draw(() =>
      deps.renderer.openExport(
        doc,
        comp.id,
        plan.maxSize,
        still.assets,
        flatten ? "premultiplied" : "straight",
      ),
    );
    const reports: Parameters<typeof aggregateReports>[0][number][] = [];
    let repeated = 0;
    for (let n = from; n <= to; n++) {
      if (ctx.signal.aborted) throw new Error("the export was cancelled");
      const videoFrames = await deps.videoFrames(doc, comp.id, n);
      const open = session;
      const f = await deps.draw(() => open.frame(n, videoFrames));
      if (f.width !== plan.width || f.height !== plan.height)
        throw new Error(
          `frame ${n} came back ${f.width}×${f.height}, not the planned ${plan.width}×${plan.height}`,
        );
      await encoder.write(f.rgba);
      if (f.repeated) repeated++;
      if (f.skipped.length > 0 || f.warnings.length > 0)
        reports.push({ frame: n, skipped: f.skipped, warnings: f.warnings });
      ctx.progress({ frames_done: n - from + 1 });
    }
    await session.close();
    session = undefined;

    if (ctx.signal.aborted) throw new Error("the export was cancelled");
    ctx.progress({ phase: "encoding" });
    await encoder.finish();
    finished = true;
    ctx.progress({ phase: "storing" });
    const saved = await deps.files.save(out, ctx.id, format);

    let sheet: Uint8Array | undefined;
    if (kind === "preview" && frameCount >= 2) {
      const cells = sampleFrames(from, to, Math.min(EXPORT_LIMITS.previewSheetCells, frameCount));
      const media = await deps.allAssets(doc, comp.id, cells);
      const captured = await deps.draw(() =>
        deps.renderer.sheet(
          doc,
          comp.id,
          cells,
          {
            maxSize: EXPORT_LIMITS.previewSheetCellSize,
            columns: EXPORT_LIMITS.previewSheetColumns,
            gap: RENDER_LIMITS.sheetGap,
          },
          media,
        ),
      );
      sheet = captured.png;
    }

    const aggregated = aggregateReports(reports);
    const result: ExportResult = {
      format,
      composition: comp.id,
      version: project.version,
      from_frame: from,
      to_frame: to,
      frames: frameCount,
      width: plan.width,
      height: plan.height,
      fps: { num: comp.fps.num, den: comp.fps.den },
      duration_seconds: round3((frameCount * comp.fps.den) / comp.fps.num),
      bytes: saved.bytes,
      content_type: EXPORT_CONTENT_TYPES[format],
      ...deps.link(saved),
      expires_at: new Date(saved.expiresAt).toISOString(),
      audio_layers: mix.mixed,
      cached: false,
      repeated_frames: repeated,
      render_seconds: seconds(),
      fidelity: fidelityReport({
        format,
        comp,
        width: plan.width,
        height: plan.height,
        audio: {
          playing: audio.layers.map((l) => l.id),
          nested: audio.nested.map((l) => l.id),
          clipped: mix.clipped,
          mixed: mix.mixed,
        },
      }),
      skipped: aggregated.skipped.map(ranged),
      warnings: aggregated.warnings.map(ranged),
      ...(sheet === undefined ? {} : { sheet }),
    };
    deps.cache.set(key, { result, token: saved.token });
    for (const oldest of deps.cache.keys()) {
      if (deps.cache.size <= EXPORT_CACHE_ENTRIES) break;
      deps.cache.delete(oldest);
    }
    return result;
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    if (!finished) stop.abort();
    await session?.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
