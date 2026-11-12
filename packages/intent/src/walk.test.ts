import type { Layer } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { IntentError } from "./errors.js";
import {
  animator,
  applied,
  doc,
  keyed,
  kf,
  layerOf,
  mask,
  rect,
  shape,
  solid,
  text,
  wiggle,
} from "./fixtures.test-util.js";
import { diffLayerOps, listKeyframeTracks, mapLayerKeyframes } from "./walk.js";

const plus10 = (f: number) => f + 10;
const frames = (layer: Layer) =>
  listKeyframeTracks(layer).map((t) => [t.path.join("."), t.keyframes.map((k) => k.frame)]);

describe("mapLayerKeyframes", () => {
  it("moves transform keyframes, including separate X/Y and spatial position keys", () => {
    const d = doc([
      solid("a", {
        transform: {
          opacity: keyed(kf(0, 0), kf(5, 1)),
          position: {
            keyframes: [
              { ...kf(0, [0, 0]), spatial: { inTangent: [0, 0], outTangent: [5, 5] } },
              kf(8, [10, 10]),
            ],
          },
        },
      }),
      solid("b", {
        transform: {
          position: { separate: { x: keyed(kf(2, 0), kf(4, 1)), y: { value: 3 } } },
        },
      }),
    ]);
    const a = mapLayerKeyframes(layerOf(d, "a"), plus10);
    expect(frames(a)).toEqual([
      ["transform.position.keyframes", [10, 18]],
      ["transform.opacity.keyframes", [10, 15]],
    ]);
    expect(listKeyframeTracks(a)[0]?.keyframes[0]).toMatchObject({
      spatial: { outTangent: [5, 5] },
    });
    const b = mapLayerKeyframes(layerOf(d, "b"), plus10);
    expect(frames(b)).toEqual([["transform.position.separate.x.keyframes", [12, 14]]]);
  });

  it("moves mask, behavior, animator and shape content keyframes", () => {
    const d = doc([
      solid("m", { masks: [mask("k1", { opacity: keyed(kf(0, 0), kf(4, 1)) })] }),
      solid("w", { behaviors: [wiggle("w1", { frequency: keyed(kf(1, 1), kf(9, 3)) })] }),
      text("t", { animators: [animator(keyed(kf(0, 0), kf(30, 1)))] }),
      shape("s", [rect("r", { size: keyed(kf(0, [1, 1]), kf(20, [9, 9])) })]),
    ]);
    expect(frames(mapLayerKeyframes(layerOf(d, "m"), plus10))).toEqual([
      ["masks.0.opacity.keyframes", [10, 14]],
    ]);
    expect(frames(mapLayerKeyframes(layerOf(d, "w"), plus10))).toEqual([
      ["behaviors.0.frequency.keyframes", [11, 19]],
    ]);
    expect(frames(mapLayerKeyframes(layerOf(d, "t"), plus10))).toEqual([
      ["animators.0.selector.end.keyframes", [10, 40]],
    ]);
    expect(frames(mapLayerKeyframes(layerOf(d, "s"), plus10))).toEqual([
      ["contents.0.size.keyframes", [10, 30]],
    ]);
  });

  it("does not mutate its input and leaves constant tracks alone", () => {
    const d = doc([solid("a", { transform: { opacity: keyed(kf(0, 0), kf(5, 1)) } })]);
    const before = layerOf(d, "a");
    const snapshot = JSON.stringify(before);
    mapLayerKeyframes(before, plus10);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(frames(mapLayerKeyframes(layerOf(doc([solid("c")]), "c"), plus10))).toEqual([]);
  });

  it("moves transition parameter keyframes, progress included", () => {
    const d = doc([
      solid("t", {
        transition: {
          kind: "wipe",
          progress: keyed(kf(0, 0), kf(30, 1)),
          angle: keyed(kf(0, 0), kf(30, 90)),
          feather: { value: 20 },
        },
      }),
    ]);
    expect(frames(mapLayerKeyframes(layerOf(d, "t"), plus10))).toEqual([
      ["transition.progress.keyframes", [10, 40]],
      ["transition.angle.keyframes", [10, 40]],
    ]);
  });

  it("refuses keyframed fields no operation can write back", () => {
    const d = doc([
      text("t", { font: { family: "Inter", weight: 400, size: keyed(kf(0, 40), kf(9, 60)) } }),
    ]);
    expect(() => mapLayerKeyframes(layerOf(d, "t"), plus10)).toThrow(IntentError);
    expect(() => mapLayerKeyframes(layerOf(d, "t"), plus10)).toThrow("font.size");
  });
});

describe("diffLayerOps", () => {
  it("produces no ops for identical layers", () => {
    const d = doc([solid("a")]);
    expect(diffLayerOps(layerOf(d, "a"), layerOf(d, "a"))).toEqual([]);
  });

  it("writes a moved transition back as one updateLayer", () => {
    const d = doc([
      solid("t", {
        transition: { kind: "dissolve", progress: keyed(kf(0, 0), kf(30, 1)) },
      }),
    ]);
    const before = layerOf(d, "t");
    const after = mapLayerKeyframes(before, plus10);
    const ops = diffLayerOps(before, after);
    expect(ops).toEqual([
      {
        op: "updateLayer",
        layer: "t",
        set: { transition: { kind: "dissolve", progress: keyed(kf(10, 0), kf(40, 1)) } },
      },
    ]);
    expect(layerOf(applied(d, ops), "t")).toEqual(after);
  });

  it("writes back every kind of change, in order, and the result matches the mapped layer", () => {
    const d = doc([
      solid("m", {
        transform: { opacity: keyed(kf(0, 0), kf(5, 1)) },
        masks: [mask("k1", { opacity: keyed(kf(0, 0), kf(4, 1)) }), mask("k2")],
        behaviors: [wiggle("w1", { frequency: keyed(kf(1, 1), kf(9, 3)) })],
      }),
      text("t", { animators: [animator(keyed(kf(0, 0), kf(30, 1)))] }),
      shape("s", [rect("r", { size: keyed(kf(0, [1, 1]), kf(20, [9, 9])) })]),
    ]);
    const check = (id: string) => {
      const before = layerOf(d, id);
      const after = mapLayerKeyframes(before, plus10);
      const ops = diffLayerOps(before, after);
      expect(layerOf(applied(d, ops), id)).toEqual(after);
      return ops;
    };
    expect(check("m").map((o) => o.op)).toEqual([
      "setTransformTrack",
      "updateMask",
      "updateBehavior",
    ]);
    const [, mask1, behavior] = check("m");
    expect(mask1).toMatchObject({ mask: "k1", set: { opacity: expect.anything() } });
    expect(Object.keys((mask1 as { set: object }).set)).toEqual(["opacity"]);
    expect(Object.keys((behavior as { set: object }).set)).toEqual(["frequency"]);
    expect(check("t").map((o) => o.op)).toEqual(["setTextAnimators"]);
    expect(check("s").map((o) => o.op)).toEqual(["setShapeContents"]);
  });
});
