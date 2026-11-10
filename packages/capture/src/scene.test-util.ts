import { readFileSync } from "node:fs";
import { SCENE_FORMAT_VERSION } from "@kynimo/scene";

/**
 * The determinism scene: one document that reaches every part of the capture pipeline, animated
 * so different frames exercise different values. It guards repeatability, not looks; the
 * reference scenes (ADR-0018) are where frames are reviewed by eye.
 */

type Obj = Record<string, unknown>;

export const CHECKER_PNG = new Uint8Array(
  readFileSync(new URL("../fixtures/checker.png", import.meta.url)),
);
const CHECKER_SHA256 = "5113dec02407ff3dd104d5d72ab7b0e166d26b5461e1a28f30d73565cfa336a1";

const prop = (value: unknown) => ({ value });
const kf = (frame: number, value: unknown, interpolation: Obj = { type: "linear" }) => ({
  frame,
  value,
  interpolation,
});
const track = (...keyframes: unknown[]) => ({ keyframes });
const EASE = { type: "bezier", x1: 0.2, y1: 0, x2: 0, y2: 1 };
const SPRING = { type: "spring", damping: 0.6, response: 0.4 };

const transform = (overrides: Obj = {}): Obj => ({
  anchorPoint: prop([0, 0]),
  position: prop([0, 0]),
  scale: prop([1, 1]),
  rotation: prop(0),
  skew: prop(0),
  opacity: prop(1),
  ...overrides,
});

const layer = (id: string, type: string, overrides: Obj = {}): Obj => ({
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
  ...(type === "null" ? {} : { blendMode: "normal", matte: null, masks: [] }),
  type,
  ...overrides,
});

let items = 0;
const item = (type: string, fields: Obj): Obj => ({
  id: `${type}${++items}`,
  name: type,
  type,
  ...fields,
});
const fill = (paint: Obj) => item("fill", { paint, opacity: prop(1), rule: "nonzero" });
const stops = (...s: [number, string][]) => prop(s.map(([offset, color]) => ({ offset, color })));

const box = (x: number, y: number, w: number, h: number) => ({
  closed: true,
  vertices: [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ].map((point) => ({ point, inTangent: [0, 0], outTangent: [0, 0] })),
});

/** 160×90 card: gradient rounded rect, dashed stroke, and an image parented to a moving null. */
const card = {
  id: "card",
  name: "card",
  width: 160,
  height: 90,
  fps: { num: 30, den: 1 },
  durationFrames: 30,
  background: null,
  markers: [],
  layers: [
    layer("pic", "image", {
      assetId: "checker",
      parent: "rig",
      transform: transform({ scale: prop([2.5, 2.5]), rotation: prop(12) }),
    }),
    layer("rig", "null", {
      transform: transform({ position: track(kf(0, [20, 20], EASE), kf(29, [110, 40])) }),
    }),
    layer("panel", "shape", {
      contents: [
        item("rect", { position: prop([80, 45]), size: prop([150, 80]), cornerRadius: prop(14) }),
        fill({
          type: "linear-gradient",
          start: prop([0, 0]),
          end: prop([160, 90]),
          stops: stops([0, "#2a6cf0"], [0.6, "#9b3fe0"], [1, "#f04f7a"]),
        }),
        item("stroke", {
          paint: { type: "solid", color: prop("#ffffffcc") },
          opacity: prop(1),
          width: prop(3),
          cap: "round",
          join: "round",
          miterLimit: 4,
          dashes: [10, 6],
          dashOffset: track(kf(0, 0), kf(29, 32)),
        }),
      ],
    }),
  ],
};

const main = {
  id: "main",
  name: "main",
  width: 320,
  height: 180,
  fps: { num: 30, den: 1 },
  durationFrames: 30,
  background: "#0e1420",
  markers: [],
  layers: [
    // Masked reveal: text behind an animated, feathered mask.
    layer("title", "text", {
      content: { value: "Kynimo ﬁne Ünïcødé" },
      box: { mode: "point" },
      font: { family: "Inter", weight: 600, size: prop(26) },
      tracking: prop(0.02),
      leading: prop(1.2),
      align: "left",
      textCase: "none",
      animators: [],
      fill: prop("#ffffff"),
      transform: transform({ position: prop([18, 150]), opacity: track(kf(0, 0.3), kf(20, 1)) }),
      masks: [
        {
          id: "reveal",
          name: "reveal",
          mode: "add",
          inverted: false,
          path: track(kf(0, box(0, -30, 20, 40), EASE), kf(24, box(0, -30, 300, 40))),
          feather: prop([6, 0]),
          opacity: prop(1),
          expansion: prop(0),
        },
      ],
    }),
    // Track matte: a band shown only where the hidden wipe is.
    layer("band", "solid", {
      width: 320,
      height: 24,
      color: "#ffd166",
      blendMode: "overlay",
      transform: transform({ position: prop([0, 6]) }),
      matte: { layerId: "wipe", mode: "luma" },
    }),
    layer("wipe", "shape", {
      hidden: true,
      contents: [
        item("ellipse", {
          position: track(kf(0, [0, 18]), kf(29, [320, 18])),
          size: prop([120, 60]),
        }),
        fill({
          type: "radial-gradient",
          center: track(kf(0, [0, 18]), kf(29, [320, 18])),
          radius: prop(60),
          stops: stops([0, "#ffffff"], [1, "#000000"]),
        }),
      ],
    }),
    layer("glow", "shape", {
      blendMode: "screen",
      contents: [
        item("ellipse", { position: prop([240, 70]), size: prop([140, 140]) }),
        fill({
          type: "radial-gradient",
          center: prop([240, 70]),
          radius: prop(70),
          stops: stops([0, "#ff7a3d"], [1, "#ff7a3d00"]),
        }),
      ],
    }),
    // Nested precomp, transformed: placed with resampling and minified a little.
    layer("card", "precomp", {
      compositionId: "card",
      transform: transform({
        anchorPoint: prop([80, 45]),
        position: prop([150, 80]),
        rotation: track(kf(0, -8, SPRING), kf(26, 4)),
        scale: prop([0.85, 0.85]),
      }),
    }),
  ],
};

export const DETERMINISM_SCENE = {
  formatVersion: SCENE_FORMAT_VERSION,
  name: "Determinism",
  mainCompositionId: "main",
  style: null,
  assets: [
    {
      id: "checker",
      name: "checker",
      type: "image",
      uri: "assets/checker.png",
      sha256: CHECKER_SHA256,
      width: 16,
      height: 16,
    },
  ],
  compositions: [main, card],
};

export const DETERMINISM_ASSETS: ReadonlyMap<string, Uint8Array> = new Map([
  ["checker", CHECKER_PNG],
]);

/** Kinetic type: a keyframed range sweeps characters up, tinted and rotated (ADR-0038). */
export const ANIMATED_TEXT_SCENE = {
  formatVersion: SCENE_FORMAT_VERSION,
  name: "Animated text",
  mainCompositionId: "main",
  style: null,
  assets: [],
  compositions: [
    {
      id: "main",
      name: "main",
      width: 320,
      height: 120,
      fps: { num: 30, den: 1 },
      durationFrames: 30,
      background: "#0e1420",
      markers: [],
      layers: [
        layer("title", "text", {
          content: { value: "Kinetic type" },
          box: { mode: "point" },
          font: { family: "Inter", weight: 800, size: prop(44) },
          tracking: prop(0),
          leading: prop(1.2),
          align: "left",
          textCase: "none",
          fill: prop("#ffffff"),
          transform: transform({ position: prop([20, 75]) }),
          animators: [
            {
              name: "rise",
              selector: {
                unit: "characters",
                start: prop(0),
                end: track(kf(0, 0), kf(20, 1)),
                offset: prop(0),
                shape: "ramp-up",
                easeHigh: prop(0.3),
                easeLow: prop(0),
                order: "forward",
                seed: 0,
                amount: prop(1),
              },
              properties: {
                position: prop([0, -18]),
                rotation: prop(-15),
                opacity: prop(0.2),
                fill: prop("#33aaff"),
                tracking: prop(60),
              },
            },
          ],
        }),
      ],
    },
  ],
};
