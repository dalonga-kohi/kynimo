import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapturedFrame, type CapturedSheet, fitSize, sheetSize } from "@kynimo/capture";
import { evaluateFrame, type ResolvedComposition } from "@kynimo/engine";
import { IntentError } from "@kynimo/intent";
import {
  AssetInfoError,
  readFontInfo,
  readImageInfo,
  sniffFontFormat,
  sniffImageFormat,
  videoFrameKey,
} from "@kynimo/renderer";
import {
  type Asset,
  applyBatch,
  type Change,
  type Composition,
  type Layer,
  LayerSelectorSchema,
  MAX_COMPOSITION_SIZE,
  matchLayers,
  type Op,
  type OpError,
  type Project,
  ProjectSchema,
  redo,
  SCENE_FORMAT_VERSION,
  type SceneState,
  type StepResult,
  undo,
} from "@kynimo/scene";
import { type ExpandError, expandScript, type ScriptLimits } from "@kynimo/script";
import type { z } from "zod";
import { type BlobStore, blobKey, isBlobKey, MAX_ASSET_BYTES } from "./blobs.js";
import { fingerprint } from "./hash.js";
import { MediaError, type MediaTools, type Rational } from "./media.js";
import { describeMotion, type MotionDescription } from "./motion.js";
import {
  aggregateReports,
  type FrameRenderer,
  RENDER_LIMITS,
  RenderCache,
  type RenderMedia,
  type SkippedReport,
  sampleFrames,
  type WarningReport,
} from "./render.js";
import {
  type KeyLookup,
  newProjectId,
  type ProjectMeta,
  type ProjectState,
  type ProjectStore,
  type Stacks,
  type Step,
  type WriteOutcome,
  type WriteRecord,
  type WriteResult,
} from "./store.js";
import { type CompositionSummary, summarizeComposition } from "./summary.js";

/** A layer selector as callers send it; parsed (and branded) here. */
type SelectorInput = z.input<typeof LayerSelectorSchema>;

/** A tool-level failure. The server turns it into an MCP error result. */
export class ToolError extends Error {
  constructor(
    readonly kind:
      | "invalid"
      | "conflict"
      | "empty"
      | "not_found"
      | "key_reused"
      | "key_expired"
      | "render_failed"
      | "unavailable",
    message: string,
    readonly errors: OpError[] = [],
    readonly currentVersion?: number,
    /** Extra fields for the error body (the expanded operations of a rejected intent call). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface WriteMeta {
  project_id: string;
  base_version: number;
  idempotency_key: string;
}

export type Write = { kind: "ops"; ops: unknown } | { kind: "undo" } | { kind: "redo" };

export interface WriteReply extends WriteResult {
  /** True when this call returned the stored result of an earlier call with the same key. */
  replayed: boolean;
}

/** What an intent expands to: the operations, and what the tool resolved its input to. */
export interface IntentExpansion {
  ops: Op[];
  resolved?: object;
}

/** What an intent tool answers: the write result plus the operations it expanded to. */
export interface IntentReply extends WriteReply {
  /** True when nothing was written (`dry_run`). */
  dry_run?: boolean;
  /** Absent on an idempotent replay: only the write result is stored. */
  ops?: Op[];
  resolved?: object;
}

export interface CreateProjectInput {
  name: string;
  idempotency_key: string;
  width: number;
  height: number;
  fps: { num: number; den: number };
  duration_frames: number;
  background: string | null;
}

export type OutcomeReply =
  | { status: "applied"; version: number; result: WriteResult }
  | {
      status: "rejected";
      kind: string;
      message: string;
      errors: OpError[];
      current_version?: number;
    }
  | { status: "expired" | "unknown" };

const toState = (p: ProjectState): SceneState => ({
  doc: p.doc,
  idCounter: p.idCounter,
  history: new Map(Object.entries(p.history)),
});

const fromHistory = (history: SceneState["history"]): Record<string, Stacks> =>
  Object.fromEntries(
    [...history].map(([actor, s]) => [
      actor,
      { undo: s.undo.map((b) => [...b]), redo: s.redo.map((b) => [...b]) },
    ]),
  );

function summarizeChanges(projectId: string, version: number, changes: Change[]): WriteResult {
  const added = new Set<string>();
  const removed = new Set<string>();
  const changed = new Set<string>();
  const markersAdded = new Set<string>();
  const markersRemoved = new Set<string>();
  const compsAdded = new Set<string>();
  const compsRemoved = new Set<string>();
  const assetsAdded = new Set<string>();
  const assetsRemoved = new Set<string>();
  for (const c of changes) {
    if (c.type === "asset.insert") {
      if (!assetsRemoved.delete(c.assetId)) assetsAdded.add(c.assetId);
    } else if (c.type === "asset.remove") {
      if (!assetsAdded.delete(c.assetId)) assetsRemoved.add(c.assetId);
    } else if (c.type === "composition.insert") {
      if (!compsRemoved.delete(c.compositionId)) compsAdded.add(c.compositionId);
    } else if (c.type === "composition.remove") {
      if (!compsAdded.delete(c.compositionId)) compsRemoved.add(c.compositionId);
    } else if (c.type === "layer.insert") {
      if (removed.delete(c.layerId)) changed.add(c.layerId);
      else added.add(c.layerId);
    } else if (c.type === "layer.remove") {
      if (!added.delete(c.layerId)) removed.add(c.layerId);
      changed.delete(c.layerId);
    } else if (c.type === "marker.insert") markersAdded.add(c.markerId);
    else if (c.type === "marker.remove") {
      if (!markersAdded.delete(c.markerId)) markersRemoved.add(c.markerId);
    } else if (!added.has(c.layerId)) changed.add(c.layerId);
  }
  return {
    project_id: projectId,
    version,
    changed: changes.length > 0,
    layers_added: [...added],
    layers_removed: [...removed],
    layers_changed: [...changed],
    markers_added: [...markersAdded],
    markers_removed: [...markersRemoved],
    compositions_added: [...compsAdded],
    compositions_removed: [...compsRemoved],
    assets_added: [...assetsAdded],
    assets_removed: [...assetsRemoved],
  };
}

const notFound = (projectId: string) =>
  new ToolError(
    "not_found",
    `project '${projectId}' does not exist; list_projects shows the available ids`,
  );

const staleMessage = (base: number, current: number) =>
  `base_version ${base} is stale: the project is at version ${current}. Read it again (get_scene) and rebuild the request with base_version ${current} and a new idempotency_key`;

const staleVersion = (base: number, current: number) =>
  new ToolError(
    "conflict",
    staleMessage(base, current),
    [{ path: ["base_version"], message: `expected ${current}` }],
    current,
  );

const rejectionError = (o: Extract<WriteOutcome, { status: "rejected" }>) =>
  new ToolError(o.kind, o.message, o.errors, o.currentVersion);

/** Maps a document path from the generated project back to the create_project field. */
const CREATE_FIELDS: Record<string, string> = { durationFrames: "duration_frames" };
const seg = (s: PropertyKey): string | number => (typeof s === "number" ? s : String(s));
function inputPath(path: readonly PropertyKey[]): (string | number)[] {
  const [first, , field] = path;
  if (first === "compositions" && typeof field === "string")
    return [CREATE_FIELDS[field] ?? field, ...path.slice(3).map(seg)];
  return path.map(seg);
}

/**
 * What an earlier use of this key means for a new request: its stored result to replay, an error,
 * or undefined when the key is new.
 */
async function previousUse<T>(
  seen: KeyLookup,
  key: string,
  print: string,
  tool: string,
  replay: (o: Extract<WriteOutcome, { status: "applied" }>) => T,
): Promise<T | ToolError | undefined> {
  if (seen.status === "unknown") return undefined;
  if (seen.status === "expired")
    return new ToolError(
      "key_expired",
      `idempotency_key '${key}' was used too long ago for its outcome to be kept, so this ${tool} might already have been applied; check the current state and send it again with a new key`,
    );
  if (seen.record.fingerprint !== print)
    return new ToolError(
      "key_reused",
      tool === "create_project"
        ? `idempotency_key '${key}' was already used for a different create_project request; use a new key`
        : `idempotency_key '${key}' was already used for a different request on this project; use a new key`,
    );
  const o = seen.record.outcome;
  return o.status === "rejected" ? rejectionError(o) : replay(o);
}

const EXPANSION_REJECTED_FRESH =
  "the operations this call expands to were rejected; nothing was applied. See expanded_ops and errors";
const EXPANSION_REJECTED_REPLAYED =
  "the operations this call expanded to were rejected; nothing was applied. See errors";

/** `["ops", i, ...]` paths of a batch rejection, renamed for the operations an intent call expanded to. */
const expandedPaths = (errors: OpError[]): OpError[] =>
  errors.map((e) =>
    e.path[0] === "ops" ? { ...e, path: ["expanded_ops", ...e.path.slice(1)] } : e,
  );

/** A failed script as the tool error an agent can act on: where in the source or which call. */
function scriptFault(e: ExpandError): ToolError {
  if (e.kind === "invalid") {
    return new ToolError("invalid", e.message, e.errors, undefined, {
      script_error: {
        kind: e.kind,
        entry: e.entry,
        ...(e.line === undefined ? {} : { line: e.line }),
      },
      ...(e.ops === undefined ? {} : { expanded_ops: e.ops }),
    });
  }
  if (e.kind === "too_many_ops" || e.kind === "too_many_intent_calls") {
    return new ToolError(
      "invalid",
      e.message,
      [{ path: ["source"], message: e.message }],
      undefined,
      { script_error: { kind: e.kind } },
    );
  }
  return new ToolError(
    "invalid",
    e.message,
    [{ path: ["source"], message: e.message }],
    undefined,
    {
      script_error: {
        kind: e.kind,
        ...(e.line === undefined ? {} : { line: e.line }),
        ...(e.column === undefined ? {} : { column: e.column }),
      },
    },
  );
}

/** Throws a ToolError value; returns anything else. */
function unwrap<T>(value: T | ToolError): T {
  if (value instanceof ToolError) throw value;
  return value;
}

export interface ServiceOptions {
  makeId?: () => string;
  /** Draws frames for the render tools; without one they answer `unavailable`. */
  renderer?: FrameRenderer;
  /** Bytes the render cache may hold. Default 256 MB. */
  renderCacheBytes?: number;
  /** Where asset bytes live; without one `upload_asset` answers `unavailable`. */
  blobs?: BlobStore;
  /** Why there is no blob store, for the `unavailable` message. */
  blobsUnavailable?: string;
  /** Asset bytes kept in memory for renders. Default 128 MB. */
  assetCacheBytes?: number;
  /** Decodes video and audio uploads; without it they answer `unavailable`. */
  media?: MediaTools;
  /** Why there is no media decoder, for the `unavailable` message. */
  mediaUnavailable?: string;
  /** Override of RENDER_LIMITS.maxAssetBytes, for tests. */
  maxRenderAssetBytes?: number;
  /** Overrides of SCRIPT_LIMITS, for tests. */
  scriptLimits?: Partial<ScriptLimits>;
}

/** Uploads FFmpeg decodes at once; the rest wait their turn. */
export const MEDIA_CONCURRENCY = 2;

/** Scripts expanded at once, server-wide; each runs a worker thread and a replay on this thread. */
export const SCRIPT_CONCURRENCY = 2;

/** A counting semaphore. */
class Slots {
  private free: number;
  private readonly waiting: (() => void)[] = [];
  constructor(size: number) {
    this.free = size;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/** Largest file `upload_asset` takes, decoded (ADR-0031). */
export const MAX_UPLOAD_BYTES = MAX_ASSET_BYTES;

export interface UploadAssetInput {
  name: string;
  /** The file, base64-encoded. */
  data: string;
  id?: string | undefined;
  /** Font family override; default: the family the file names. */
  family?: string | undefined;
}

export interface AssetSummary {
  id: string;
  name: string;
  type: Asset["type"];
  sha256: string;
  width?: number;
  height?: number;
  family?: string;
  weight?: { min: number; max: number };
  fps?: { num: number; den: number };
  frame_count?: number;
  duration_ms?: number;
  /** Layers that use it (for a font: text layers of its family), up to 20. */
  used_by: string[];
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes strict base64 (whitespace allowed), refusing anything Buffer would silently skip. */
function decodeBase64(data: string): Uint8Array {
  const compact = data.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !BASE64.test(compact))
    throw new ToolError("invalid", "data is not valid base64", [
      { path: ["data"], message: "must be standard base64 (A-Z a-z 0-9 + /, = padding)" },
    ]);
  if ((compact.length / 4) * 3 > MAX_UPLOAD_BYTES + 3) throw tooLarge();
  return new Uint8Array(Buffer.from(compact, "base64"));
}

const tooLarge = () =>
  new ToolError("invalid", `files may be at most ${MAX_UPLOAD_BYTES} bytes (8 MB) decoded`, [
    { path: ["data"], message: `at most ${MAX_UPLOAD_BYTES} bytes decoded` },
  ]);

/**
 * Rejections of the generated addAsset op, with paths in upload_asset's own fields: `id`,
 * `name` and `family` as given, anything else derived from the file (`data`).
 */
function uploadError(e: ToolError): ToolError {
  const field = (path: (string | number)[]): (string | number)[] => {
    const [root, a, b, c] = path;
    const key =
      root === "ops" && typeof a === "number"
        ? b === "asset"
          ? c
          : b
        : root === "doc" && a === "assets"
          ? c
          : undefined;
    if (key === undefined)
      return root === "ops" && typeof a === "number" && b === "asset" ? ["data"] : path;
    return key === "id" || key === "name" || key === "family" ? [key] : ["data"];
  };
  return new ToolError(
    e.kind,
    "the asset was rejected; nothing was added to the project. Fix the listed fields and retry with a new idempotency_key",
    e.errors.map((err) => ({ ...err, path: field(err.path) })),
    e.currentVersion,
  );
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Containers FFmpeg reads at upload, by signature: ISO BMFF (MP4, MOV, M4A), Matroska/WebM,
 * WAV, MP3 (ID3 or a frame sync), FLAC and Ogg. Anything else never reaches FFmpeg.
 */
export function isMediaFile(b: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  return (
    ascii(4, 8) === "ftyp" ||
    (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ||
    (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") ||
    ascii(0, 3) === "ID3" ||
    (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) ||
    ascii(0, 4) === "fLaC" ||
    ascii(0, 4) === "OggS"
  );
}

/** Video limits at upload (ADR-0032). */
export const VIDEO_LIMITS = {
  maxSeconds: 60,
  maxFps: 60,
  /** Longest edge of the decoded frames; larger footage is scaled down to it. */
  maxEdge: 1920,
  /** Decoded JPEG frames of one upload. */
  maxDecodedBytes: 1024 * 1024 * 1024,
} as const;

/** One stored object and the entries an upload adds; the first entry is the uploaded asset. */
interface Prepared {
  blobs: { key: string; bytes: Uint8Array; contentType: string }[];
  entries: Record<string, unknown>[];
}

/** The asset entry (without id) the bytes describe; the fields come from the file itself. */
function describeUpload(input: UploadAssetInput, bytes: Uint8Array) {
  const sha256 = sha256Of(bytes);
  const invalid = (message: string) =>
    new ToolError("invalid", message, [{ path: ["data"], message }]);
  try {
    if (sniffImageFormat(bytes) !== null) {
      if (input.family !== undefined)
        throw new ToolError("invalid", "family applies to fonts only; this file is an image", [
          { path: ["family"], message: "omit it for images" },
        ]);
      const info = readImageInfo(bytes);
      if (info.width > MAX_COMPOSITION_SIZE || info.height > MAX_COMPOSITION_SIZE)
        throw invalid(
          `images may be at most ${MAX_COMPOSITION_SIZE}×${MAX_COMPOSITION_SIZE} pixels (got ${info.width}×${info.height}); downscale it before uploading`,
        );
      const ext = info.format === "png" ? "png" : "jpg";
      return {
        key: blobKey(sha256, ext),
        contentType: `image/${info.format}`,
        asset: {
          type: "image" as const,
          name: input.name,
          uri: blobKey(sha256, ext),
          sha256,
          width: info.width,
          height: info.height,
        },
      };
    }
    const font = sniffFontFormat(bytes);
    if (font !== null || /^(wOFF|wOF2|ttcf)/.test(String.fromCharCode(...bytes.subarray(0, 4)))) {
      const info = readFontInfo(bytes);
      const ext = info.format === "opentype" ? "otf" : "ttf";
      return {
        key: blobKey(sha256, ext),
        contentType: `font/${ext}`,
        asset: {
          type: "font" as const,
          name: input.name,
          uri: blobKey(sha256, ext),
          sha256,
          family: input.family ?? info.family,
          weight: info.weight,
        },
      };
    }
  } catch (e) {
    if (e instanceof AssetInfoError) throw invalid(e.message);
    throw e;
  }
  throw invalid(
    "unsupported file type: upload a PNG or JPEG image, a TrueType/OpenType font (.ttf/.otf), a video (MP4, MOV, WebM, MKV) or audio (WAV, MP3, FLAC, Ogg, M4A). SVG uploads are not available yet (see get_capabilities)",
  );
}

function prepareFile(input: UploadAssetInput, bytes: Uint8Array): Prepared {
  const { key, contentType, asset } = describeUpload(input, bytes);
  return { blobs: [{ key, bytes, contentType }], entries: [asset] };
}

/** Stores objects a few at a time: a long clip has thousands of frames. */
async function putAll(blobs: BlobStore, items: Prepared["blobs"]): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i] as Prepared["blobs"][number];
      await blobs.put(item.key, item.bytes, item.contentType);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
}

export interface RenderFramesInput {
  composition?: string | undefined;
  frames: number[];
  max_size: number;
}

export interface ContactSheetInput {
  composition?: string | undefined;
  frames?: number[] | undefined;
  count: number;
  from_frame?: number | undefined;
  to_frame?: number | undefined;
  columns?: number | undefined;
  cell_size: number;
}

interface RenderReports {
  /** Layers the renderer left out, with why and in which frames; nothing is dropped silently. */
  skipped: SkippedReport[];
  /** Content drawn other than the document asks (font fallback, missing glyphs). */
  warnings: WarningReport[];
}

export interface RenderFramesReply extends RenderReports {
  project_id: string;
  version: number;
  composition: string;
  frames: {
    frame: number;
    width: number;
    height: number;
    pixels_sha256: string;
    png_sha256: string;
    cached: boolean;
  }[];
}

export interface ContactSheetReply extends RenderReports {
  project_id: string;
  version: number;
  composition: string;
  /** The cells' frames, row-major. */
  frames: number[];
  width: number;
  height: number;
  columns: number;
  rows: number;
  cell_width: number;
  cell_height: number;
  pixels_sha256: string;
  png_sha256: string;
  cached: boolean;
}

/** A render result and its PNG images, which the server sends as image content. */
export interface Rendered<T> {
  result: T;
  images: Uint8Array[];
}

type CacheValue = { kind: "frame"; frame: CapturedFrame } | { kind: "sheet"; sheet: CapturedSheet };

/**
 * What every service of one process shares, whichever account it acts for: the renderer, the
 * render and asset caches (keyed by content, so safe to share across accounts) and the FFmpeg
 * slots. A remote server builds one per process and a `KynimoService` per request.
 */
export class ServiceRuntime {
  readonly makeId: () => string;
  readonly renderer: FrameRenderer | undefined;
  readonly renders: RenderCache<CacheValue>;
  readonly blobs: BlobStore | undefined;
  readonly blobsUnavailable: string;
  readonly assetBytes: RenderCache<Uint8Array>;
  readonly media: MediaTools | undefined;
  readonly decodeSlots = new Slots(MEDIA_CONCURRENCY);
  readonly scriptSlots = new Slots(SCRIPT_CONCURRENCY);
  readonly maxRenderAssetBytes: number;
  readonly scriptLimits: Partial<ScriptLimits>;
  readonly mediaUnavailable: string;

  constructor(options: ServiceOptions = {}) {
    this.makeId = options.makeId ?? newProjectId;
    this.renderer = options.renderer;
    this.renders = new RenderCache(options.renderCacheBytes ?? 256 * 1024 * 1024);
    this.blobs = options.blobs;
    this.blobsUnavailable = options.blobsUnavailable ?? "this server has no asset storage";
    this.assetBytes = new RenderCache(options.assetCacheBytes ?? 128 * 1024 * 1024);
    this.media = options.media;
    this.maxRenderAssetBytes = options.maxRenderAssetBytes ?? RENDER_LIMITS.maxAssetBytes;
    this.scriptLimits = options.scriptLimits ?? {};
    this.mediaUnavailable =
      options.mediaUnavailable ?? "this server has no FFmpeg (install ffmpeg and ffprobe)";
  }
}

/**
 * The MCP tools' logic, independent of the transport. Every write goes through `write`, which
 * runs in a store transaction that holds the project's lock, checks `base_version` (optimistic
 * concurrency), applies one atomic batch through `@kynimo/scene` and saves the idempotency key
 * with its outcome (ADR-0018, ADR-0029).
 */
export class KynimoService {
  private readonly rt: ServiceRuntime;

  constructor(
    private readonly store: ProjectStore,
    /** The authenticated actor; the local server has exactly one. */
    readonly actor: string,
    /** Options for a runtime of its own, or a runtime shared with other services. */
    options: ServiceOptions | ServiceRuntime = {},
  ) {
    this.rt = options instanceof ServiceRuntime ? options : new ServiceRuntime(options);
  }

  /**
   * Stores a file and adds its asset entry (a video's extracted audio too) in one write. The
   * request is fingerprinted on the file's own hash and the given fields, not on what is derived
   * from it, so a retry with the same key replays the stored result without decoding again.
   * Bytes go to the blob store first under their content keys, so a rejected write leaves only
   * unreferenced objects, which are harmless (ADR-0031, ADR-0032).
   */
  async uploadAsset(
    meta: WriteMeta,
    input: UploadAssetInput,
  ): Promise<WriteReply & { asset: Asset; audio_asset?: Asset }> {
    const blobs = this.rt.blobs;
    if (blobs === undefined)
      throw new ToolError(
        "unavailable",
        `asset upload is unavailable: ${this.rt.blobsUnavailable}`,
      );
    const bytes = decodeBase64(input.data);
    if (bytes.length > MAX_UPLOAD_BYTES) throw tooLarge();
    if (bytes.length === 0)
      throw new ToolError("invalid", "data is empty", [{ path: ["data"], message: "empty file" }]);
    const print = fingerprint({
      tool: "upload_asset",
      base_version: meta.base_version,
      source: sha256Of(bytes),
      name: input.name,
      id: input.id ?? null,
      family: input.family ?? null,
    });
    await this.load(meta.project_id);
    const seen = await this.store.lookupWrite(meta.project_id, this.actor, meta.idempotency_key);
    let reply: WriteReply;
    if (seen.status !== "unknown") {
      // Replays the stored outcome, or fails with key_reused / key_expired; applies nothing.
      reply = await this.writeUpload(meta, [], print, true);
    } else {
      if (isMediaFile(bytes) && input.id !== undefined && input.id.length > 58)
        throw new ToolError("invalid", "video and audio ids may be at most 58 characters", [
          { path: ["id"], message: "at most 58 characters: a clip's sound gets '<id>-audio'" },
        ]);
      const prepared = isMediaFile(bytes)
        ? await this.rt.decodeSlots.run(() => this.prepareMedia(blobs, input, bytes))
        : prepareFile(input, bytes);
      await putAll(blobs, prepared.blobs);
      const ops = prepared.entries.map((asset, i) => {
        const id = input.id === undefined ? undefined : i === 0 ? input.id : `${input.id}-audio`;
        return { op: "addAsset", ...(id === undefined ? {} : { id }), asset };
      });
      reply = await this.writeUpload(meta, ops, print);
    }
    const ids = reply.assets_added ?? [];
    const doc = await this.store.getVersion(meta.project_id, reply.version);
    if (doc === undefined)
      throw new ToolError(
        "not_found",
        `version ${reply.version} of the project is no longer stored, so the asset this key added cannot be shown; list_assets shows the current assets`,
      );
    const added = ids.map((id) => doc.assets.find((a) => a.id === id));
    const [asset, audio] = added;
    if (asset === undefined) throw new ToolError("invalid", "the asset was not added");
    return { ...reply, asset, ...(audio === undefined ? {} : { audio_asset: audio }) };
  }

  private async writeUpload(
    meta: WriteMeta,
    ops: unknown[],
    print: string,
    replayOnly = false,
  ): Promise<WriteReply> {
    try {
      return await this.write(meta, { kind: "ops", ops }, print, replayOnly);
    } catch (e) {
      throw e instanceof ToolError && e.kind === "invalid" ? uploadError(e) : e;
    }
  }

  /**
   * Decodes video to constant-rate JPEG frames and a frame manifest, and audio to FLAC, with
   * FFmpeg on a temp copy of the upload. Frames stream from FFmpeg and are stored one by one;
   * at most {@link MEDIA_CONCURRENCY} uploads decode at once. The source file is not stored.
   */
  private async prepareMedia(
    blobs: BlobStore,
    input: UploadAssetInput,
    bytes: Uint8Array,
  ): Promise<Prepared> {
    const media = this.rt.media;
    if (media === undefined)
      throw new ToolError(
        "unavailable",
        `video and audio upload is unavailable: ${this.rt.mediaUnavailable}`,
      );
    if (input.family !== undefined)
      throw new ToolError("invalid", "family applies to fonts only", [
        { path: ["family"], message: "omit it for video and audio" },
      ]);
    const invalid = (message: string) =>
      new ToolError("invalid", message, [{ path: ["data"], message }]);
    const dir = await mkdtemp(join(tmpdir(), "kynimo-media-"));
    try {
      const source = join(dir, "source");
      await writeFile(source, bytes);
      const probe = await media.probe(source);
      const maxMs = VIDEO_LIMITS.maxSeconds * 1000;
      // A little slack: "60 s" recordings often run a few frames over; -t trims them.
      if (probe.durationMs > maxMs + 500)
        throw invalid(
          `clips may be at most ${VIDEO_LIMITS.maxSeconds} s (this one is ${(probe.durationMs / 1000).toFixed(1)} s); trim it before uploading`,
        );
      const out: Prepared = { blobs: [], entries: [] };
      if (probe.video !== undefined)
        out.entries.push(await this.decodeVideo(blobs, media, input, source, probe.video, out));
      if (probe.hasAudio) {
        const flac = join(dir, "audio.flac");
        const { durationMs } = await media.extractAudio(source, flac, VIDEO_LIMITS.maxSeconds);
        const audio = new Uint8Array(await readFile(flac));
        const sha256 = sha256Of(audio);
        const key = blobKey(sha256, "flac");
        out.blobs.push({ key, bytes: audio, contentType: "audio/flac" });
        out.entries.push({
          type: "audio",
          name: probe.video === undefined ? input.name : `${input.name.slice(0, 192)} (audio)`,
          uri: key,
          sha256,
          durationMs: Math.max(1, durationMs),
        });
      }
      if (out.entries.length === 0) throw invalid("the file has no video or audio stream");
      return out;
    } catch (e) {
      if (e instanceof MediaError) throw invalid(e.message);
      throw e;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async decodeVideo(
    blobs: BlobStore,
    media: MediaTools,
    input: UploadAssetInput,
    source: string,
    video: { width: number; height: number; fps: Rational },
    out: Prepared,
  ): Promise<Record<string, unknown>> {
    const invalid = (message: string) =>
      new ToolError("invalid", message, [{ path: ["data"], message }]);
    const rate = video.fps.num / video.fps.den;
    if (rate < 1) throw invalid("the video's frame rate is below 1 fps");
    const fps = rate > VIDEO_LIMITS.maxFps ? { num: VIDEO_LIMITS.maxFps, den: 1 } : video.fps;
    const scale = Math.min(1, VIDEO_LIMITS.maxEdge / Math.max(video.width, video.height));
    const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
    const width = even(video.width);
    const height = even(video.height);
    // Each frame is stored as it arrives (a few in flight), so memory holds a handful of frames.
    const hashes: string[] = [];
    const inFlight = new Set<Promise<void>>();
    let storeError: unknown;
    const store = (p: Promise<void>) => {
      const tracked = p
        .catch((e) => {
          storeError ??= e;
        })
        .finally(() => inFlight.delete(tracked));
      inFlight.add(tracked);
    };
    await media.decodeFrames(
      source,
      {
        fps,
        width,
        height,
        maxFrames: Math.ceil((VIDEO_LIMITS.maxSeconds * fps.num) / fps.den),
        maxSeconds: VIDEO_LIMITS.maxSeconds,
        maxBytes: VIDEO_LIMITS.maxDecodedBytes,
      },
      async (frame) => {
        if (storeError !== undefined) throw storeError;
        const info = readImageInfo(frame);
        if (info.width !== width || info.height !== height)
          throw invalid(`a decoded frame is ${info.width}×${info.height}, not ${width}×${height}`);
        const sha256 = sha256Of(frame);
        hashes.push(sha256);
        store(blobs.put(blobKey(sha256, "jpg"), frame, "image/jpeg"));
        if (inFlight.size >= 8) await Promise.race(inFlight);
      },
    );
    await Promise.all(inFlight);
    if (storeError !== undefined) throw storeError;
    if (hashes.length === 0) throw invalid("the video decodes to no frames");
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        format: "kynimo-video-frames",
        version: 1,
        width,
        height,
        fps,
        frame_format: "jpeg",
        frames: hashes,
        decoder: await media.version(),
      }),
    );
    const sha256 = sha256Of(manifest);
    const key = blobKey(sha256, "json");
    out.blobs.push({ key, bytes: manifest, contentType: "application/json" });
    return {
      type: "video",
      name: input.name,
      uri: key,
      sha256,
      width,
      height,
      fps,
      frameCount: hashes.length,
    };
  }

  async listAssets(projectId: string): Promise<{
    project_id: string;
    version: number;
    assets: AssetSummary[];
  }> {
    const p = await this.load(projectId);
    const layers = p.doc.compositions.flatMap((c) => c.layers);
    const users = (a: Asset) =>
      layers
        .filter((l) =>
          a.type === "font"
            ? l.type === "text" && l.font.family === a.family
            : (l.type === "image" || l.type === "video" || l.type === "audio") &&
              l.assetId === a.id,
        )
        .slice(0, 20)
        .map((l) => l.id as string);
    return {
      project_id: p.id,
      version: p.version,
      assets: p.doc.assets.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        sha256: a.sha256,
        ...(a.type === "image" ? { width: a.width, height: a.height } : {}),
        ...(a.type === "font" ? { family: a.family, weight: a.weight } : {}),
        ...(a.type === "audio" ? { duration_ms: a.durationMs } : {}),
        ...(a.type === "video"
          ? {
              width: a.width,
              height: a.height,
              fps: a.fps,
              frame_count: a.frameCount,
              duration_ms: Math.round((a.frameCount * a.fps.den * 1000) / a.fps.num),
            }
          : {}),
        used_by: users(a),
      })),
    };
  }

  /**
   * Bytes of the image and font assets the composition draws (its precomps included), by id,
   * for the renderer. Each is checked against its pin here, so a corrupt object reads as missing
   * rather than as other pixels. Assets nothing in the tree uses are not loaded.
   */
  private async assetsFor(
    doc: Project,
    compositionId: string,
    frames: readonly number[],
  ): Promise<RenderMedia> {
    const images = new Set<string>();
    const families = new Set<string>();
    const seen = new Set<string>();
    const walk = [compositionId];
    for (let id = walk.pop(); id !== undefined; id = walk.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      for (const l of doc.compositions.find((c) => c.id === id)?.layers ?? []) {
        if (l.type === "image") images.add(l.assetId);
        else if (l.type === "text") families.add(l.font.family);
        else if (l.type === "precomp") walk.push(l.compositionId);
      }
    }
    const used = doc.assets.filter((a) =>
      a.type === "image" ? images.has(a.id) : a.type === "font" && families.has(a.family),
    );
    const out = new Map<string, Uint8Array>();
    // Two budgets: stored bytes to load, and decoded RGBA the capture page holds at once.
    let total = 0;
    let pixels = 0;
    const check = () => {
      if (total > this.rt.maxRenderAssetBytes || pixels > RENDER_LIMITS.maxDecodedAssetBytes)
        throw new ToolError(
          "invalid",
          `this render needs more than ${total > this.rt.maxRenderAssetBytes ? `${this.rt.maxRenderAssetBytes} bytes of stored` : `${RENDER_LIMITS.maxDecodedAssetBytes} bytes of decoded`} images, fonts and video frames, the limit for one call; render fewer frames at a time, or use smaller assets`,
        );
    };
    for (const a of used) {
      const failed = (why: string) =>
        new ToolError("render_failed", `asset '${a.id}' (${a.uri}) ${why}; upload the file again`);
      if (!isBlobKey(a.uri)) throw failed("was not stored by upload_asset");
      const bytes = await this.blob(a.uri, a.sha256, () =>
        failed("is missing or corrupt in this server's asset storage"),
      );
      total += bytes.byteLength;
      if (a.type === "image") pixels += a.width * a.height * 4;
      check();
      out.set(a.id, bytes);
    }
    const videoFrames = new Map<string, Uint8Array>();
    for (const [assetId, sourceFrames] of shownVideoFrames(doc, compositionId, frames)) {
      const asset = doc.assets.find((a) => a.id === assetId);
      if (asset?.type !== "video") continue;
      const failed = (why: string) =>
        new ToolError("render_failed", `video asset '${asset.id}' ${why}; upload the clip again`);
      const manifest = await this.frameManifest(asset, failed);
      for (const n of sourceFrames) {
        const sha = manifest[n];
        if (sha === undefined) throw failed(`has no frame ${n} in its frame manifest`);
        const bytes = await this.blob(blobKey(sha, "jpg"), sha, () =>
          failed(`frame ${n} is missing or corrupt in this server's asset storage`),
        );
        total += bytes.byteLength;
        pixels += asset.width * asset.height * 4;
        check();
        videoFrames.set(videoFrameKey(asset.id, n), bytes);
      }
    }
    return { assets: out, videoFrames };
  }

  /** Bytes under a content key, checked against their hash and cached; `failed` when absent or wrong. */
  private async blob(key: string, sha256: string, failed: () => ToolError): Promise<Uint8Array> {
    const cached = this.rt.assetBytes.get(sha256);
    if (cached !== undefined) return cached;
    const read = this.rt.blobs === undefined ? undefined : await this.rt.blobs.get(key);
    if (read === undefined || sha256Of(read) !== sha256) throw failed();
    this.rt.assetBytes.set(sha256, read, read.byteLength);
    return read;
  }

  /** A video asset's frame hashes, from its manifest (pinned by the asset's sha256). */
  private async frameManifest(
    asset: Extract<Asset, { type: "video" }>,
    failed: (why: string) => ToolError,
  ): Promise<readonly string[]> {
    if (!isBlobKey(asset.uri)) throw failed("was not stored by upload_asset");
    const bytes = await this.blob(asset.uri, asset.sha256, () =>
      failed("has a missing or corrupt frame manifest in this server's asset storage"),
    );
    let frames: unknown;
    try {
      frames = (JSON.parse(new TextDecoder().decode(bytes)) as { frames?: unknown }).frames;
    } catch {
      frames = undefined;
    }
    if (
      !Array.isArray(frames) ||
      frames.length !== asset.frameCount ||
      !frames.every((f) => typeof f === "string" && /^[0-9a-f]{64}$/.test(f))
    )
      throw failed("has a frame manifest that does not match the asset");
    return frames as string[];
  }

  private async load(projectId: string): Promise<ProjectState> {
    const p = await this.store.get(projectId);
    if (!p) throw notFound(projectId);
    return p;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectMeta & { replayed: boolean }> {
    const { idempotency_key: key, ...request } = input;
    const print = fingerprint({ tool: "create_project", ...request });
    type Reply = ProjectMeta & { replayed: boolean };
    const value = await this.store.create(async (tx): Promise<Step<Reply | ToolError>> => {
      const earlier = await previousUse(
        await tx.lookup(this.actor, key),
        key,
        print,
        "create_project",
        // The fingerprint covers the name, so this is what the first call returned. No store read
        // here: it would wait on the transaction it runs in.
        (o) => ({
          id: o.result.project_id,
          name: request.name,
          version: o.version,
          replayed: true,
        }),
      );
      if (earlier !== undefined) return { value: earlier };
      const record = (outcome: WriteOutcome): WriteRecord => ({
        actor: this.actor,
        key,
        fingerprint: print,
        outcome,
      });
      const doc: Project = {
        formatVersion: SCENE_FORMAT_VERSION,
        name: request.name,
        mainCompositionId: "main" as Project["mainCompositionId"],
        style: null,
        assets: [],
        compositions: [
          {
            id: "main" as Project["mainCompositionId"],
            name: "Main",
            width: request.width,
            height: request.height,
            fps: request.fps,
            durationFrames: request.duration_frames,
            background: request.background,
            layers: [],
            markers: [],
          },
        ],
      };
      const parsed = ProjectSchema.safeParse(doc);
      if (!parsed.success) {
        const outcome: WriteOutcome = {
          status: "rejected",
          kind: "invalid",
          message: "the project settings are invalid; nothing was created",
          errors: parsed.error.issues.map((i) => ({ path: inputPath(i.path), message: i.message })),
        };
        return { commit: { record: record(outcome) }, value: rejectionError(outcome) };
      }
      const id = this.rt.makeId();
      const result = summarizeChanges(id, 1, []);
      return {
        commit: {
          record: record({ status: "applied", version: 1, result }),
          project: { id, version: 1, doc: parsed.data, idCounter: 0, history: {} },
        },
        value: { id, name: parsed.data.name, version: 1, replayed: false },
      };
    });
    return unwrap(value);
  }

  listProjects(): Promise<ProjectMeta[]> {
    return this.store.list();
  }

  async getProject(projectId: string) {
    const p = await this.load(projectId);
    return {
      project_id: p.id,
      name: p.doc.name,
      version: p.version,
      format_version: p.doc.formatVersion,
      main_composition_id: p.doc.mainCompositionId,
      style: p.doc.style,
      assets: p.doc.assets.length,
      compositions: p.doc.compositions.map((c) => ({
        id: c.id,
        name: c.name,
        width: c.width,
        height: c.height,
        fps: c.fps,
        duration_frames: c.durationFrames,
        layers: c.layers.length,
      })),
    };
  }

  async getScene(
    projectId: string,
    detail: "summary" | "full",
    composition?: string,
  ): Promise<
    | { project_id: string; version: number; detail: "summary"; compositions: CompositionSummary[] }
    | { project_id: string; version: number; detail: "full"; document: Project }
  > {
    const p = await this.load(projectId);
    const comps = p.doc.compositions.filter(
      (c) => composition === undefined || c.id === composition,
    );
    if (composition !== undefined && comps.length === 0)
      throw new ToolError(
        "not_found",
        `composition '${composition}' does not exist; compositions: ${p.doc.compositions.map((c) => c.id).join(", ")}`,
      );
    if (detail === "full")
      return {
        project_id: p.id,
        version: p.version,
        detail,
        document: composition === undefined ? p.doc : { ...p.doc, compositions: comps },
      };
    return {
      project_id: p.id,
      version: p.version,
      detail,
      compositions: comps.map((c) => summarizeComposition(p.doc, c)),
    };
  }

  async findLayers(projectId: string, selector: SelectorInput, limit: number) {
    const p = await this.load(projectId);
    const matches = matchLayers(p.doc, LayerSelectorSchema.parse(selector));
    return {
      project_id: p.id,
      version: p.version,
      total: matches.length,
      layers: matches.slice(0, limit).map((m) => ({
        id: m.layer.id,
        name: m.layer.name,
        type: m.layer.type,
        composition: m.composition.id,
        index: m.index,
      })),
    };
  }

  async getLayer(
    projectId: string,
    selector: SelectorInput,
  ): Promise<{
    project_id: string;
    version: number;
    composition: string;
    index: number;
    layer: Layer;
  }> {
    const p = await this.load(projectId);
    const matches = matchLayers(p.doc, LayerSelectorSchema.parse(selector));
    const [first] = matches;
    if (first === undefined)
      throw new ToolError(
        "not_found",
        `no layer matches ${JSON.stringify(selector)}; find_layers lists candidates`,
      );
    if (matches.length > 1)
      throw new ToolError(
        "invalid",
        `${matches.length} layers match ${JSON.stringify(selector)} (${matches
          .slice(0, 5)
          .map((m) => m.layer.id)
          .join(", ")}${matches.length > 5 ? ", ..." : ""}); narrow the selector or use an id`,
      );
    return {
      project_id: p.id,
      version: p.version,
      composition: first.composition.id,
      index: first.index,
      layer: first.layer,
    };
  }

  /**
   * What animates when in one composition (the main one by default), from the keyframes:
   * optionally only the layers a selector matches there, and only a window of frames.
   */
  async describeMotion(
    projectId: string,
    input: {
      composition?: string | undefined;
      layer?: SelectorInput | undefined;
      from_frame?: number | undefined;
      to_frame?: number | undefined;
    },
  ): Promise<{ project_id: string; version: number } & MotionDescription> {
    const p = await this.load(projectId);
    const id = input.composition ?? p.doc.mainCompositionId;
    const comp = p.doc.compositions.find((c) => c.id === id);
    if (comp === undefined)
      throw new ToolError(
        "not_found",
        `composition '${id}' does not exist; compositions: ${p.doc.compositions.map((c) => c.id).join(", ")}`,
      );
    const from = input.from_frame ?? 0;
    const to = input.to_frame ?? comp.durationFrames - 1;
    checkFrames(comp, [from], "from_frame");
    checkFrames(comp, [to], "to_frame");
    if (from > to)
      throw new ToolError("invalid", `from_frame ${from} is after to_frame ${to}`, [
        { path: ["to_frame"], message: `must be at least ${from}` },
      ]);
    let layers: Set<string> | undefined;
    if (input.layer !== undefined) {
      const matches = matchLayers(p.doc, LayerSelectorSchema.parse(input.layer));
      const here = matches.filter((m) => m.composition.id === comp.id);
      if (here.length === 0) {
        const elsewhere = [...new Set(matches.map((m) => m.composition.id))];
        throw new ToolError(
          "not_found",
          `no layer of composition '${comp.id}' matches ${JSON.stringify(input.layer)}${
            elsewhere.length > 0
              ? `; matches exist in ${elsewhere.join(", ")} (pass composition)`
              : ""
          }`,
        );
      }
      layers = new Set(here.map((m) => m.layer.id));
    }
    return {
      project_id: p.id,
      version: p.version,
      ...describeMotion(p.doc, comp, {
        from_frame: from,
        to_frame: to,
        ...(layers === undefined ? {} : { layers }),
      }),
    };
  }

  /** The composition a not-yet-validated `addLayer` targets, for filling defaults. */
  async composition(projectId: string, id: string) {
    const p = await this.load(projectId);
    return p.doc.compositions.find((c) => c.id === id);
  }

  /**
   * Applies one write atomically. A retry with the same key and the same request returns the
   * stored outcome; the same key with a different request is an error.
   */
  async write(
    meta: WriteMeta,
    write: Write,
    requestPrint?: string,
    /** Only replay a stored outcome for this key; never apply (upload retries, ADR-0032). */
    replayOnly = false,
    /** Reshapes a batch rejection before it is thrown; `fresh` is false when it is a stored one replayed. */
    reshapeRejection: (e: ToolError, fresh: boolean) => ToolError = (e) => e,
  ): Promise<WriteReply> {
    const { project_id: projectId, base_version: base, idempotency_key: key } = meta;
    // A tool whose ops derive from its input (upload_asset) fingerprints that input instead.
    const print = requestPrint ?? fingerprint({ base_version: base, ...write });
    const done = await this.store.transact(
      projectId,
      async (tx): Promise<Step<WriteReply | ToolError>> => {
        const p = tx.project;
        const earlier = await previousUse(
          await tx.lookup(this.actor, key),
          key,
          print,
          "write",
          (o) => ({ ...o.result, replayed: true }),
        );
        if (earlier !== undefined)
          return {
            value: earlier instanceof ToolError ? reshapeRejection(earlier, false) : earlier,
          };
        if (replayOnly)
          return {
            value: new ToolError(
              "key_expired",
              `idempotency_key '${key}' is no longer on record, so this upload might already have been applied; check list_assets and send it again with a new key`,
            ),
          };

        const record = (outcome: WriteOutcome): WriteRecord => ({
          actor: this.actor,
          key,
          fingerprint: print,
          outcome,
        });
        const reject = (
          kind: "invalid" | "conflict" | "empty",
          message: string,
          errors: OpError[],
        ): Step<ToolError> => {
          const outcome: WriteOutcome = {
            status: "rejected",
            kind,
            message,
            errors,
            currentVersion: p.version,
          };
          return {
            commit: { record: record(outcome) },
            value: reshapeRejection(rejectionError(outcome), true),
          };
        };

        if (base !== p.version)
          return reject("conflict", staleMessage(base, p.version), [
            { path: ["base_version"], message: `expected ${p.version}` },
          ]);

        const state = toState(p);
        const step: StepResult =
          write.kind === "ops"
            ? applyBatch(state, this.actor, write.ops)
            : write.kind === "undo"
              ? undo(state, this.actor)
              : redo(state, this.actor);
        if (!step.ok) {
          const message =
            step.kind === "invalid"
              ? "the batch was rejected; nothing was applied. Fix the listed paths and retry with a new idempotency_key"
              : step.kind === "conflict"
                ? `cannot ${write.kind}: a later edit changed what it would revert`
                : `nothing to ${write.kind}`;
          return reject(step.kind, message, step.errors);
        }
        const version = step.changes.length > 0 ? p.version + 1 : p.version;
        const result = summarizeChanges(p.id, version, step.changes);
        return {
          commit: {
            record: record({ status: "applied", version, result }),
            project: {
              id: p.id,
              version,
              doc: step.state.doc,
              idCounter: step.state.idCounter,
              history: fromHistory(step.state.history),
            },
          },
          value: { ...result, replayed: false },
        };
      },
    );
    if (done === undefined) throw notFound(projectId);
    return unwrap(done.value);
  }

  /**
   * Runs an intent tool: parses its input, expands it against the current document into
   * operations, and writes them like `write` (same base_version, idempotency and error
   * semantics). The idempotency fingerprint is the tool's own input, not the produced
   * operations, so a retry replays the stored outcome even after the document has moved.
   * With `dryRun` the operations are validated on a copy and nothing is stored or recorded.
   */
  async intent<I>(
    meta: WriteMeta,
    tool: string,
    schema: z.ZodType<I>,
    body: unknown,
    dryRun: boolean,
    run: (
      doc: Project,
      input: I,
      ctx: { idCounter: number },
    ) => IntentExpansion | Promise<IntentExpansion>,
    /** On `dryRun`, receives the document the operations would produce. */
    onDryRun?: (doc: Project) => void,
  ): Promise<IntentReply> {
    const print = fingerprint({ tool, base_version: meta.base_version, body });
    const p = await this.load(meta.project_id);
    const expand = async () => {
      const parsed = schema.safeParse(body);
      if (!parsed.success)
        throw new ToolError(
          "invalid",
          `${tool}: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
          parsed.error.issues.map((i) => ({
            path: i.path.map(seg),
            message: i.message,
          })),
        );
      try {
        return await run(p.doc, parsed.data, { idCounter: p.idCounter });
      } catch (e) {
        if (e instanceof IntentError)
          throw new ToolError("invalid", e.message, [{ path: e.path, message: e.message }]);
        throw e;
      }
    };
    const stale = meta.base_version !== p.version;
    if (dryRun) {
      if (stale) throw staleVersion(meta.base_version, p.version);
      const { ops, resolved } = await expand();
      const step = applyBatch(toState(p), this.actor, ops);
      if (!step.ok)
        throw new ToolError(
          "invalid",
          EXPANSION_REJECTED_FRESH,
          expandedPaths(step.errors),
          p.version,
          { expanded_ops: ops },
        );
      onDryRun?.(step.state.doc);
      return {
        ...summarizeChanges(p.id, p.version, step.changes),
        replayed: false,
        dry_run: true,
        ops,
        ...(resolved === undefined ? {} : { resolved }),
      };
    }
    // A stale base replays the stored outcome of this key if there is one, else records the conflict.
    if (stale) return await this.write(meta, { kind: "ops", ops: [] }, print);
    const { ops, resolved } = await expand();
    // A rejection of the expanded operations points at them, not at an `ops` input the caller never sent.
    const reshape = (e: ToolError, fresh: boolean): ToolError =>
      e.kind === "invalid"
        ? new ToolError(
            "invalid",
            fresh ? EXPANSION_REJECTED_FRESH : EXPANSION_REJECTED_REPLAYED,
            expandedPaths(e.errors),
            e.currentVersion,
            fresh ? { expanded_ops: ops } : undefined,
          )
        : e;
    const reply = await this.write(meta, { kind: "ops", ops }, print, false, reshape);
    return reply.replayed
      ? reply
      : { ...reply, ops, ...(resolved === undefined ? {} : { resolved }) };
  }

  /**
   * Runs a script (ADR-0036) as an intent: the script is expanded against the current document
   * into operations, then written like any intent call. The fingerprint is the tool input
   * (`source`, `seed`). On `dryRun` the reply also describes the motion of the would-be document.
   */
  async runScript(
    meta: WriteMeta,
    body: unknown,
    dryRun: boolean,
    schema: z.ZodType<{ source: string; seed?: number | undefined }>,
  ): Promise<IntentReply & { op_count?: number; motion?: MotionDescription }> {
    let wouldBe: Project | undefined;
    const reply = await this.intent(
      meta,
      "run_script",
      schema,
      body,
      dryRun,
      async (doc, input, ctx): Promise<IntentExpansion> => {
        const seed = input.seed ?? 0;
        // Server-wide cap on concurrent scripts: each holds a worker thread and replays here.
        const r = await this.rt.scriptSlots.run(() =>
          expandScript(
            doc,
            { source: input.source, seed },
            { ...ctx, limits: this.rt.scriptLimits },
          ),
        );
        if (!r.ok) throw scriptFault(r.error);
        return {
          ops: r.ops,
          resolved: { entries: r.entries, layers_created: r.layersCreated, seed },
        };
      },
      (next) => {
        wouldBe = next;
      },
    );
    // A replay carries no ops, so no count either: 0 would mislead.
    const counted = reply.ops === undefined ? reply : { ...reply, op_count: reply.ops.length };
    if (!dryRun || wouldBe === undefined) return counted;
    const main = wouldBe.compositions.find((c) => c.id === wouldBe?.mainCompositionId);
    return main === undefined ? counted : { ...counted, motion: describeMotion(wouldBe, main) };
  }

  /** The composition to render and the renderer, or a tool error naming what is missing. */
  private async renderTarget(projectId: string, composition: string | undefined) {
    const renderer = this.rt.renderer;
    if (renderer === undefined)
      throw new ToolError("unavailable", "rendering is not available on this server");
    const p = await this.load(projectId);
    const id = composition ?? p.doc.mainCompositionId;
    const comp = p.doc.compositions.find((c) => c.id === id);
    if (comp === undefined)
      throw new ToolError(
        "not_found",
        `composition '${id}' does not exist; compositions: ${p.doc.compositions.map((c) => c.id).join(", ")}`,
      );
    return { p, comp, renderer };
  }

  /** Runs the renderer, turning its failures into `render_failed` tool errors. */
  private async draw<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/could not launch the pinned Chromium/.test(message))
        throw new ToolError(
          "unavailable",
          "rendering is unavailable: the pinned Chromium could not be launched. Install it with `pnpm --filter @kynimo/renderer exec playwright install chromium` and retry",
        );
      throw new ToolError("render_failed", message);
    }
  }

  /**
   * Frames of a composition as PNGs, downscaled to `max_size`. Each frame is cached by
   * document content, composition, frame, size and renderer build (ADR-0018).
   */
  async renderFrames(
    projectId: string,
    input: RenderFramesInput,
  ): Promise<Rendered<RenderFramesReply>> {
    const { p, comp, renderer } = await this.renderTarget(projectId, input.composition);
    const frames = [...new Set(input.frames)];
    checkFrames(comp, frames, "frames");
    const build = await this.draw(() => renderer.build());
    const docHash = fingerprint(p.doc);
    const key = (frame: number) =>
      fingerprint(["frame", p.id, docHash, comp.id, frame, input.max_size, build]);
    const found = new Map<number, CapturedFrame>();
    for (const f of frames) {
      const hit = this.rt.renders.get(key(f));
      if (hit?.kind === "frame") found.set(f, hit.frame);
    }
    const misses = frames.filter((f) => !found.has(f));
    const cachedFrames = new Set(found.keys());
    if (misses.length > 0) {
      const media = await this.assetsFor(p.doc, comp.id, misses);
      const drawn = await this.draw(() =>
        renderer.frames(p.doc, comp.id, misses, input.max_size, media),
      );
      for (const f of drawn) {
        found.set(f.frame, f);
        this.rt.renders.set(key(f.frame), { kind: "frame", frame: f }, f.png.byteLength + 1024);
      }
    }
    const ordered = frames.map((f) => {
      const captured = found.get(f);
      if (captured === undefined) throw new ToolError("render_failed", `frame ${f} was not drawn`);
      return captured;
    });
    return {
      result: {
        project_id: p.id,
        version: p.version,
        composition: comp.id,
        frames: ordered.map((f) => ({
          frame: f.frame,
          width: f.width,
          height: f.height,
          pixels_sha256: f.pixelsSha256,
          png_sha256: f.pngSha256,
          cached: cachedFrames.has(f.frame),
        })),
        ...aggregateReports(ordered),
      },
      images: ordered.map((f) => f.png),
    };
  }

  /**
   * Frames tiled row-major into one PNG: the listed frames, or `count` frames spread evenly over
   * a range (the whole composition by default). Refuses a sheet over the size limit and names a
   * `cell_size` that fits.
   */
  async renderContactSheet(
    projectId: string,
    input: ContactSheetInput,
  ): Promise<Rendered<ContactSheetReply>> {
    const { p, comp, renderer } = await this.renderTarget(projectId, input.composition);
    const last = comp.durationFrames - 1;
    let frames: number[];
    if (input.frames !== undefined) {
      frames = [...new Set(input.frames)];
      checkFrames(comp, frames, "frames");
    } else {
      const from = input.from_frame ?? 0;
      const to = input.to_frame ?? last;
      checkFrames(comp, [from], "from_frame");
      checkFrames(comp, [to], "to_frame");
      if (from > to)
        throw new ToolError("invalid", `from_frame ${from} is after to_frame ${to}`, [
          { path: ["to_frame"], message: `must be at least ${from}` },
        ]);
      frames = sampleFrames(from, to, input.count);
    }
    if (frames.length < RENDER_LIMITS.minCells)
      throw new ToolError(
        "invalid",
        `a contact sheet needs at least ${RENDER_LIMITS.minCells} different frames; use render_frames for one`,
        [{ path: ["frames"], message: `at least ${RENDER_LIMITS.minCells} different frames` }],
      );
    const columns = Math.min(
      input.columns ?? Math.ceil(Math.sqrt(frames.length)),
      RENDER_LIMITS.maxColumns,
    );
    const gap = RENDER_LIMITS.sheetGap;
    const layout = (cellSize: number) =>
      sheetSize(fitSize(comp.width, comp.height, cellSize), frames.length, columns, gap);
    const fits = (cellSize: number) => {
      const l = layout(cellSize);
      return Math.max(l.width, l.height) <= RENDER_LIMITS.maxSheetSize;
    };
    if (!fits(input.cell_size)) {
      const l = layout(input.cell_size);
      let size = input.cell_size;
      while (size > RENDER_LIMITS.minSize && !fits(size)) size--;
      const fix = fits(size)
        ? `use cell_size ${size} or less, or fewer frames`
        : "use fewer frames, or more columns";
      throw new ToolError(
        "invalid",
        `the sheet would be ${l.width}×${l.height}, over the ${RENDER_LIMITS.maxSheetSize} px limit; ${fix}`,
        [{ path: ["cell_size"], message: fix }],
      );
    }
    const build = await this.draw(() => renderer.build());
    const key = fingerprint([
      "sheet",
      p.id,
      fingerprint(p.doc),
      comp.id,
      frames,
      input.cell_size,
      columns,
      gap,
      build,
    ]);
    const hit = this.rt.renders.get(key);
    let sheet: CapturedSheet;
    if (hit?.kind === "sheet") sheet = hit.sheet;
    else {
      const media = await this.assetsFor(p.doc, comp.id, frames);
      sheet = await this.draw(() =>
        renderer.sheet(p.doc, comp.id, frames, { maxSize: input.cell_size, columns, gap }, media),
      );
      this.rt.renders.set(key, { kind: "sheet", sheet }, sheet.png.byteLength + 1024);
    }
    return {
      result: {
        project_id: p.id,
        version: p.version,
        composition: comp.id,
        frames,
        width: sheet.width,
        height: sheet.height,
        columns: sheet.columns,
        rows: Math.ceil(frames.length / sheet.columns),
        cell_width: sheet.cellWidth,
        cell_height: sheet.cellHeight,
        pixels_sha256: sheet.pixelsSha256,
        png_sha256: sheet.pngSha256,
        cached: hit?.kind === "sheet",
        ...aggregateReports(sheet.frames),
      },
      images: [sheet.png],
    };
  }

  /** Whether a write with this key landed (ADR-0018). Without `projectId`, looks up `create_project` keys. */
  async getWriteOutcome(key: string, projectId?: string): Promise<OutcomeReply> {
    if (projectId !== undefined) await this.load(projectId);
    const seen = await this.store.lookupWrite(projectId, this.actor, key);
    if (seen.status !== "found") return { status: seen.status };
    const o = seen.record.outcome;
    return o.status === "applied"
      ? o
      : {
          status: "rejected",
          kind: o.kind,
          message: o.message,
          errors: o.errors,
          ...(o.currentVersion === undefined ? {} : { current_version: o.currentVersion }),
        };
  }
}

/**
 * Source frames of each video asset that `frames` of the composition show, from the evaluated
 * layer trees (precomps and matte sources included), so a render loads exactly those frames.
 */
export function shownVideoFrames(
  doc: Project,
  compositionId: string,
  frames: readonly number[],
): Map<string, Set<number>> {
  const shown = new Map<string, Set<number>>();
  if (!doc.assets.some((a) => a.type === "video")) return shown;
  const visit = (comp: ResolvedComposition, seen: Set<ResolvedComposition>) => {
    if (seen.has(comp)) return;
    seen.add(comp);
    const stack = [...comp.layers];
    for (let l = stack.pop(); l !== undefined; l = stack.pop()) {
      if (l.matte?.source) stack.push(l.matte.source);
      if (l.type === "video" && l.sourceFrame !== null) {
        const set = shown.get(l.assetId) ?? new Set<number>();
        set.add(l.sourceFrame);
        shown.set(l.assetId, set);
      } else if (l.type === "precomp" && l.composition !== null) visit(l.composition, seen);
    }
  };
  for (const f of frames) {
    try {
      visit(evaluateFrame(doc, f, compositionId), new Set());
    } catch {
      // The renderer evaluates again and reports the same error with its own message.
    }
  }
  return shown;
}

/** Every frame must be a whole frame of the composition; errors name the field and the range. */
function checkFrames(comp: Composition, frames: readonly number[], field: string): void {
  const last = comp.durationFrames - 1;
  const errors: OpError[] = [];
  frames.forEach((f, i) => {
    if (!Number.isInteger(f) || f < 0 || f > last)
      errors.push({
        path: field === "frames" ? [field, i] : [field],
        message: `must be a frame from 0 to ${last}`,
      });
  });
  if (errors.length > 0)
    throw new ToolError(
      "invalid",
      `composition '${comp.id}' has frames 0 to ${last} (${comp.durationFrames} frames); every frame must be in that range`,
      errors,
    );
}
