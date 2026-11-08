import type { Composition } from "@kynimo/scene";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Layer types without a transform, and types that do not put pixels in the frame. */
const NO_TRANSFORM = new Set(["audio"]);
const NOT_DRAWN = new Set(["audio", "null"]);

/**
 * Fills the fields every layer of a type shares, so `add_layer` only needs the type's own fields
 * (e.g. a shape's `contents`) and whatever the caller wants to differ. Fields the caller sets are
 * kept as given; `transform` is filled per property. Unknown types and non-objects pass through
 * untouched for the schema to reject with a pathed error.
 */
export function withLayerDefaults(input: unknown, composition: Composition | undefined): unknown {
  if (!isObj(input) || typeof input.type !== "string") return input;
  const type = input.type;
  const base: Obj = {
    inFrame: 0,
    outFrame: composition?.durationFrames ?? 1,
    startFrame: 0,
    hidden: false,
    solo: false,
    editor: { locked: false, shy: false, label: null },
    markers: [],
  };
  if (type === "audio") base.volume = { value: 1 };
  const out: Obj = { ...base, ...input };
  if (!NO_TRANSFORM.has(type)) {
    out.parent = input.parent === undefined ? null : input.parent;
    const center = composition ? [composition.width / 2, composition.height / 2] : [0, 0];
    const transform: Obj = {
      anchorPoint: { value: [0, 0] },
      position: { value: center },
      scale: { value: [1, 1] },
      rotation: { value: 0 },
      skew: { value: 0 },
      opacity: { value: 1 },
    };
    if (input.transform === undefined) out.transform = transform;
    else if (isObj(input.transform)) out.transform = { ...transform, ...input.transform };
  }
  if (!NOT_DRAWN.has(type)) {
    out.blendMode = input.blendMode ?? "normal";
    out.matte = input.matte === undefined ? null : input.matte;
    out.masks = input.masks ?? [];
  }
  return out;
}
