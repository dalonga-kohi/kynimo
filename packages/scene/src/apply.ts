import type { Asset } from "./asset.js";
import {
  applyChange,
  type Change,
  clone,
  findComposition,
  findMarker,
  jsonEqual,
  readPath,
} from "./changes.js";
import type { Mask } from "./compositing.js";
import type { Composition } from "./composition.js";
import type { AssetId, CompositionId, LayerId, MarkerId, MaskId } from "./ids.js";
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
  /** Layer, marker, composition and asset ids are separate namespaces. Mask ids are per layer. */
  usedIds: { layer: Set<string>; marker: Set<string>; comp: Set<string>; asset: Set<string> };
}

const emit = (ctx: Ctx, change: Change): void => {
  const conflict = applyChange(ctx.draft, change);
  if (conflict !== undefined) throw new Error(`internal: ${conflict}`);
  ctx.changes.push(change);
};

/** Ids come from a counter carried by the caller (ADR-0009), skipping any id already in use. */
function nextId(
  ctx: Ctx,
  prefix: "layer" | "marker" | "comp" | "asset" | "mask",
  taken?: Set<string>,
): string {
  const used = taken ?? ctx.usedIds[prefix as "layer" | "marker" | "comp" | "asset"];
  let id: string;
  do {
    ctx.counter += 1;
    id = `${prefix}-${ctx.counter}`;
  } while (used.has(id));
  used.add(id);
  return id;
}

type DrawnLayer = Exclude<Layer, { type: "audio" | "null" }>;
const isDrawn = (layer: Layer): layer is DrawnLayer =>
  layer.type !== "audio" && layer.type !== "null";

/** Resolves a selector to a layer that can carry masks and a track matte. */
function resolveDrawn(ctx: Ctx, selector: LayerSelector, path: (string | number)[]) {
  const ref = resolve(ctx, selector, path);
  if (!isDrawn(ref.layer))
    fail(
      path,
      `layer '${ref.layer.id}' is ${ref.layer.type === "audio" ? "an audio" : "a null"} layer and has no masks or track matte; use a shape, text, image, solid, precomp, adjustment or component layer`,
    );
  return { ...ref, layer: ref.layer };
}

function maskIndex(layer: DrawnLayer, id: string, path: (string | number)[]): number {
  const index = layer.masks.findIndex((m) => m.id === id);
  if (index === -1)
    fail(
      path,
      `layer '${layer.id}' has no mask '${id}'; its masks: ${layer.masks.map((m) => m.id).join(", ") || "none"}`,
    );
  return index;
}

/** The layer a link (parent or track matte) points at, if any. */
const links = (layer: Layer): { field: "parent" | "matte"; target: string }[] => {
  const out: { field: "parent" | "matte"; target: string }[] = [];
  if (layer.type !== "audio" && layer.parent !== null)
    out.push({ field: "parent", target: layer.parent });
  if (isDrawn(layer) && layer.matte !== null)
    out.push({ field: "matte", target: layer.matte.layerId });
  return out;
};

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
    case "addMask": {
      const { layer } = resolveDrawn(ctx, op.layer, [i, "layer"]);
      const index = op.index ?? layer.masks.length;
      if (index > layer.masks.length)
        fail(
          [i, "index"],
          `index ${index} is past the end; layer '${layer.id}' has ${layer.masks.length} masks`,
        );
      const taken = new Set<string>(layer.masks.map((m) => m.id));
      if (op.id !== undefined && taken.has(op.id))
        fail(
          [i, "id"],
          `layer '${layer.id}' already has a mask '${op.id}'; choose another id or omit it`,
        );
      const id = (op.id ?? nextId(ctx, "mask", taken)) as MaskId;
      const masks: Mask[] = [...layer.masks];
      masks.splice(index, 0, { ...op.mask, id });
      setLayerValue(ctx, i, layer, ["masks"], masks as Json);
      return;
    }
    case "updateMask": {
      const { layer } = resolveDrawn(ctx, op.layer, [i, "layer"]);
      const index = maskIndex(layer, op.mask, [i, "mask"]);
      const masks: Mask[] = [...layer.masks];
      // Parsed partials hold only the keys the caller sent, never explicit undefined.
      masks[index] = { ...(masks[index] as Mask), ...op.set } as Mask;
      setLayerValue(ctx, i, layer, ["masks"], masks as Json);
      return;
    }
    case "removeMask": {
      const { layer } = resolveDrawn(ctx, op.layer, [i, "layer"]);
      const index = maskIndex(layer, op.mask, [i, "mask"]);
      setLayerValue(ctx, i, layer, ["masks"], layer.masks.filter((_, k) => k !== index) as Json);
      return;
    }
    case "setMatte": {
      const { composition, layer } = resolveDrawn(ctx, op.layer, [i, "layer"]);
      let matte: Json = null;
      if (op.matte !== null) {
        const source = resolve(ctx, op.matte.layer, [i, "matte", "layer"]);
        if (source.composition.id !== composition.id)
          fail(
            [i, "matte", "layer"],
            `matte source '${source.layer.id}' is in composition '${source.composition.id}', not '${composition.id}'; a track matte must be a layer of the same composition`,
          );
        matte = { layerId: source.layer.id, mode: op.matte.mode };
      }
      setLayerValue(ctx, i, layer, ["matte"], matte);
      return;
    }
    case "precompose": {
      precomposeLayers(ctx, op, i);
      return;
    }
    case "addAsset": {
      if (op.id !== undefined && ctx.usedIds.asset.has(op.id))
        fail([i, "id"], `asset id '${op.id}' is already in use; choose another or omit it`);
      const id = (op.id ?? nextId(ctx, "asset")) as AssetId;
      ctx.usedIds.asset.add(id);
      const asset = { ...op.asset, id } as Asset;
      emit(ctx, {
        op: i,
        type: "asset.insert",
        assetId: id,
        index: ctx.draft.assets.length,
        asset,
      });
      return;
    }
    case "removeAsset": {
      const index = ctx.draft.assets.findIndex((a) => a.id === op.asset);
      const asset = ctx.draft.assets[index];
      if (asset === undefined)
        fail(
          [i, "asset"],
          `asset '${op.asset}' does not exist; list_assets shows this project's assets`,
        );
      const users = assetUsers(ctx.draft, asset);
      if (users.length > 0)
        fail(
          [i, "asset"],
          `asset '${asset.id}' is still used by ${users.length === 1 ? "layer" : "layers"} ${users
            .slice(0, 5)
            .map((u) => `'${u}'`)
            .join(
              ", ",
            )}${users.length > 5 ? ", ..." : ""}; remove those layers or point them at another ${asset.type === "font" ? "font family" : "asset"} first`,
        );
      emit(ctx, {
        op: i,
        type: "asset.remove",
        assetId: asset.id,
        index,
        asset: clone(asset),
      });
      return;
    }
  }
}

/**
 * Layers that need `asset`: image and audio layers naming it, and, for a font, text layers of its
 * family when no other font asset of that family is left.
 */
function assetUsers(doc: Project, asset: Asset): string[] {
  const layers = doc.compositions.flatMap((c) => c.layers);
  if (asset.type !== "font")
    return layers
      .filter(
        (l) =>
          (l.type === "image" || l.type === "video" || l.type === "audio") &&
          l.assetId === asset.id,
      )
      .map((l) => l.id);
  const others = doc.assets.some(
    (a) => a.type === "font" && a.id !== asset.id && a.family === asset.family,
  );
  if (others) return [];
  return layers.filter((l) => l.type === "text" && l.font.family === asset.family).map((l) => l.id);
}

function precomposeLayers(ctx: Ctx, op: Extract<Op, { op: "precompose" }>, i: number): void {
  const refs = op.layers.map((s, k) => resolve(ctx, s, [i, "layers", k]));
  const source = (refs[0] as (typeof refs)[number]).composition;
  const selected = new Map<string, number>();
  for (const [k, ref] of refs.entries()) {
    if (ref.composition.id !== source.id)
      fail(
        [i, "layers", k],
        `layer '${ref.layer.id}' is in composition '${ref.composition.id}', not '${source.id}'; precompose layers of one composition at a time`,
      );
    if (selected.has(ref.layer.id))
      fail([i, "layers", k], `layer '${ref.layer.id}' is listed twice; list each layer once`);
    selected.set(ref.layer.id, k);
  }

  // Parents and track mattes cannot cross a composition boundary; refuse rather than break them.
  for (const layer of source.layers) {
    const inside = selected.has(layer.id);
    for (const { field, target } of links(layer)) {
      if (selected.has(target) === inside) continue;
      const what = field === "parent" ? "parent" : "track matte";
      const k = selected.get(inside ? layer.id : target) as number;
      fail(
        [i, "layers", k],
        inside
          ? `layer '${layer.id}' has ${what} '${target}', which is not being precomposed; add '${target}' to layers, or clear the ${what} first`
          : `layer '${layer.id}' (not being precomposed) has ${what} '${target}'; add '${layer.id}' to layers, or clear its ${what} first`,
      );
    }
  }

  if (op.id !== undefined && ctx.usedIds.comp.has(op.id))
    fail([i, "id"], `composition id '${op.id}' is already in use; choose another or omit it`);
  const compId = (op.id ?? nextId(ctx, "comp")) as CompositionId;
  ctx.usedIds.comp.add(compId);
  if (op.layerId !== undefined && ctx.usedIds.layer.has(op.layerId))
    fail([i, "layerId"], `layer id '${op.layerId}' is already in use; choose another or omit it`);

  const ordered = [...refs].sort((a, b) => a.index - b.index);
  const top = ordered[0] as (typeof ordered)[number];
  const name = op.name ?? `${top.layer.name.slice(0, 195)} Comp`;
  const composition: Composition = {
    id: compId,
    name,
    width: source.width,
    height: source.height,
    fps: { ...source.fps },
    durationFrames: source.durationFrames,
    background: null,
    layers: [],
    markers: [],
  };
  emit(ctx, {
    op: i,
    type: "composition.insert",
    compositionId: compId,
    index: ctx.draft.compositions.length,
    composition: clone(composition),
  });

  for (const [k, ref] of ordered.entries()) {
    const at = (findComposition(ctx.draft, source.id) as Composition).layers.findIndex(
      (l) => l.id === ref.layer.id,
    );
    const layer = clone(ref.layer);
    emit(ctx, {
      op: i,
      type: "layer.remove",
      composition: source.id as CompositionId,
      layerId: layer.id,
      index: at,
      layer,
    });
    emit(ctx, {
      op: i,
      type: "layer.insert",
      composition: compId,
      layerId: layer.id,
      index: k,
      layer: clone(layer),
    });
  }

  const layerId = (op.layerId ?? nextId(ctx, "layer")) as LayerId;
  ctx.usedIds.layer.add(layerId);
  const center: [number, number] = [source.width / 2, source.height / 2];
  const precomp: Layer = {
    id: layerId,
    type: "precomp",
    name,
    inFrame: 0,
    outFrame: source.durationFrames,
    startFrame: 0,
    hidden: false,
    // Solo is per composition: keep a soloed selection soloed against the layers left outside.
    solo: refs.some((r) => r.layer.solo),
    editor: { locked: false, shy: false, label: null },
    markers: [],
    parent: null,
    transform: {
      anchorPoint: { value: center },
      position: { value: center },
      scale: { value: [1, 1] },
      rotation: { value: 0 },
      skew: { value: 0 },
      opacity: { value: 1 },
    },
    blendMode: "normal",
    matte: null,
    masks: [],
    compositionId: compId,
  };
  emit(ctx, {
    op: i,
    type: "layer.insert",
    composition: source.id as CompositionId,
    layerId,
    index: top.index,
    layer: precomp,
  });
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

    const usedIds = {
      layer: new Set<string>(),
      marker: new Set<string>(),
      comp: new Set<string>(),
      asset: new Set<string>(doc.assets.map((a) => a.id)),
    };
    for (const c of doc.compositions) {
      usedIds.comp.add(c.id);
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
