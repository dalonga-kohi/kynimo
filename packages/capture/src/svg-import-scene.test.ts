import { readFileSync, writeFileSync } from "node:fs";
import { SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { importSvg, type SvgImportResult } from "@kynimo/svg";
import { describe, expect, it } from "vitest";

/**
 * Builds `reference/svg-import/scene.json` from its SVG sources with `importSvg`, placing each
 * layer as `import_svg` does (viewBox centre at `position`, scale per `preserveAspectRatio`, times
 * `width / size.width`). The test fails when the checked-in JSON is stale;
 * `KYNIMO_UPDATE_GOLDEN=1` rewrites it (then re-approve the frames, see reference/README.md).
 */
const DIR = new URL("../reference/svg-import/", import.meta.url);
const UPDATE = process.env.KYNIMO_UPDATE_GOLDEN === "1";
const FRAMES = 60;

type Obj = Record<string, unknown>;
const prop = (value: unknown) => ({ value });
const kf = (frame: number, value: unknown) => ({
  frame,
  value,
  interpolation: { type: "bezier", x1: 0.2, y1: 0, x2: 0, y2: 1 },
});

function svgLayer(
  id: string,
  result: SvgImportResult,
  placement: { width: number; position: unknown; scale?: unknown; opacity?: unknown },
  transform: Obj = {},
): Obj {
  const k = placement.width / result.size.width;
  return {
    id,
    name: id,
    type: "shape",
    inFrame: 0,
    outFrame: FRAMES,
    startFrame: 0,
    hidden: false,
    solo: false,
    editor: { locked: false, shy: false, label: null },
    markers: [],
    parent: null,
    threeD: false,
    transform: {
      anchorPoint: prop(result.anchorPoint),
      position: prop(placement.position),
      positionZ: prop(0),
      scale: prop([result.scale[0] * k, result.scale[1] * k]),
      rotation: prop(0),
      rotationX: prop(0),
      rotationY: prop(0),
      skew: prop(0),
      opacity: prop(1),
      ...transform,
    },
    blendMode: "normal",
    matte: null,
    masks: [],
    contents: result.contents,
  };
}

export function buildSvgImportScene(): unknown {
  const read = (name: string) => readFileSync(new URL(name, DIR), "utf8");
  const logo = importSvg(read("source.svg"));
  const icon = importSvg(read("icon.svg"));
  const s = logo.scale[0] * (200 / logo.size.width);
  const t = icon.scale[0] * (96 / icon.size.width);
  return {
    formatVersion: SCENE_FORMAT_VERSION,
    name: "Reference: SVG import",
    mainCompositionId: "main",
    style: null,
    assets: [],
    compositions: [
      {
        id: "main",
        name: "main",
        width: 640,
        height: 360,
        fps: { num: 30, den: 1 },
        durationFrames: FRAMES,
        background: "#0b0d17",
        markers: [],
        layers: [
          svgLayer(
            "logo",
            logo,
            { width: 200, position: [190, 180] },
            {
              scale: { keyframes: [kf(0, [s * 0.5, s * 0.5]), kf(24, [s, s])] },
              rotation: { keyframes: [kf(0, -40), kf(24, 0)] },
              opacity: { keyframes: [kf(0, 0), kf(12, 1)] },
            },
          ),
          svgLayer(
            "icon",
            icon,
            { width: 96, position: [440, 150] },
            {
              scale: { keyframes: [kf(8, [t * 0.4, t * 0.4]), kf(32, [t, t])] },
              opacity: { keyframes: [kf(8, 0), kf(20, 1)] },
            },
          ),
          svgLayer(
            "icon-small",
            icon,
            { width: 32, position: [560, 150] },
            { opacity: { keyframes: [kf(16, 0), kf(28, 1)] } },
          ),
        ],
      },
    ],
  } satisfies Obj;
}

describe("svg-import reference scene", () => {
  it("scene.json is what the SVG sources import to", () => {
    const built = JSON.parse(JSON.stringify(buildSvgImportScene()));
    const file = new URL("scene.json", DIR);
    if (UPDATE) writeFileSync(file, `${JSON.stringify(built, null, 2)}\n`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(built);
  });

  it("imports without anything dropped or approximated", () => {
    for (const name of ["source.svg", "icon.svg"])
      expect(importSvg(readFileSync(new URL(name, DIR), "utf8")).report.entries).toEqual([]);
  });
});
