import type { BlendMode, LayerType, MaskMode, Paint, ShapeItem, TrackMatte } from "@kynimo/scene";
import { MAX_SHAPE_LAYER_WORK } from "./binding.js";
import { BLEND_MODE_IDS } from "./compositor/pipeline.js";
import { BUNDLED_FONTS, FONT_FORMATS } from "./fonts.js";
import { IMAGE_FORMATS } from "./images.js";

/**
 * Whether this build draws something the scene format accepts (ADR-0018). `accepted` means a
 * document may contain it and validates, but frames leave it out and say why.
 */
export type Support = { status: "renders"; note?: string } | { status: "accepted"; reason: string };

const RENDERS = { status: "renders" } as const;

/**
 * Per layer type. Typed over the scene's layer union, so a new layer type does not compile until
 * the renderer says what it does with it. {@link rasterizeFrame} takes its skip reasons from here.
 */
export const LAYER_SUPPORT: Readonly<Record<LayerType, Support>> = {
  shape: RENDERS,
  text: RENDERS,
  image: RENDERS,
  video: {
    status: "renders",
    note: "frames decoded at upload; outside the clip the layer draws nothing",
  },
  solid: RENDERS,
  precomp: RENDERS,
  null: { status: "renders", note: "draws nothing by design; use it as a parent or controller" },
  adjustment: {
    status: "accepted",
    reason: "adjustment layers apply effects, which arrive in M4",
  },
  component: { status: "accepted", reason: "component evaluation arrives in M6" },
  audio: {
    status: "accepted",
    reason: "frames have no sound; audio is mixed in at export, which arrives in M7",
  },
};

/** Shape contents, typed over the scene's shape item union like {@link LAYER_SUPPORT}. */
export const SHAPE_ITEM_SUPPORT: Readonly<Record<ShapeItem["type"], Support>> = {
  rect: RENDERS,
  ellipse: RENDERS,
  polygon: RENDERS,
  star: RENDERS,
  path: {
    status: "renders",
    note: "keyframed paths morph when every keyframe has the same vertex count",
  },
  fill: RENDERS,
  stroke: { status: "renders", note: "dashes and dash offset included" },
  group: RENDERS,
  trim: {
    status: "renders",
    note: "changes the paths listed above it, nested groups included; simultaneous or individual",
  },
  "round-corners": {
    status: "renders",
    note: "rounds vertices without tangent handles in the paths listed above it",
  },
  repeater: {
    status: "renders",
    note: `copies everything listed above it; a shape layer may take at most ${MAX_SHAPE_LAYER_WORK} units of path work per frame (items times copies, plus path segments per paint and operator)`,
  },
};

export const PAINT_SUPPORT: Readonly<Record<Paint["type"], Support>> = {
  solid: RENDERS,
  "linear-gradient": RENDERS,
  "radial-gradient": RENDERS,
};

export const MASK_MODE_SUPPORT: Readonly<Record<MaskMode, Support>> = {
  add: RENDERS,
  subtract: RENDERS,
  intersect: RENDERS,
  lighten: RENDERS,
  darken: RENDERS,
  difference: RENDERS,
  none: { status: "renders", note: "the mask is kept but ignored" },
};

export const MATTE_MODE_SUPPORT: Readonly<Record<TrackMatte["mode"], Support>> = {
  alpha: RENDERS,
  "alpha-inverted": RENDERS,
  luma: RENDERS,
  "luma-inverted": RENDERS,
};

/** Every mode the compositor's blend shader has a case for. */
export const BLEND_MODE_SUPPORT: Readonly<Record<BlendMode, Support>> = Object.fromEntries(
  Object.keys(BLEND_MODE_IDS).map((mode) => [mode, RENDERS]),
) as Record<BlendMode, Support>;

/** File formats and fonts the renderer loads, from the tables it checks them against. */
export const RENDERER_FORMATS = {
  image: IMAGE_FORMATS,
  font: FONT_FORMATS,
  bundledFonts: BUNDLED_FONTS.map((f) => f.family),
} as const;
