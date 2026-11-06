import {
  applyChange,
  type Change,
  clone,
  findComposition,
  findMarker,
  jsonEqual,
  readPath,
} from "./changes.js";
import type { CompositionId, LayerId, MarkerId } from "./ids.js";
import type { Layer } from "./layer.js";
import { BatchSchema, type Op } from "./ops.js";
import type { Json } from "./primitives.js";
import { type Project, ProjectSchema } from "./project.js";
import { type LayerSelector, matchLayers } from "./selectors.js";

/**
 * Where something went wrong. `path[0]` is "ops" (then the op's index in the batch and the field)
 * or "doc" (then the path into the resulting document, for integrity failures).
 */
export interface OpError {
  path: (string | number)[];
  message: string;
}

export type ApplyResult =
  | { ok: true; doc: Project; changes: Change[]; idCounter: number }
  /** `doc` is the original, untouched document. */
  | { ok: false; kind: "invalid"; doc: Project; errors: OpError[] };

class OpFailure extends Error {
  constructor(readonly errors: OpError[]) {
    super(errors[0]?.message);
  }
}

/** Issue path segments as op-error path segments. */
const seg = (p: PropertyKey): string | number => (typeof p === "number" ? p : String(p));

function fail(path: (string | number)[], message: string): never {
  throw new OpFailure([{ path: ["ops", ...path], message }]);
}

interface Ctx {
  draft: Project;
  changes: Change[];
  counter: number;
  /** Layer and marker ids are separate namespaces. */
  usedIds: { layer: Set<string>; marker: Set<string> };
}

const emit = (ctx: Ctx, change: Change): void => {
  const conflict = applyChange(ctx.draft, change);
  if (conflict !== undefined) throw new Error(`internal: ${conflict}`);
  ctx.changes.push(change);
};

/** Ids come from a counter carried by the caller (ADR-0009), skipping any id already in use. */
function nextId(ctx: Ctx, prefix: "layer" | "marker"): string {
  let id: string;
  do {
    ctx.counter += 1;
    id = `${prefix}-${ctx.counter}`;
  } while (ctx.usedIds[prefix].has(id));
  ctx.usedIds[prefix].add(id);
  return id;
}

const describe = (s: LayerSelector): string =>
  typeof s === "string" ? `id '${s}'` : JSON.stringify(s);

/** Resolves a selector against the working document; it must match exactly one layer. */
function resolve(ctx: Ctx, selector: LayerSelector, path: (string | number)[]) {
  const matches = matchLayers(ctx.draft, selector);
  const [first] = matches;
  if (first === undefined)
    fail(
      path,
      `no layer matches ${describe(selector)}; use an existing layer id or a selector that matches one`,
    );
  if (matches.length > 1) {
    const ids = matches
      .slice(0, 5)
      .map((m) => m.layer.id)
      .join(", ");
    fail(
      path,
      `${matches.length} layers match ${describe(selector)} (${ids}${matches.length > 5 ? ", ..." : ""}); narrow the selector or use an id`,
    );
  }
  return first;
}

function requireComposition(ctx: Ctx, id: string, path: (string | number)[]) {
  return findComposition(ctx.draft, id) ?? fail(path, `composition '${id}' does not exist`);
}

const setLayerValue = (ctx: Ctx, op: number, layer: Layer, path: string[], after: Json) => {
  const before = readPath(layer, path) as Json;
  if (jsonEqual(before, after)) return;
  emit(ctx, {
    op,
    type: "layer.set",
    layerId: layer.id,
    path,
    before: clone(before),
    after: clone(after),
  });
};

function run(ctx: Ctx, op: Op, i: number): void {
  switch (op.op) {
    case "addLayer": {
      const composition = requireComposition(ctx, op.composition, [i, "composition"]);
      const index = op.index ?? 0;
      if (index > composition.layers.length)
        fail(
          [i, "index"],
          `index ${index} is past the end; composition '${composition.id}' has ${composition.layers.length} layers`,
        );
      if (op.id !== undefined && ctx.usedIds.layer.has(op.id))
        fail([i, "id"], `id '${op.id}' is already in use; choose another or omit it`);
      const id = op.id ?? nextId(ctx, "layer");
      ctx.usedIds.layer.add(id);
      for (const [k, m] of op.layer.markers.entries()) {
        if (ctx.usedIds.marker.has(m.id))
          fail(
            [i, "layer", "markers", k, "id"],
            `marker id '${m.id}' is already in use; choose another`,
          );
        ctx.usedIds.marker.add(m.id);
      }
      const layer = { ...op.layer, id } as Layer;
      emit(ctx, {
        op: i,
        type: "layer.insert",
        composition: composition.id as CompositionId,
        layerId: layer.id,
        index,
        layer: clone(layer),
      });
      return;
    }
    case "updateLayer": {
      const { layer } = resolve(ctx, op.layer, [i, "layer"]);
      for (const [key, value] of Object.entries(op.set))
        setLayerValue(ctx, i, layer, [key], value as Json);
      return;
    }
    case "removeLayer": {
      const { composition, index, layer } = resolve(ctx, op.layer, [i, "layer"]);
      emit(ctx, {
        op: i,
        type: "layer.remove",
        composition: composition.id as CompositionId,
        layerId: layer.id,
        index,
        layer: clone(layer),
      });
      return;
    }
    case "setTransformTrack": {
      const { layer } = resolve(ctx, op.layer, [i, "layer"]);
      if (layer.type === "audio")
        fail([i, "layer"], `layer '${layer.id}' is an audio layer and has no transform`);
      setLayerValue(ctx, i, layer, ["transform", op.property], op.track as Json);
      return;
    }
    case "reorderLayer": {
      const { composition, index, layer } = resolve(ctx, op.layer, [i, "layer"]);
      if (op.index >= composition.layers.length)
        fail(
          [i, "index"],
          `index ${op.index} is out of range; composition '${composition.id}' has ${composition.layers.length} layers (0 is top)`,
        );
      if (op.index === index) return;
      emit(ctx, {
        op: i,
        type: "layer.move",
        composition: composition.id as CompositionId,
        layerId: layer.id,
        from: index,
        to: op.index,
      });
      return;
    }
    case "setParent": {
      const { composition, layer } = resolve(ctx, op.layer, [i, "layer"]);
      if (layer.type === "audio")
        fail([i, "layer"], `layer '${layer.id}' is an audio layer and cannot have a parent`);
      let parent: LayerId | null = null;
      if (op.parent !== null) {
        const found = resolve(ctx, op.parent, [i, "parent"]);
        if (found.composition.id !== composition.id)
          fail(
            [i, "parent"],
            `parent '${found.layer.id}' is in composition '${found.composition.id}', not '${composition.id}'; parents must share a composition`,
          );
        parent = found.layer.id;
      }
      setLayerValue(ctx, i, layer, ["parent"], parent);
      return;
    }
    case "addMarker": {
      let owner: { composition: CompositionId } | { layer: LayerId };
      let count: number;
      if ("composition" in op.target) {
        const composition = requireComposition(ctx, op.target.composition, [
          i,
          "target",
          "composition",
        ]);
        owner = { composition: composition.id as CompositionId };
        count = composition.markers.length;
      } else {
        const { layer } = resolve(ctx, op.target.layer, [i, "target", "layer"]);
        owner = { layer: layer.id };
        count = layer.markers.length;
      }
      if (op.id !== undefined && ctx.usedIds.marker.has(op.id))
        fail([i, "id"], `id '${op.id}' is already in use; choose another or omit it`);
      const id = (op.id ?? nextId(ctx, "marker")) as MarkerId;
      ctx.usedIds.marker.add(id);
      emit(ctx, {
        op: i,
        type: "marker.insert",
        owner,
        markerId: id,
        index: count,
        marker: { ...op.marker, id },
      });
      return;
    }
    case "removeMarker": {
      const found = findMarker(ctx.draft, op.marker);
      if (found === undefined) fail([i, "marker"], `marker '${op.marker}' does not exist`);
      emit(ctx, {
        op: i,
        type: "marker.remove",
        owner: found.owner,
        markerId: found.marker.id,
        index: found.index,
        marker: clone(found.marker),
      });
      return;
    }
  }
}

/** Validates the whole document; integrity failures are reported with "doc" paths. */
export function validateDoc(doc: unknown): { doc: Project } | { errors: OpError[] } {
  const parsed = ProjectSchema.safeParse(doc);
  return parsed.success
    ? { doc: parsed.data }
    : {
        errors: parsed.error.issues.map((e) => ({
          path: ["doc", ...e.path.map(seg)],
          message: e.message,
        })),
      };
}

/**
 * Applies a batch of operations atomically: every op succeeds and the result is a valid project,
 * or the original document is returned with pathed errors. Never throws. Pure: ids come from
 * `idCounter` (returned advanced on success), the input document is never mutated.
 */
export function applyOps(doc: Project, ops: unknown, idCounter = 0): ApplyResult {
  const rejected = (errors: OpError[]): ApplyResult => ({
    ok: false,
    kind: "invalid",
    doc,
    errors,
  });
  try {
    const batch = BatchSchema.safeParse(ops);
    if (!batch.success)
      return rejected(
        batch.error.issues.map((e) => ({
          path: ["ops", ...e.path.map(seg)],
          message: e.message,
        })),
      );

    const usedIds = { layer: new Set<string>(), marker: new Set<string>() };
    for (const c of doc.compositions) {
      for (const m of c.markers) usedIds.marker.add(m.id);
      for (const l of c.layers) {
        usedIds.layer.add(l.id);
        for (const m of l.markers) usedIds.marker.add(m.id);
      }
    }
    const ctx: Ctx = { draft: clone(doc), changes: [], counter: idCounter, usedIds };
    for (const [i, op] of batch.data.entries()) run(ctx, op, i);

    const checked = validateDoc(ctx.draft);
    if ("errors" in checked) return rejected(checked.errors);
    return { ok: true, doc: checked.doc, changes: ctx.changes, idCounter: ctx.counter };
  } catch (e) {
    if (e instanceof OpFailure) return rejected(e.errors);
    return rejected([
      { path: ["ops"], message: `internal error: ${e instanceof Error ? e.message : String(e)}` },
    ]);
  }
}
