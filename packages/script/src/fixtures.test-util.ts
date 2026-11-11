import { type Project, ProjectSchema, SCENE_FORMAT_VERSION } from "@kynimo/scene";

type Obj = Record<string, unknown>;

export const prop = <T>(value: T) => ({ value });

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
  transform: {
    anchorPoint: prop([0, 0]),
    position: prop([960, 540]),
    scale: prop([1, 1]),
    rotation: prop(0),
    skew: prop(0),
    opacity: prop(1),
    ...((over.transform as Obj | undefined) ?? {}),
  },
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
});

export const kf = (frame: number, value: unknown): Obj => ({
  frame,
  value,
  interpolation: { type: "linear" },
});

/**
 * main (1920x1080, 30 fps, 300 frames): `title` (text, opacity keyframed), `bg` (solid);
 * other (800x600): `o` (solid).
 */
export const baseDoc = (over: Obj = {}, bgId = "bg"): Project =>
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
        layers: [
          text("title", {
            name: "Title",
            transform: { opacity: { keyframes: [kf(0, 0), kf(15, 1)] } },
          }),
          solid(bgId, { name: "Background", transform: { position: prop([100, 200]) } }),
        ],
        markers: [],
      },
      {
        id: "other",
        name: "other",
        width: 800,
        height: 600,
        fps: { num: 24, den: 1 },
        durationFrames: 48,
        background: null,
        layers: [solid("o")],
        markers: [],
      },
    ],
    ...over,
  });

/** Script helpers (TypeScript, prepended to a test script): full layer props for `add`. */
export const HELPERS = `
const prop = <T>(value: T) => ({ value });
const drawn = (name: string) => ({
  name, inFrame: 0, outFrame: 90, startFrame: 0, hidden: false, solo: false,
  editor: { locked: false, shy: false, label: null }, markers: [], parent: null,
  transform: {
    anchorPoint: prop([0, 0]), position: prop([960, 540]), scale: prop([1, 1]),
    rotation: prop(0), skew: prop(0), opacity: prop(1),
  },
  blendMode: "normal", matte: null, masks: [],
});
const textProps = (name: string, content: string) => ({
  ...drawn(name), content: prop(content), box: { mode: "point" },
  font: { family: "Inter", weight: 400, size: prop(48) },
  tracking: prop(0), leading: prop(1.2), align: "left", textCase: "none", fill: prop("#ffffff"),
});
const shapeProps = (name: string) => ({ ...drawn(name), contents: [] });
const solidProps = (name: string) => ({ ...drawn(name), width: 100, height: 100, color: "#00ff00" });
`;
