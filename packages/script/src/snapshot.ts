import { scaleFor } from "@kynimo/guidelines";
import { resolveStyle } from "@kynimo/intent";
import type { Layer, Project } from "@kynimo/scene";

/** What the SDK reads about a layer. Constant values only: animated properties are listed in `animated`. */
export interface LayerSnapshot {
  id: string;
  name: string;
  type: string;
  /** Position in the composition, top-first. */
  index: number;
  composition: string;
  parent: string | null;
  inFrame: number;
  outFrame: number;
  startFrame: number;
  /** Each transform property's value when it is a constant track, else `null`. */
  transform: Record<string, unknown>;
  /** Transform properties that have keyframes. */
  animated: string[];
  /** The string of a text layer. */
  text?: string;
}

export interface CompositionSnapshot {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: { num: number; den: number };
  durationFrames: number;
  /** Shorter side / 1080: what a token distance is multiplied by. */
  scale: number;
  layers: LayerSnapshot[];
}

export interface ScriptSnapshot {
  mainCompositionId: string;
  compositions: CompositionSnapshot[];
  /** Every layer id in the project. */
  layerIds: string[];
  assets: { id: string; type: string; name: string }[];
  tokens: {
    pack: { id: string; version: string; pinned: boolean };
    colors: unknown;
    type: unknown;
    layout: unknown;
    motion: unknown;
  };
}

interface TrackLike {
  value?: unknown;
  keyframes?: unknown;
  separate?: { x?: TrackLike; y?: TrackLike };
}

const hasKeyframes = (t: TrackLike): boolean =>
  Array.isArray(t.keyframes) ||
  (t.separate !== undefined &&
    [t.separate.x, t.separate.y].some((a) => a !== undefined && Array.isArray(a.keyframes)));

/** A constant track's value; a position with separate constant x and y is `[x, y]`. */
function staticValue(t: TrackLike): unknown {
  if (t.value !== undefined) return t.value;
  const sep = t.separate;
  if (sep?.x?.value !== undefined && sep.y?.value !== undefined) return [sep.x.value, sep.y.value];
  return null;
}

function snapshotLayer(composition: string, layer: Layer, index: number): LayerSnapshot {
  const transform: Record<string, unknown> = {};
  const animated: string[] = [];
  if ("transform" in layer) {
    for (const [property, track] of Object.entries(layer.transform) as [string, TrackLike][]) {
      transform[property] = staticValue(track);
      if (hasKeyframes(track)) animated.push(property);
    }
  }
  const out: LayerSnapshot = {
    id: layer.id,
    name: layer.name,
    type: layer.type,
    index,
    composition,
    parent: "parent" in layer ? layer.parent : null,
    inFrame: layer.inFrame,
    outFrame: layer.outFrame,
    startFrame: layer.startFrame,
    transform,
    animated,
  };
  if (layer.type === "text") out.text = layer.content.value;
  return out;
}

/**
 * Everything the SDK knows about the document, as plain JSON (handed to the sandbox as `data`,
 * never pasted into the source). Pure: the same document gives the same snapshot.
 */
export function scriptSnapshot(doc: Project): ScriptSnapshot {
  const { pack, pinned } = resolveStyle(doc);
  return {
    mainCompositionId: doc.mainCompositionId,
    compositions: doc.compositions.map((c) => ({
      id: c.id,
      name: c.name,
      width: c.width,
      height: c.height,
      fps: { num: c.fps.num, den: c.fps.den },
      durationFrames: c.durationFrames,
      scale: scaleFor(c),
      layers: c.layers.map((l, i) => snapshotLayer(c.id, l, i)),
    })),
    layerIds: doc.compositions.flatMap((c) => c.layers.map((l) => l.id)),
    assets: doc.assets.map((a) => ({ id: a.id, type: a.type, name: a.name })),
    tokens: {
      pack: { id: pack.id, version: pack.version, pinned },
      colors: pack.color,
      type: pack.type,
      layout: pack.layout,
      motion: pack.motion,
    },
  };
}
