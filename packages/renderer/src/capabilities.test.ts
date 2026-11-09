import { BLEND_MODES, LayerSchema, MASK_MODES, PaintSchema, TrackMatteSchema } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import {
  BLEND_MODE_SUPPORT,
  LAYER_SUPPORT,
  MASK_MODE_SUPPORT,
  MATTE_MODE_SUPPORT,
  PAINT_SUPPORT,
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

  it("gives a reason for everything it accepts without rendering", () => {
    for (const [type, support] of Object.entries(LAYER_SUPPORT))
      if (support.status === "accepted") expect(support.reason, type).not.toBe("");
  });
});
