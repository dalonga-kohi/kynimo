import { createHash } from "node:crypto";
import {
  applyBatch,
  type Change,
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
    readonly kind: "invalid" | "conflict" | "empty" | "not_found" | "key_reused",
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

/** Canonical JSON (sorted keys), so equal requests hash equally regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const fingerprint = (request: unknown): string =>
  createHash("sha256").update(canonical(request)).digest("hex");

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
  for (const c of changes) {
    if (c.type === "layer.insert") {
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

/**
 * The MCP tools' logic, independent of the transport. Every write goes through `write`, which
 * holds a per-project lock, checks `base_version` (optimistic concurrency), applies one atomic
 * batch through `@kynimo/scene` and records the idempotency key with its outcome (ADR-0018).
 */
export class KynimoService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: ProjectStore,
    /** The authenticated actor; the local server has exactly one. */
    readonly actor: string,
    private readonly makeId: () => string = newProjectId,
  ) {}

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
