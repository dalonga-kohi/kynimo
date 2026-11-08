import { type CapturedFrame, type CapturedSheet, fitSize, sheetSize } from "@kynimo/capture";
import {
  applyBatch,
  type Change,
  type Composition,
  type Layer,
  LayerSelectorSchema,
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
import { fingerprint } from "./hash.js";
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
  MAX_WRITE_KEYS,
  newProjectId,
  type ProjectMeta,
  type ProjectStore,
  type Stacks,
  type StoredProject,
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

const toState = (p: StoredProject): SceneState => ({
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
  for (const c of changes) {
    if (c.type === "composition.insert") {
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
  };
}

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

const keep = (records: WriteRecord[]) => records.slice(-MAX_WRITE_KEYS);

export interface ServiceOptions {
  makeId?: () => string;
  /** Draws frames for the render tools; without one they answer `unavailable`. */
  renderer?: FrameRenderer;
  /** Bytes the render cache may hold. Default 256 MB. */
  renderCacheBytes?: number;
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
 * holds a per-project lock, checks `base_version` (optimistic concurrency), applies one atomic
 * batch through `@kynimo/scene` and records the idempotency key with its outcome (ADR-0018).
 */
export class KynimoService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly makeId: () => string;
  private readonly renderer: FrameRenderer | undefined;
  private readonly renders: RenderCache<CacheValue>;

  constructor(
    private readonly store: ProjectStore,
    /** The authenticated actor; the local server has exactly one. */
    readonly actor: string,
    options: ServiceOptions = {},
  ) {
    this.makeId = options.makeId ?? newProjectId;
    this.renderer = options.renderer;
    this.renders = new RenderCache(options.renderCacheBytes ?? 256 * 1024 * 1024);
  }

  private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private async load(projectId: string): Promise<StoredProject> {
    const p = await this.store.get(projectId);
    if (!p)
      throw new ToolError(
        "not_found",
        `project '${projectId}' does not exist; list_projects shows the available ids`,
      );
    return p;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectMeta & { replayed: boolean }> {
    const { idempotency_key: key, ...request } = input;
    const print = fingerprint({ tool: "create_project", ...request });
    return this.exclusive("#create", async () => {
      const records = await this.store.getCreateRecords();
      const seen = records.find((r) => r.actor === this.actor && r.key === key);
      if (seen) {
        if (seen.fingerprint !== print)
          throw new ToolError(
            "key_reused",
            `idempotency_key '${key}' was already used for a different create_project request; use a new key`,
          );
        if (seen.outcome.status === "rejected") throw rejectionError(seen.outcome);
        const p = await this.load(seen.outcome.result.project_id);
        return { id: p.id, name: p.doc.name, version: seen.outcome.version, replayed: true };
      }
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
        await this.store.putCreateRecords(
          keep([...records, { actor: this.actor, key, fingerprint: print, outcome }]),
        );
        throw rejectionError(outcome);
      }
      // Two writes: a crash between them leaves a project without its key, so a retry creates a
      // second project. The database store writes both in one transaction.
      const id = this.makeId();
      await this.store.put({
        id,
        version: 1,
        doc: parsed.data,
        idCounter: 0,
        history: {},
        writes: [],
      });
      const result = summarizeChanges(id, 1, []);
      await this.store.putCreateRecords(
        keep([
          ...records,
          {
            actor: this.actor,
            key,
            fingerprint: print,
            outcome: { status: "applied", version: 1, result },
          },
        ]),
      );
      return { id, name: parsed.data.name, version: 1, replayed: false };
    });
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
    return this.exclusive(projectId, async () => {
      const p = await this.load(projectId);
      const seen = p.writes.find((r) => r.actor === this.actor && r.key === key);
      if (seen) {
        if (seen.fingerprint !== print)
          throw new ToolError(
            "key_reused",
            `idempotency_key '${key}' was already used for a different request on this project; use a new key`,
          );
        if (seen.outcome.status === "rejected") throw rejectionError(seen.outcome);
        return { ...seen.outcome.result, replayed: true };
      }

      const record = async (outcome: WriteOutcome, next: StoredProject) => {
        next.writes = keep([...p.writes, { actor: this.actor, key, fingerprint: print, outcome }]);
        await this.store.put(next);
      };
      const reject = async (
        kind: "invalid" | "conflict" | "empty",
        message: string,
        errors: OpError[],
      ): Promise<never> => {
        const outcome: WriteOutcome = {
          status: "rejected",
          kind,
          message,
          errors,
          currentVersion: p.version,
        };
        await record(outcome, { ...p });
        throw rejectionError(outcome);
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
      await record(
        { status: "applied", version, result },
        {
          ...p,
          version,
          doc: step.state.doc,
          idCounter: step.state.idCounter,
          history: fromHistory(step.state.history),
        },
      );
      return { ...result, replayed: false };
    });
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
      const drawn = await this.draw(() => renderer.frames(p.doc, comp.id, misses, input.max_size));
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
      sheet = await this.draw(() =>
        renderer.sheet(p.doc, comp.id, frames, { maxSize: input.cell_size, columns, gap }),
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
    const records =
      projectId === undefined
        ? await this.store.getCreateRecords()
        : (await this.load(projectId)).writes;
    const seen = records.find((r) => r.actor === this.actor && r.key === key);
    if (!seen) return { status: "unknown" };
    const o = seen.outcome;
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
