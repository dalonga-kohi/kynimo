import { ProjectSchema, SCENE_FORMAT_VERSION } from "./index.js";

export type Obj = Record<string, unknown>;

export const prop = <T>(value: T) => ({ value });

export const transform = (): Obj => ({
  anchorPoint: prop([0, 0]),
  position: prop([960, 540]),
  scale: prop([1, 1]),
  rotation: prop(0),
  skew: prop(0),
  opacity: prop(1),
});

export const common = (id: string): Obj => ({
  id,
  name: id,
  inFrame: 0,
  outFrame: 90,
  startFrame: 0,
  hidden: false,
  solo: false,
  editor: { locked: false, shy: false, label: null },
  markers: [],
});

export const visual = (id: string, parent: string | null = null): Obj => ({
  ...common(id),
  parent,
  transform: transform(),
});

export const nullLayer = (id: string, parent: string | null = null): Obj => ({
  ...visual(id, parent),
  type: "null",
});

export const composition = (id: string, layers: Obj[]): Obj => ({
  id,
  name: id,
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  durationFrames: 90,
  background: "#000000",
  layers,
  markers: [],
});

export const project = (overrides: Obj = {}): Obj => ({
  formatVersion: SCENE_FORMAT_VERSION,
  name: "Demo",
  mainCompositionId: "main",
  style: null,
  assets: [],
  compositions: [composition("main", [])],
  ...overrides,
});

export const issues = (input: unknown) => {
  const result = ProjectSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
};
