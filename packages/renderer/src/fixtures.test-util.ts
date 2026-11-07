import { evaluateFrame, type ResolvedComposition } from "@kynimo/engine";
import { type Project, ProjectSchema, SCENE_FORMAT_VERSION } from "@kynimo/scene";

export type Obj = Record<string, unknown>;

export const prop = <T>(value: T) => ({ value });

export const transform = (overrides: Obj = {}): Obj => ({
  anchorPoint: prop([0, 0]),
  position: prop([0, 0]),
  scale: prop([1, 1]),
  rotation: prop(0),
  skew: prop(0),
  opacity: prop(1),
  ...overrides,
});

export const layer = (id: string, type: string, overrides: Obj = {}): Obj => ({
  id,
  name: id,
  inFrame: 0,
  outFrame: 30,
  startFrame: 0,
  hidden: false,
  solo: false,
  editor: { locked: false, shy: false, label: null },
  markers: [],
  parent: null,
  transform: transform(),
  type,
  ...overrides,
});

export const shapeLayer = (id: string, contents: Obj[], overrides: Obj = {}) =>
  layer(id, "shape", { contents, ...overrides });

let itemCount = 0;
const item = (type: string, fields: Obj): Obj => ({
  id: `${type}${++itemCount}`,
  name: type,
  type,
  ...fields,
});

export const rect = (position: [number, number], size: [number, number], cornerRadius = 0) =>
  item("rect", { position: prop(position), size: prop(size), cornerRadius: prop(cornerRadius) });

export const ellipse = (position: [number, number], size: [number, number]) =>
  item("ellipse", { position: prop(position), size: prop(size) });

export const solidPaint = (color: string) => ({ type: "solid", color: prop(color) });

export const fill = (paint: Obj = solidPaint("#ff0000"), overrides: Obj = {}) =>
  item("fill", { paint, opacity: prop(1), rule: "nonzero", ...overrides });

export const stroke = (paint: Obj, width: number, overrides: Obj = {}) =>
  item("stroke", {
    paint,
    opacity: prop(1),
    width: prop(width),
    cap: "butt",
    join: "miter",
    miterLimit: 4,
    dashes: [],
    dashOffset: prop(0),
    ...overrides,
  });

export const group = (items: Obj[], groupTransform: Obj = transform()) =>
  item("group", { transform: groupTransform, items });

export const composition = (id: string, layers: Obj[], overrides: Obj = {}): Obj => ({
  id,
  name: id,
  width: 200,
  height: 100,
  fps: { num: 30, den: 1 },
  durationFrames: 30,
  background: null,
  layers,
  markers: [],
  ...overrides,
});

/** Builds and validates a project, so every test runs on a document the schema accepts. */
export const project = (compositions: Obj[], overrides: Obj = {}): Project =>
  ProjectSchema.parse({
    formatVersion: SCENE_FORMAT_VERSION,
    name: "Test",
    mainCompositionId: "main",
    style: null,
    assets: [],
    compositions,
    ...overrides,
  });

/** Evaluates frame 0 of a single 200×100 composition holding `layers`. */
export const frameOf = (layers: Obj[], overrides: Obj = {}): ResolvedComposition =>
  evaluateFrame(project([composition("main", layers, overrides)]), 0);
