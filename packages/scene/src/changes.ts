import type { Asset } from "./asset.js";
import type { Composition } from "./composition.js";
import type { AssetId, CompositionId, LayerId, MarkerId } from "./ids.js";
import type { Layer } from "./layer.js";
import type { Json, Marker } from "./primitives.js";
import type { Project } from "./project.js";

/** Who owns a marker: a composition or a layer. */
export type MarkerOwner = { composition: CompositionId } | { layer: LayerId };

/**
 * A change record: one concrete, invertible edit with every selector already resolved to ids.
 * Each record carries what it expects to find (`before` / the snapshot) and what it leaves
 * (`after`), so the same record replays forward (redo) or inverted (undo) and refuses to apply
 * when the document no longer matches. `op` is the index of the originating operation in its batch.
 */
export type Change = { op: number } & (
  | {
      type: "layer.insert";
      composition: CompositionId;
      layerId: LayerId;
      index: number;
      layer: Layer;
    }
  | {
      type: "layer.remove";
      composition: CompositionId;
      layerId: LayerId;
      index: number;
      layer: Layer;
    }
  /** Replaces the value at `path` inside the layer (e.g. `["transform", "position"]`). */
  | { type: "layer.set"; layerId: LayerId; path: string[]; before: Json; after: Json }
  | { type: "layer.move"; composition: CompositionId; layerId: LayerId; from: number; to: number }
  | { type: "marker.insert"; owner: MarkerOwner; markerId: MarkerId; index: number; marker: Marker }
  | { type: "marker.remove"; owner: MarkerOwner; markerId: MarkerId; index: number; marker: Marker }
  /** A whole composition at `index` in the project's list (layers included). */
  | {
      type: "composition.insert";
      compositionId: CompositionId;
      index: number;
      composition: Composition;
    }
  | {
      type: "composition.remove";
      compositionId: CompositionId;
      index: number;
      composition: Composition;
    }
  /** An asset entry at `index` in the project's list; its bytes are not part of the document. */
  | { type: "asset.insert"; assetId: AssetId; index: number; asset: Asset }
  | { type: "asset.remove"; assetId: AssetId; index: number; asset: Asset }
);

export const invert = (c: Change): Change => {
  switch (c.type) {
    case "layer.insert":
      return { ...c, type: "layer.remove" };
    case "layer.remove":
      return { ...c, type: "layer.insert" };
    case "layer.set":
      return { ...c, before: c.after, after: c.before };
    case "layer.move":
      return { ...c, from: c.to, to: c.from };
    case "marker.insert":
      return { ...c, type: "marker.remove" };
    case "marker.remove":
      return { ...c, type: "marker.insert" };
    case "composition.insert":
      return { ...c, type: "composition.remove" };
    case "composition.remove":
      return { ...c, type: "composition.insert" };
    case "asset.insert":
      return { ...c, type: "asset.remove" };
    case "asset.remove":
      return { ...c, type: "asset.insert" };
  }
};

/** Deep copy of JSON data (documents are JSON, so this is exact). */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Structural equality for JSON values (key order does not matter). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const rb = b as Record<string, unknown>;
  const ra = a as Record<string, unknown>;
  return ka.every((k) => k in rb && jsonEqual(ra[k], rb[k]));
}

export const findComposition = (doc: Project, id: string): Composition | undefined =>
  doc.compositions.find((c) => c.id === id);

/** Layer ids are unique across the project. */
export function findLayer(doc: Project, id: string) {
  for (const composition of doc.compositions) {
    const index = composition.layers.findIndex((l) => l.id === id);
    const layer = composition.layers[index];
    if (layer !== undefined) return { composition, index, layer };
  }
  return undefined;
}

/** Marker ids are unique across the project. */
export function findMarker(doc: Project, id: string) {
  for (const composition of doc.compositions) {
    const owners: { owner: MarkerOwner; markers: Marker[] }[] = [
      { owner: { composition: composition.id }, markers: composition.markers },
      ...composition.layers.map((l) => ({ owner: { layer: l.id }, markers: l.markers })),
    ];
    for (const { owner, markers } of owners) {
      const index = markers.findIndex((m) => m.id === id);
      const marker = markers[index];
      if (marker !== undefined) return { owner, markers, index, marker };
    }
  }
  return undefined;
}

// Layer paths are walked structurally; layers are a union, so the walk is untyped by necessity.
type Bag = Record<string, unknown>;

function parentOf(layer: Layer, path: readonly string[]): { bag: Bag; key: string } | undefined {
  let bag = layer as unknown as Bag;
  for (const key of path.slice(0, -1)) {
    const next = bag[key];
    if (typeof next !== "object" || next === null) return undefined;
    bag = next as Bag;
  }
  const key = path[path.length - 1];
  return key === undefined ? undefined : { bag, key };
}

/**
 * Applies one change to `doc` in place. Returns a message instead of applying when the document
 * no longer matches what the change expects (a conflict). Callers apply to a clone and discard it on failure.
 */
export function applyChange(doc: Project, c: Change): string | undefined {
  switch (c.type) {
    case "layer.insert": {
      const composition = findComposition(doc, c.composition);
      if (composition === undefined) return `composition '${c.composition}' no longer exists`;
      if (findLayer(doc, c.layerId) !== undefined) return `layer '${c.layerId}' already exists`;
      composition.layers.splice(Math.min(c.index, composition.layers.length), 0, clone(c.layer));
      return undefined;
    }
    case "layer.remove": {
      const found = findLayer(doc, c.layerId);
      if (found === undefined) return `layer '${c.layerId}' no longer exists`;
      if (found.composition.id !== c.composition || !jsonEqual(found.layer, c.layer))
        return `layer '${c.layerId}' was changed by a later edit; reload before removing it`;
      found.composition.layers.splice(found.index, 1);
      return undefined;
    }
    case "layer.set": {
      const found = findLayer(doc, c.layerId);
      if (found === undefined) return `layer '${c.layerId}' no longer exists`;
      const at = parentOf(found.layer, c.path);
      if (at === undefined || !jsonEqual(at.bag[at.key], c.before))
        return `'${c.path.join(".")}' on layer '${c.layerId}' was changed by a later edit`;
      at.bag[at.key] = clone(c.after);
      return undefined;
    }
    case "layer.move": {
      const found = findLayer(doc, c.layerId);
      if (found === undefined) return `layer '${c.layerId}' no longer exists`;
      if (found.composition.id !== c.composition || found.index !== c.from)
        return `layer '${c.layerId}' is no longer at position ${c.from}; its order was changed by a later edit`;
      found.composition.layers.splice(c.from, 1);
      found.composition.layers.splice(c.to, 0, found.layer);
      return undefined;
    }
    case "marker.insert": {
      const markers = markersOf(doc, c.owner);
      if (markers === undefined) return "the marker's owner no longer exists";
      if (findMarker(doc, c.markerId) !== undefined) return `marker '${c.markerId}' already exists`;
      markers.splice(Math.min(c.index, markers.length), 0, clone(c.marker));
      return undefined;
    }
    case "marker.remove": {
      const found = findMarker(doc, c.markerId);
      if (found === undefined) return `marker '${c.markerId}' no longer exists`;
      if (!jsonEqual(found.marker, c.marker))
        return `marker '${c.markerId}' was changed by a later edit`;
      found.markers.splice(found.index, 1);
      return undefined;
    }
    case "composition.insert": {
      if (findComposition(doc, c.compositionId) !== undefined)
        return `composition '${c.compositionId}' already exists`;
      doc.compositions.splice(Math.min(c.index, doc.compositions.length), 0, clone(c.composition));
      return undefined;
    }
    case "composition.remove": {
      const index = doc.compositions.findIndex((x) => x.id === c.compositionId);
      const found = doc.compositions[index];
      if (found === undefined) return `composition '${c.compositionId}' no longer exists`;
      if (!jsonEqual(found, c.composition))
        return `composition '${c.compositionId}' was changed by a later edit`;
      doc.compositions.splice(index, 1);
      return undefined;
    }
    case "asset.insert": {
      if (doc.assets.some((a) => a.id === c.assetId)) return `asset '${c.assetId}' already exists`;
      doc.assets.splice(Math.min(c.index, doc.assets.length), 0, clone(c.asset));
      return undefined;
    }
    case "asset.remove": {
      const index = doc.assets.findIndex((a) => a.id === c.assetId);
      const found = doc.assets[index];
      if (found === undefined) return `asset '${c.assetId}' no longer exists`;
      if (!jsonEqual(found, c.asset)) return `asset '${c.assetId}' was changed by a later edit`;
      doc.assets.splice(index, 1);
      return undefined;
    }
  }
}

function markersOf(doc: Project, owner: MarkerOwner): Marker[] | undefined {
  return "composition" in owner
    ? findComposition(doc, owner.composition)?.markers
    : findLayer(doc, owner.layer)?.layer.markers;
}

/** Reads the value at `path` inside a layer (undefined if absent). */
export function readPath(layer: Layer, path: readonly string[]): unknown {
  const at = parentOf(layer, path);
  return at?.bag[at.key];
}
