import {
  BLEND_MODES,
  EffectSchema,
  GeneratorSchema,
  LayerSchema,
  MASK_MODES,
  PaintSchema,
  TrackMatteSchema,
  TransitionSchema,
} from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import {
  BLEND_MODE_SUPPORT,
  EFFECT_SUPPORT,
  GENERATOR_SUPPORT,
  LAYER_SUPPORT,
  MASK_MODE_SUPPORT,
  MATTE_MODE_SUPPORT,
  PAINT_SUPPORT,
  TRANSITION_SUPPORT,
} from "./capabilities.js";

const sorted = (values: Iterable<string>) => [...values].sort();

describe("renderer capabilities", () => {
  it("has an entry for every layer type in the schema", () => {
    const types = LayerSchema.options.map((o) => o.shape.type.value);
    expect(sorted(Object.keys(LAYER_SUPPORT))).toEqual(sorted(types));
  });

  it("covers every blend, mask, matte and paint the schema accepts", () => {
    expect(sorted(Object.keys(BLEND_MODE_SUPPORT))).toEqual(sorted(BLEND_MODES));
    expect(sorted(Object.keys(MASK_MODE_SUPPORT))).toEqual(sorted(MASK_MODES));
    expect(sorted(Object.keys(MATTE_MODE_SUPPORT))).toEqual(
      sorted(TrackMatteSchema.shape.mode.options),
    );
    expect(sorted(Object.keys(PAINT_SUPPORT))).toEqual(
      sorted(PaintSchema.options.map((o) => o.shape.type.value)),
    );
  });

  it("draws generator layers, every generator kind and every effect", () => {
    expect(sorted(Object.keys(GENERATOR_SUPPORT))).toEqual(
      sorted(GeneratorSchema.options.map((o) => o.shape.type.value)),
    );
    expect(sorted(Object.keys(EFFECT_SUPPORT))).toEqual(
      sorted(EffectSchema.options.map((o) => o.shape.type.value)),
    );
    for (const support of [
      LAYER_SUPPORT.generator,
      ...Object.values(GENERATOR_SUPPORT),
      ...Object.values(EFFECT_SUPPORT),
    ])
      expect(support.status).toBe("renders");
  });

  it("draws every transition kind the schema accepts", () => {
    expect(sorted(Object.keys(TRANSITION_SUPPORT))).toEqual(
      sorted(TransitionSchema.options.map((o) => o.shape.kind.value)),
    );
    for (const support of Object.values(TRANSITION_SUPPORT)) expect(support.status).toBe("renders");
  });

  it("gives a reason for everything it accepts without rendering", () => {
    for (const [type, support] of Object.entries(LAYER_SUPPORT))
      if (support.status === "accepted") expect(support.reason, type).not.toBe("");
  });
});
