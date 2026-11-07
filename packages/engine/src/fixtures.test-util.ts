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
  outFrame: 90,
  startFrame: 0,
  hidden: false,
  solo: false,
  editor: { locked: false, shy: false, label: null },
  markers: [],
  ...(type === "audio" ? {} : { parent: null, transform: transform() }),
  ...(type === "audio" || type === "null" ? {} : { blendMode: "normal", matte: null, masks: [] }),
  type,
  ...overrides,
});

export const solid = (id: string, overrides: Obj = {}): Obj =>
  layer(id, "solid", { width: 100, height: 100, color: "#ff0000", ...overrides });

export const composition = (id: string, layers: Obj[], overrides: Obj = {}): Obj => ({
  id,
  name: id,
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  durationFrames: 90,
  background: "#000000",
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

/** Freezes a value and everything inside it, so tests catch any mutation of the document. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
