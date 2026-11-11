import { type Layer, type Project, ProjectSchema, SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { type ComponentDefinition, defineComponent } from "./define.js";

export type Obj = Record<string, unknown>;

export const prop = <T>(value: T) => ({ value });
export const kf = (
  frame: number,
  value: unknown,
  interpolation: Obj = { type: "linear" },
): Obj => ({
  frame,
  value,
  interpolation,
});

const transform = (over: Obj = {}): Obj => ({
  anchorPoint: prop([0, 0]),
  position: prop([0, 0]),
  scale: prop([1, 1]),
  rotation: prop(0),
  skew: prop(0),
  opacity: prop(1),
  ...over,
});

/** A raw layer the scene schema accepts; defaults for effects and behaviors are filled by the schema. */
export const layer = (id: string, type: string, over: Obj = {}): Obj => ({
  id,
  name: id,
  inFrame: 0,
  outFrame: 90,
  startFrame: 0,
  hidden: false,
  solo: false,
  editor: { locked: false, shy: false, label: null },
  markers: [],
  ...(type === "audio" ? {} : { parent: null, transform: transform() }),
  ...(type === "audio" || type === "null" ? {} : { blendMode: "normal", matte: null, masks: [] }),
  type,
  ...over,
});

export const solid = (id: string, over: Obj = {}): Obj =>
  layer(id, "solid", { width: 100, height: 100, color: "#ff0000", ...over });

export const textLayer = (id: string, over: Obj = {}): Obj =>
  layer(id, "text", {
    content: prop("Hi"),
    box: { mode: "point" },
    font: { family: "Inter", weight: 400, size: prop(48) },
    tracking: prop(0),
    leading: prop(1.2),
    align: "left",
    textCase: "none",
    animators: [],
    fill: prop("#ffffff"),
    ...over,
  });

export const instance = (id: string, props: Obj = {}, over: Obj = {}): Obj =>
  layer(id, "component", { componentId: "badge", componentVersion: "1.0.0", props, ...over });

export const imageAsset = (id: string): Obj => ({
  id,
  name: id,
  type: "image",
  uri: `assets/${id}.png`,
  sha256: "0".repeat(64),
  width: 10,
  height: 10,
});

export const audioAsset = (id: string): Obj => ({
  id,
  name: id,
  type: "audio",
  uri: `assets/${id}.mp3`,
  sha256: "0".repeat(64),
  durationMs: 1000,
});

/** A validated project whose main composition holds `layers`. */
export function project(layers: Obj[], over: Obj = {}, comp: Obj = {}): Project {
  return ProjectSchema.parse({
    formatVersion: SCENE_FORMAT_VERSION,
    name: "Test",
    mainCompositionId: "main",
    style: null,
    assets: [],
    compositions: [
      {
        id: "main",
        name: "main",
        width: 1920,
        height: 1080,
        fps: { num: 30, den: 1 },
        durationFrames: 90,
        background: "#000000",
        layers,
        markers: [],
        ...comp,
      },
    ],
    ...over,
  });
}

/**
 * A "badge": a solid in the `tone` color (a style role by default) with a title-sized label, scaled by an
 * animatable `scale`. Uses the pack's colors, type and spacing, and `random()` for a tiny seeded nudge.
 */
export const badge: ComponentDefinition = defineComponent({
  id: "badge",
  version: "1.0.0",
  title: "Badge",
  description: "A colored plate with a label.",
  props: {
    label: { type: "string", description: "Text on the badge.", default: "New", maxLength: 40 },
    scale: {
      type: "number",
      description: "Size multiplier.",
      default: 1,
      min: 0.5,
      max: 2,
      animatable: true,
    },
    tone: {
      type: "color",
      description: "Plate color.",
      default: { role: "accent" },
      animatable: true,
    },
  },
  evaluate(props, ctx) {
    const pad = ctx.style.spacing("l");
    const title = ctx.style.type("title");
    const nudge = Math.floor(ctx.random() * 8);
    return {
      width: ctx.width,
      height: ctx.height,
      layers: [
        textLayer("label", {
          content: prop(props.label),
          font: { family: title.family, weight: title.weight, size: prop(title.size) },
          fill: prop(ctx.style.color("text")),
          transform: transform({ position: prop([pad + nudge, pad]) }),
        }),
        solid("plate", {
          width: 400,
          height: 120,
          color: props.tone,
          transform: transform({ scale: prop([props.scale, props.scale]) }),
        }),
      ] as unknown as Layer[],
    };
  },
});
