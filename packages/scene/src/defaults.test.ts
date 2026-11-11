import { describe, expect, it } from "vitest";
import { withLayerDefaults } from "./defaults.js";

const size = { width: 1000, height: 400, durationFrames: 60 } as never;

describe("withLayerDefaults", () => {
  it("fills the shared fields, centered in the composition, and keeps what is given", () => {
    const out = withLayerDefaults(
      { type: "solid", name: "S", outFrame: 10, transform: { opacity: { value: 0.5 } } },
      size,
    ) as {
      inFrame: number;
      outFrame: number;
      parent: unknown;
      masks: unknown;
      transform: { position: unknown; opacity: unknown };
    };
    expect(out.inFrame).toBe(0);
    expect(out.outFrame).toBe(10);
    expect(out.parent).toBeNull();
    expect(out.transform.position).toEqual({ value: [500, 200] });
    expect(out.transform.opacity).toEqual({ value: 0.5 });
    expect(out.masks).toEqual([]);
  });

  it("gives audio no transform and text animators", () => {
    const audio = withLayerDefaults({ type: "audio" }, size) as Record<string, unknown>;
    expect(audio.transform).toBeUndefined();
    expect(audio.volume).toEqual({ value: 1 });
    expect(
      (withLayerDefaults({ type: "text" }, size) as Record<string, unknown>).animators,
    ).toEqual([]);
  });

  it("passes non-objects and typeless input through", () => {
    expect(withLayerDefaults(3, size)).toBe(3);
    const x = { name: "x" };
    expect(withLayerDefaults(x, size)).toBe(x);
  });
});
