import { keynote } from "@kynimo/guidelines";
import { describe, expect, it } from "vitest";
import { applied, doc, keyed, kf, layerOf, lid, solid } from "./fixtures.test-util.js";
import { stagger, staggerDelays } from "./stagger.js";

const fps = { num: 30, den: 1 };
const delays = (n: number, t: Parameters<typeof staggerDelays>[1]) =>
  staggerDelays(n, t, keynote, fps);

describe("staggerDelays", () => {
  it("orders by index, reversed and from the center", () => {
    expect(delays(4, {})).toEqual([0, 3, 6, 9]);
    expect(delays(4, { order: "reverse" })).toEqual([9, 6, 3, 0]);
    // Equal ranks share a delay.
    expect(delays(4, { order: "center-out" })).toEqual([3, 0, 0, 3]);
    expect(delays(5, { order: "center-out" })).toEqual([6, 3, 0, 3, 6]);
  });

  it("shapes the gaps with the rhythm", () => {
    expect(delays(3, { offset: 300, rhythm: "even" })).toEqual([0, 9, 18]);
    expect(delays(3, { offset: 300, rhythm: "accelerate" })).toEqual([0, 14, 18]);
    expect(delays(3, { offset: 300, rhythm: "decelerate" })).toEqual([0, 5, 18]);
    const accelerate = delays(6, { rhythm: "accelerate" });
    const gaps = accelerate.slice(1).map((d, i) => d - (accelerate[i] as number));
    expect(gaps[0]).toBeGreaterThanOrEqual(gaps[gaps.length - 1] as number);
  });

  it("applies rhythm to center-out ranks", () => {
    expect(delays(5, { order: "center-out", offset: 300, rhythm: "decelerate" })).toEqual([
      18, 5, 0, 5, 18,
    ]);
  });

  it("resolves offset tokens and handles a single target and a zero offset", () => {
    expect(delays(3, { offset: "loose" })).toEqual([0, 5, 11]);
    expect(delays(1, { rhythm: "accelerate" })).toEqual([0]);
    expect(delays(3, { offset: 0 })).toEqual([0, 0, 0]);
  });

  it("shuffles deterministically from the seed", () => {
    const a = delays(8, { order: "random", seed: 3 });
    expect(delays(8, { order: "random", seed: 3 })).toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual(delays(8, {}));
    expect(delays(8, { order: "random" })).toEqual(delays(8, { order: "random", seed: 0 }));
    expect(delays(8, { order: "random", seed: 1 })).not.toEqual(
      delays(8, { order: "random", seed: 2 }),
    );
  });
});

describe("stagger", () => {
  const fade = () => ({ transform: { opacity: keyed(kf(0, 0), kf(10, 1)) } });
  const d = doc([solid("a", fade()), solid("b", fade()), solid("c", fade())]);

  it("shifts each layer's keyframes by its delay and applies cleanly", () => {
    const { ops, resolved } = stagger(d, { layers: [lid("a"), lid("b"), lid("c")] });
    expect(resolved).toMatchObject({ delays_frames: [0, 3, 6], layer_ids: ["a", "b", "c"] });
    const out = applied(d, ops);
    const frames = (id: string) =>
      (
        layerOf(out, id) as unknown as {
          transform: { opacity: { keyframes: { frame: number }[] } };
        }
      ).transform.opacity.keyframes.map((k) => k.frame);
    expect(frames("a")).toEqual([0, 10]);
    expect(frames("b")).toEqual([3, 13]);
    expect(frames("c")).toEqual([6, 16]);
    expect(layerOf(out, "c")).toMatchObject({ inFrame: 0, outFrame: 90, startFrame: 0 });
  });

  it("compounds on repeated calls", () => {
    const once = applied(d, stagger(d, { layers: [lid("a"), lid("b"), lid("c")] }).ops);
    const twice = applied(once, stagger(once, { layers: [lid("a"), lid("b"), lid("c")] }).ops);
    const first = (id: string) =>
      (
        layerOf(twice, id) as unknown as {
          transform: { opacity: { keyframes: { frame: number }[] } };
        }
      ).transform.opacity.keyframes[0]?.frame;
    expect(first("c")).toBe(12);
  });

  it("refuses when every delay is 0, since nothing would move", () => {
    const track = { opacity: keyed(kf(0, 0), kf(10, 1)) };
    const d = doc([solid("a", { transform: track }), solid("b", { transform: track })]);
    expect(() => stagger(d, { layers: [lid("a"), lid("b")], offset: 0 })).toThrow(
      expect.objectContaining({
        path: ["offset"],
        message: expect.stringContaining("every delay is 0"),
      }),
    );
  });

  it("needs two layers and refuses one with nothing animated, at its target", () => {
    expect(() => stagger(d, { layers: lid("a") })).toThrow(
      expect.objectContaining({ path: ["layers"] }),
    );
    const plain = doc([solid("a", fade()), solid("b")]);
    expect(() => stagger(plain, { layers: [lid("a"), lid("b")] })).toThrow(
      expect.objectContaining({
        path: ["layers", 1],
        message: expect.stringContaining("nothing animated to stagger"),
      }),
    );
  });
});
