import { ProjectSchema, SCENE_FORMAT_VERSION } from "./index.js";

export type Obj = Record<string, unknown>;

export const prop = <T>(value: T) => ({ value });

export const transform = (): Obj => ({
  anchorPoint: prop([0, 0]),
  position: prop([960, 540]),
  positionZ: prop(0),
  scale: prop([1, 1]),
  rotation: prop(0),
  rotationX: prop(0),
  rotationY: prop(0),
  skew: prop(0),
  opacity: prop(1),
});

/** A shape group's transform: the 2D properties only. */
export const groupTransform = (): Obj => {
  const { positionZ, rotationX, rotationY, ...flat } = transform();
  void positionZ;
  void rotationX;
  void rotationY;
  return flat;
};

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

/** A drawing layer's common fields; spread it and add `type` and the type's own fields. */
export const visual = (id: string, parent: string | null = null): Obj => ({
  ...common(id),
  parent,
  threeD: false,
  transform: transform(),
  blendMode: "normal",
  matte: null,
  masks: [],
  behaviors: [],
});

export const nullLayer = (id: string, parent: string | null = null): Obj => ({
  ...common(id),
  parent,
  threeD: false,
  transform: transform(),
  behaviors: [],
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
