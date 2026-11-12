import { describe, expect, it } from "vitest";
import {
  common,
  composition,
  issues,
  nullLayer,
  type Obj,
  project,
  prop,
  visual,
} from "./fixtures.test-util.js";
import {
  applyOps,
  LayerPatchSchema,
  MotionBlurSchema,
  type Project,
  ProjectSchema,
} from "./index.js";
import { solid } from "./ops.test-util.js";

const doc = (layers: Obj[]): Project =>
  ProjectSchema.parse(project({ compositions: [composition("main", layers)] }));

describe("MotionBlurSchema", () => {
  it("fills the defaults from an empty object", () => {
    expect(MotionBlurSchema.parse({})).toEqual({
      shutterAngle: 180,
      shutterPhase: -90,
      samples: 16,
    });
  });

  it.each([
    ["angle 721", { shutterAngle: 721 }],
    ["angle -1", { shutterAngle: -1 }],
    ["phase -361", { shutterPhase: -361 }],
    ["phase 361", { shutterPhase: 361 }],
    ["samples 1", { samples: 1 }],
    ["samples 65", { samples: 65 }],
    ["samples 2.5", { samples: 2.5 }],
    ["NaN angle", { shutterAngle: Number.NaN }],
    ["Infinity phase", { shutterPhase: Number.POSITIVE_INFINITY }],
    ["unknown key", { extra: 1 }],
  ])("rejects %s", (_n, input) => {
    expect(MotionBlurSchema.safeParse(input).success).toBe(false);
  });

  it("accepts the bounds", () => {
    expect(
      MotionBlurSchema.safeParse({ shutterAngle: 720, shutterPhase: -360, samples: 64 }).success,
    ).toBe(true);
    expect(
      MotionBlurSchema.safeParse({ shutterAngle: 0, shutterPhase: 360, samples: 2 }).success,
    ).toBe(true);
  });
});

describe("layer motion blur", () => {
  it("defaults to null on drawn layers written without it", () => {
    const d = doc([solid("s")]);
    expect(d.compositions[0]?.layers[0]).toMatchObject({ motionBlur: null });
  });

  it("is not a field of null layers", () => {
    expect(doc([nullLayer("n")]).compositions[0]?.layers[0]).not.toHaveProperty("motionBlur");
  });

  it("updateLayer switches it on with defaults and off again", () => {
    const d = doc([solid("s")]);
    const set = LayerPatchSchema.parse({ motionBlur: {} });
    expect(set).toEqual({ motionBlur: { shutterAngle: 180, shutterPhase: -90, samples: 16 } });
    const on = applyOps(d, [{ op: "updateLayer", layer: "s", set: { motionBlur: {} } }]);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.doc.compositions[0]?.layers[0]).toMatchObject({
      motionBlur: { shutterAngle: 180, shutterPhase: -90, samples: 16 },
    });
    const off = applyOps(on.doc, [{ op: "updateLayer", layer: "s", set: { motionBlur: null } }]);
    expect(off.ok && off.doc.compositions[0]?.layers[0]).toMatchObject({ motionBlur: null });
  });

  it("rejects motion blur on an adjustment layer with a pathed issue", () => {
    const found = issues(
      project({
        compositions: [
          composition("main", [
            {
              ...visual("a"),
              type: "adjustment",
              motionBlur: { shutterAngle: 180, shutterPhase: -90, samples: 16 },
            },
          ]),
        ],
      }),
    );
    expect(found).toContainEqual({
      path: "compositions.0.layers.0.motionBlur",
      message: "adjustment layers have no motion blur; set motionBlur to null",
    });
  });

  describe("updateLayer on layers without motion blur", () => {
    const withTypes = () =>
      ProjectSchema.parse(
        project({
          assets: [
            {
              id: "m",
              type: "audio",
              name: "M",
              uri: "assets/u.bin",
              sha256: "a".repeat(64),
              durationMs: 1000,
            },
          ],
          compositions: [
            composition("main", [
              solid("s"),
              nullLayer("n"),
              { ...visual("a"), type: "adjustment", effects: [], motionBlur: null },
              { ...common("snd"), type: "audio", assetId: "m", volume: prop(1) },
            ]),
          ],
        }),
      );
    const set = (layer: string, motionBlur: unknown) =>
      applyOps(withTypes(), [{ op: "updateLayer", layer, set: { motionBlur } } as never]);
    const fails = (layer: string, motionBlur: unknown, message: string) => {
      const r = set(layer, motionBlur);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors).toContainEqual({ path: ["ops", 0, "set", "motionBlur"], message });
    };

    it("fails on a null layer", () =>
      fails(
        "n",
        {},
        "layer 'n' is a null layer and has no motion blur; set motionBlur on its drawn children (a null's motion still blurs them)",
      ));
    it("fails on an audio layer", () =>
      fails("snd", {}, "layer 'snd' is an audio layer and has no motion blur"));
    it("fails on an adjustment layer unless null", () => {
      fails("a", {}, "adjustment layers have no motion blur; set motionBlur to null");
      expect(set("a", null).ok).toBe(true);
    });
  });
});
