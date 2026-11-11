import {
  applyOps,
  type Layer,
  type LayerId,
  type Op,
  type Project,
  ProjectSchema,
  SCENE_FORMAT_VERSION,
} from "@kynimo/scene";
import { expect } from "vitest";

export type Obj = Record<string, unknown>;

export const prop = <T>(value: T) => ({ value });
export const kf = (frame: number, value: unknown, type = "linear"): Obj => ({
  frame,
  value,
  interpolation: { type },
});
export const keyed = (...keyframes: Obj[]) => ({ keyframes });

const transform = (over: Obj = {}): Obj => ({
  anchorPoint: prop([0, 0]),
  position: prop([960, 540]),
  scale: prop([1, 1]),
  rotation: prop(0),
  skew: prop(0),
  opacity: prop(1),
  ...over,
});

const visual = (id: string, over: Obj = {}): Obj => ({
  id,
  name: id,
  inFrame: 0,
  outFrame: 90,
  startFrame: 0,
  hidden: false,
  solo: false,
  editor: { locked: false, shy: false, label: null },
  markers: [],
  parent: null,
  blendMode: "normal",
  matte: null,
  masks: [],
  behaviors: [],
  ...over,
  transform: transform((over.transform as Obj | undefined) ?? {}),
});

export const solid = (id: string, over: Obj = {}): Obj => ({
  ...visual(id, over),
  type: "solid",
  width: 100,
  height: 100,
  color: "#ff0000",
});

export const text = (id: string, over: Obj = {}): Obj => ({
  ...visual(id, over),
  type: "text",
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

export const shape = (id: string, contents: Obj[] = [], over: Obj = {}): Obj => ({
  ...visual(id, over),
  type: "shape",
  contents,
});

export const rect = (id: string, over: Obj = {}): Obj => ({
  type: "rect",
  id,
  name: id,
  position: prop([0, 0]),
  size: prop([200, 100]),
  cornerRadius: prop(0),
  ...over,
});

export const animator = (end: unknown = prop(1)): Obj => ({
  name: "Fade",
  selector: {
    unit: "characters",
    start: prop(0),
    end,
    offset: prop(0),
    shape: "square",
    easeHigh: prop(0),
    easeLow: prop(0),
    order: "forward",
    seed: 0,
    amount: prop(1),
  },
  properties: { opacity: prop(0) },
});

export const square = {
  closed: true,
  vertices: [
    { point: [0, 0], inTangent: [0, 0], outTangent: [0, 0] },
    { point: [10, 0], inTangent: [0, 0], outTangent: [0, 0] },
    { point: [10, 10], inTangent: [0, 0], outTangent: [0, 0] },
  ],
};

export const mask = (id: string, over: Obj = {}): Obj => ({
  id,
  name: id,
  mode: "add",
  inverted: false,
  path: prop(square),
  feather: prop([0, 0]),
  opacity: prop(1),
  expansion: prop(0),
  ...over,
});

export const wiggle = (id: string, over: Obj = {}): Obj => ({
  id,
  name: id,
  enabled: true,
  property: "position",
  type: "wiggle",
  frequency: prop(2),
  amplitude: prop([20, 0]),
  octaves: 2,
  seed: 7,
  linked: false,
  ...over,
});

export const doc = (layers: Obj[], over: Obj = {}, comp: Obj = {}): Project =>
  ProjectSchema.parse({
    formatVersion: SCENE_FORMAT_VERSION,
    name: "Demo",
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
        durationFrames: 300,
        background: "#000000",
        layers,
        markers: [],
        ...comp,
      },
    ],
    ...over,
  });

/** Asserts the ops apply cleanly and returns the resulting document. */
export function applied(project: Project, ops: Op[]): Project {
  const result = applyOps(project, ops);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.doc;
}

export const layerOf = (project: Project, id: string): Layer => {
  const layer = project.compositions.flatMap((c) => c.layers).find((l) => l.id === id);
  expect(layer).toBeDefined();
  return layer as Layer;
};

/** Branded layer ids for test inputs. */
export const lid = (id: string): LayerId => id as LayerId;
