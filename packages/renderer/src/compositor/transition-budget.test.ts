import { describe, expect, it, vi } from "vitest";
import type { FramePlan, PlannedLayer } from "../raster.js";
import { transitionSamples } from "./effects.js";
import { compositeReference } from "./reference.js";

// A small budget, so the cumulative per-frame charge is reached in milliseconds instead of by
// compositing hundreds of millions of pixels. The real budget is 500M samples.
const BUDGET = 5_000_000;
vi.mock("./effects.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./effects.js")>()),
  MAX_FRAME_EFFECT_SAMPLES: 5_000_000,
}));

const layer = (id: string): PlannedLayer =>
  ({
    id,
    type: "solid",
    space: "layer",
    opacity: 1,
    blendMode: "normal",
    mask: null,
    matte: null,
    matrix: [1, 0, 0, 1, 0, 0],
    raster: { width: 1, height: 1, pixels: new Uint8Array([0, 0, 255, 255]) },
    transition: { kind: "glitch", progress: 0.5, seed: 1, bands: 4, amount: 0.1 },
  }) as unknown as PlannedLayer;

describe("transition frame budget", () => {
  it("is cumulative per frame and names the layer that crosses it", () => {
    const size = 128;
    const perLayer = size * size * transitionSamples("glitch");
    const crossing = Math.floor(BUDGET / perLayer) + 1;
    const count = crossing + 2;
    // Layers composite bottom-up (last in the array first), so the crossing one sits at count - crossing.
    const plan: FramePlan = {
      width: size,
      height: size,
      background: null,
      layers: Array.from({ length: count }, (_, i) => layer(`t${i}`)),
      skipped: [],
      warnings: [],
    };
    expect(() => compositeReference(plan)).toThrow(
      new RegExp(
        `layer 't${count - crossing}' exceeds the frame budget.*reduce the composition size or number of transitions`,
      ),
    );
    // One layer fewer than the crossing count still fits.
    expect(() =>
      compositeReference({ ...plan, layers: plan.layers.slice(0, crossing - 1) }),
    ).not.toThrow();
  });
});
