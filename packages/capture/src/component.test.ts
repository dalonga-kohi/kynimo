import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  BUILT_IN_COMPONENTS,
  createComponentHost,
  createComponentRegistry,
  defineComponent,
} from "@kynimo/components";
import { evaluateFrame } from "@kynimo/engine";
import {
  BUNDLED_FONTS,
  type CanvasKit,
  compositeReference,
  FontLibrary,
  ImageLibrary,
  loadCanvasKit,
  rasterizeFrame,
} from "@kynimo/renderer";
import { type Layer, type Project, ProjectSchema, SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchTestCapture } from "./launch.test-util.js";
import { CaptureError, type CaptureSession } from "./session.js";

/**
 * Component instances end to end (ADR-0046). The capture page knows the built-in registry (ADR-0047),
 * so the Node half renders a fixture component through the same engine and renderer code with a
 * custom registry and compares it with the hand-built precomp it should equal; the page half proves
 * the page evaluates with a component host and draws every built-in component.
 */

type Obj = Record<string, unknown>;
const prop = (value: unknown) => ({ value });
const transform = (over: Obj = {}): Obj => ({
  anchorPoint: prop([0, 0]),
  position: prop([0, 0]),
  scale: prop([1, 1]),
  rotation: prop(0),
  skew: prop(0),
  opacity: prop(1),
  ...over,
});
const layer = (id: string, type: string, over: Obj = {}): Obj => ({
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
  blendMode: "normal",
  matte: null,
  masks: [],
  type,
  ...over,
});
const SIZE = { width: 160, height: 90 };
const document = (layers: Obj[], extra: Obj[] = []): Project =>
  ProjectSchema.parse({
    formatVersion: SCENE_FORMAT_VERSION,
    name: "Component",
    mainCompositionId: "main",
    style: null,
    assets: [],
    compositions: [
      {
        id: "main",
        name: "main",
        ...SIZE,
        fps: { num: 30, den: 1 },
        durationFrames: 30,
        background: "#102030",
        markers: [],
        layers,
      },
      ...extra,
    ],
  });

/** The subtree the fixture component outputs, for a given plate width and text color. */
const content = (plateWidth: number, textColor: string): Obj[] => [
  layer("plate", "solid", {
    width: plateWidth,
    height: 40,
    color: "#336699",
    transform: transform({
      position: prop([10, 10]),
      opacity: {
        keyframes: [
          { frame: 0, value: 0, interpolation: { type: "linear" } },
          { frame: 20, value: 1, interpolation: { type: "linear" } },
        ],
      },
    }),
  }),
  layer("label", "text", {
    content: prop("Hi"),
    box: { mode: "point" },
    font: { family: "Inter", weight: 700, size: prop(24) },
    tracking: prop(0),
    leading: prop(1.2),
    align: "left",
    textCase: "none",
    animators: [],
    fill: prop(textColor),
    transform: transform({ position: prop([20, 60]) }),
  }),
];

let textColor = "";
const plate = defineComponent({
  id: "plate",
  version: "1.0.0",
  title: "Plate",
  description: "A plate with a label.",
  props: {
    width: {
      type: "number",
      description: "Plate width.",
      default: 100,
      min: 10,
      max: 160,
      animatable: true,
    },
  },
  evaluate(props, ctx) {
    textColor = ctx.style.color("text");
    return {
      width: ctx.width,
      height: ctx.height,
      layers: content(props.width as number, textColor) as unknown as Layer[],
    };
  },
});

const instance = (over: Obj = {}) =>
  layer("cmp", "component", {
    componentId: "plate",
    componentVersion: "1.0.0",
    inFrame: 5,
    startFrame: 5,
    props: {
      width: {
        keyframes: [
          { frame: 0, value: 20, interpolation: { type: "linear" } },
          { frame: 20, value: 120, interpolation: { type: "linear" } },
        ],
      },
    },
    ...over,
  });

const require = createRequire(import.meta.url);
let ck: CanvasKit;
let fonts: FontLibrary;
beforeAll(async () => {
  const bin = dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
  ck = await loadCanvasKit({ locateFile: (file) => join(bin, file) });
  fonts = new FontLibrary(ck);
  const dir = join(dirname(require.resolve("@kynimo/renderer")), "..", "fonts");
  for (const f of BUNDLED_FONTS)
    await fonts.addBundled(f.family, new Uint8Array(readFileSync(join(dir, f.file))));
});
afterAll(() => fonts?.delete());

const render = (project: Project, frame: number, withHost: boolean) => {
  const components = createComponentHost(project, createComponentRegistry([plate]));
  const plan = rasterizeFrame(
    ck,
    evaluateFrame(project, frame, undefined, withHost ? { components } : {}),
    { images: new ImageLibrary(ck), fonts },
  );
  return { plan, out: compositeReference(plan) };
};

describe("component instances", () => {
  it("draw exactly like the equivalent precomp, repeatably", () => {
    // At component frame 10 of the keyframed width (20 to 120 over 20 frames) the plate is 70 wide.
    const withComponent = document([instance()]);
    const first = render(withComponent, 15, true);
    expect(first.plan.skipped).toEqual([]);
    expect(first.plan.layers.map((l) => l.type)).toEqual(["precomp"]);
    expect(render(withComponent, 15, true).out.pixels).toEqual(first.out.pixels);

    const inner = {
      id: "inner",
      name: "inner",
      ...SIZE,
      fps: { num: 30, den: 1 },
      durationFrames: 30,
      background: null,
      markers: [],
      layers: content(70, textColor),
    };
    const byHand = document(
      [layer("cmp", "precomp", { compositionId: "inner", inFrame: 5, startFrame: 5 })],
      [inner],
    );
    const expected = render(byHand, 15, true);
    expect(first.out.pixels).toEqual(expected.out.pixels);
    expect(first.out.pixels).not.toEqual(render(document([]), 15, true).out.pixels);
  });

  it("draw nothing before the instance starts", () => {
    const withComponent = render(document([instance()]), 3, true);
    const empty = render(document([]), 3, true);
    expect(withComponent.plan.layers).toEqual([]);
    expect(withComponent.plan.skipped).toEqual([]);
    expect(withComponent.out.pixels).toEqual(empty.out.pixels);
  });
});

describe("the capture page", () => {
  let capture: CaptureSession;
  beforeAll(async () => {
    capture = await launchTestCapture();
  }, 60_000);
  afterAll(async () => {
    await capture?.close();
  });

  it("evaluates component instances with a component host", async () => {
    const project = document([instance({ componentId: "nothing" })]);
    const err = await capture.captureFrames(project, [10]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).message).toContain("no component 'nothing'");
  }, 60_000);

  it("draws every built-in component with default props, with no fallbacks", async () => {
    // One instance over 90 frames, a frame in the middle of its hold.
    const long = (layers: Obj[]): Project => {
      const p = document(layers);
      return ProjectSchema.parse({
        ...p,
        compositions: p.compositions.map((c) => ({ ...c, durationFrames: 90 })),
      });
    };
    const [empty] = await capture.captureFrames(long([]), [45]);
    for (const component of BUILT_IN_COMPONENTS) {
      const project = long([
        layer("cmp", "component", {
          componentId: component.id,
          componentVersion: component.version,
          outFrame: 90,
          props: {},
        }),
      ]);
      const [frame] = await capture.captureFrames(project, [45]);
      expect({ id: component.id, skipped: frame?.skipped, warnings: frame?.warnings }).toEqual({
        id: component.id,
        skipped: [],
        warnings: [],
      });
      expect(
        Buffer.from(frame?.png ?? []).equals(Buffer.from(empty?.png ?? [])),
        component.id,
      ).toBe(false);
    }
  }, 120_000);
});
