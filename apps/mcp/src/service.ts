import { createHash } from "node:crypto";
import { type CapturedFrame, type CapturedSheet, fitSize, sheetSize } from "@kynimo/capture";
import {
  AssetInfoError,
  readFontInfo,
  readImageInfo,
  sniffFontFormat,
  sniffImageFormat,
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
  type OpError,
  type Project,
  ProjectSchema,
  redo,
  SCENE_FORMAT_VERSION,
  type SceneState,
  type StepResult,
  undo,
} from "@kynimo/scene";
import type { z } from "zod";
import { type BlobStore, blobKey, isBlobKey, MAX_ASSET_BYTES } from "./blobs.js";
import { fingerprint } from "./hash.js";
import { describeMotion, type MotionDescription } from "./motion.js";
import {
  aggregateReports,
  type FrameRenderer,
  RENDER_LIMITS,
  RenderCache,
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
      root === "ops" && a === 0
        ? b === "asset"
          ? c
          : b
        : root === "doc" && a === "assets"
          ? c
          : undefined;
    if (key === undefined) return path;
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
    "unsupported file type: upload a PNG or JPEG image, or a TrueType/OpenType font (.ttf/.otf). Audio, video and SVG uploads are not available yet (see get_capabilities)",
  );
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
 * The MCP tools' logic, independent of the transport. Every write goes through `write`, which
 * runs in a store transaction that holds the project's lock, checks `base_version` (optimistic
 * concurrency), applies one atomic batch through `@kynimo/scene` and saves the idempotency key
 * with its outcome (ADR-0018, ADR-0029).
 */
export class KynimoService {
  private readonly makeId: () => string;
  private readonly renderer: FrameRenderer | undefined;
  private readonly renders: RenderCache<CacheValue>;
  private readonly blobs: BlobStore | undefined;
  private readonly blobsUnavailable: string;
  private readonly assetBytes: RenderCache<Uint8Array>;

  constructor(
    private readonly store: ProjectStore,
    /** The authenticated actor; the local server has exactly one. */
    readonly actor: string,
    options: ServiceOptions = {},
  ) {
    this.makeId = options.makeId ?? newProjectId;
    this.renderer = options.renderer;
    this.renders = new RenderCache(options.renderCacheBytes ?? 256 * 1024 * 1024);
    this.blobs = options.blobs;
    this.blobsUnavailable = options.blobsUnavailable ?? "this server has no asset storage";
    this.assetBytes = new RenderCache(options.assetCacheBytes ?? 128 * 1024 * 1024);
  }

  /**
   * Stores a file and adds its asset entry in one write. The bytes go to the blob store first,
   * under their content key, so a retry (same key, same bytes) stores nothing new and replays the
   * write; a rejected write leaves an unreferenced object, which is harmless (ADR-0031).
   */
  async uploadAsset(
    meta: WriteMeta,
    input: UploadAssetInput,
  ): Promise<WriteReply & { asset: Asset }> {
    const blobs = this.blobs;
    if (blobs === undefined)
      throw new ToolError("unavailable", `asset upload is unavailable: ${this.blobsUnavailable}`);
    const bytes = decodeBase64(input.data);
    if (bytes.length > MAX_UPLOAD_BYTES) throw tooLarge();
    if (bytes.length === 0)
      throw new ToolError("invalid", "data is empty", [{ path: ["data"], message: "empty file" }]);
    const { key, contentType, asset } = describeUpload(input, bytes);
    await this.load(meta.project_id);
    await blobs.put(key, bytes, contentType);
    const op = { op: "addAsset", ...(input.id === undefined ? {} : { id: input.id }), asset };
    let reply: WriteReply;
    try {
      reply = await this.write(meta, { kind: "ops", ops: [op] });
    } catch (e) {
      throw e instanceof ToolError && e.kind === "invalid" ? uploadError(e) : e;
    }
    const id = reply.assets_added?.[0];
    if (id === undefined) throw new ToolError("invalid", "the asset was not added");
    return { ...reply, asset: { ...asset, id } as Asset };
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
            : (l.type === "image" || l.type === "audio") && l.assetId === a.id,
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
        used_by: users(a),
      })),
    };
  }

  /**
   * Bytes of the image and font assets the composition draws (its precomps included), by id,
   * for the renderer. Each is checked against its pin here, so a corrupt object reads as missing
   * rather than as other pixels. Assets nothing in the tree uses are not loaded.
   */
  private async assetsFor(doc: Project, compositionId: string): Promise<Map<string, Uint8Array>> {
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
    let total = 0;
    for (const a of used) {
      const failed = (why: string) =>
        new ToolError("render_failed", `asset '${a.id}' (${a.uri}) ${why}; upload the file again`);
      let bytes = this.assetBytes.get(a.sha256);
      if (bytes === undefined) {
        if (!isBlobKey(a.uri)) throw failed("was not stored by upload_asset");
        const read = this.blobs === undefined ? undefined : await this.blobs.get(a.uri);
        if (read === undefined) throw failed("is missing from this server's asset storage");
        if (sha256Of(read) !== a.sha256) throw failed("is corrupt in this server's asset storage");
        bytes = read;
        this.assetBytes.set(a.sha256, bytes, bytes.byteLength);
      }
      total += bytes.byteLength;
      if (total > RENDER_LIMITS.maxAssetBytes)
        throw new ToolError(
          "invalid",
          `composition '${compositionId}' uses more than ${RENDER_LIMITS.maxAssetBytes} bytes of image and font assets, the limit for one render; use smaller files or fewer of them`,
        );
      out.set(a.id, bytes);
    }
    return out;
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
      const id = this.makeId();
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
  async write(meta: WriteMeta, write: Write): Promise<WriteReply> {
    const { project_id: projectId, base_version: base, idempotency_key: key } = meta;
    const print = fingerprint({ base_version: base, ...write });
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
        if (earlier !== undefined) return { value: earlier };

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
          return { commit: { record: record(outcome) }, value: rejectionError(outcome) };
        };

        if (base !== p.version)
          return reject(
            "conflict",
            `base_version ${base} is stale: the project is at version ${p.version}. Read it again (get_scene) and rebuild the request with base_version ${p.version} and a new idempotency_key`,
            [{ path: ["base_version"], message: `expected ${p.version}` }],
          );

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

  /** The composition to render and the renderer, or a tool error naming what is missing. */
  private async renderTarget(projectId: string, composition: string | undefined) {
    const renderer = this.renderer;
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
      const hit = this.renders.get(key(f));
      if (hit?.kind === "frame") found.set(f, hit.frame);
    }
    const misses = frames.filter((f) => !found.has(f));
    const cachedFrames = new Set(found.keys());
    if (misses.length > 0) {
      const assets = await this.assetsFor(p.doc, comp.id);
      const drawn = await this.draw(() =>
        renderer.frames(p.doc, comp.id, misses, input.max_size, assets),
      );
      for (const f of drawn) {
        found.set(f.frame, f);
        this.renders.set(key(f.frame), { kind: "frame", frame: f }, f.png.byteLength + 1024);
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
    const hit = this.renders.get(key);
    let sheet: CapturedSheet;
    if (hit?.kind === "sheet") sheet = hit.sheet;
    else {
      const assets = await this.assetsFor(p.doc, comp.id);
      sheet = await this.draw(() =>
        renderer.sheet(p.doc, comp.id, frames, { maxSize: input.cell_size, columns, gap }, assets),
      );
      this.renders.set(key, { kind: "sheet", sheet }, sheet.png.byteLength + 1024);
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
