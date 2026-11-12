import { describe, expect, it } from "vitest";
import { IntentError } from "./errors.js";
import { applied, doc, layerOf, lid, solid } from "./fixtures.test-util.js";
import { addTransition } from "./transition.js";

interface Kf {
  frame: number;
  value: number;
}
interface TransitionJson {
  progress: { keyframes: Kf[] };
  [field: string]: unknown;
}

const sel = (id: string) => lid(id);

function transitionOf(project: ReturnType<typeof doc>, id: string) {
  return (layerOf(project, id) as unknown as { transition: TransitionJson }).transition;
}

function refusal(fn: () => unknown): IntentError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(IntentError);
    return e as IntentError;
  }
  throw new Error("expected an IntentError");
}

describe("addTransition", () => {
  it("builds an in edge with defaults sized to the composition", () => {
    const d = doc([solid("a", { inFrame: 10, outFrame: 100, startFrame: 4 })]);
    const { ops, resolved } = addTransition(d, { layer: sel("a"), kind: "wipe" });
    expect(resolved).toMatchObject({
      layer: "a",
      kind: "wipe",
      edge: "in",
      from_frame: 10,
      to_frame: 10 + resolved.duration_frames,
    });
    const t = transitionOf(applied(d, ops), "a");
    expect(t.progress.keyframes.map((k: Kf) => [k.frame, k.value])).toEqual([
      [6, 0],
      [6 + resolved.duration_frames, 1],
    ]);
    expect(t.angle).toEqual({ value: 0 });
    expect(t.feather).toEqual({ value: 77 });
  });

  it("centres point kinds in the composition and seeds from the layer id", () => {
    const d = doc([solid("a"), solid("b")]);
    const first = addTransition(d, { layer: sel("a"), kind: "glitch" }).ops;
    const again = addTransition(d, { layer: sel("a"), kind: "glitch" }).ops;
    expect(first).toEqual(again);
    const other = addTransition(d, { layer: sel("b"), kind: "glitch" }).ops;
    const seed = (ops: typeof first) =>
      (ops[0] as { set: { transition: { seed: number } } }).set.transition.seed;
    expect(Number.isInteger(seed(first))).toBe(true);
    expect(seed(first)).not.toBe(seed(other));
    const iris = transitionOf(
      applied(d, addTransition(d, { layer: sel("a"), kind: "iris" }).ops),
      "a",
    );
    expect(iris.center).toEqual({ value: [960, 540] });
    expect(iris.shape).toBe("circle");
  });

  it("builds an out edge that ends on the last frame, mirroring the direction", () => {
    const d = doc([solid("a", { outFrame: 90 })]);
    const { ops, resolved } = addTransition(d, { layer: sel("a"), kind: "wipe", edge: "out" });
    expect(resolved.to_frame).toBe(89);
    const t = transitionOf(applied(d, ops), "a");
    expect(t.progress.keyframes.map((k: Kf) => k.value)).toEqual([1, 0]);
    expect(t.progress.keyframes[1]?.frame).toBe(89);
    expect(t.angle).toEqual({ value: 180 });
    const clock = transitionOf(
      applied(d, addTransition(d, { layer: sel("a"), kind: "clock", edge: "out" }).ops),
      "a",
    );
    expect(clock.clockwise).toBe(false);
  });

  it("adds the other edge to the same kind, keeping fields", () => {
    const d = doc([solid("a")]);
    const one = applied(
      d,
      addTransition(d, { layer: sel("a"), kind: "wipe", params: { angle: { value: 90 } } }).ops,
    );
    const two = applied(
      one,
      addTransition(one, { layer: sel("a"), kind: "wipe", edge: "out" }).ops,
    );
    const t = transitionOf(two, "a");
    expect(t.angle).toEqual({ value: 90 });
    expect(t.progress.keyframes.map((k: Kf) => k.value)).toEqual([0, 1, 1, 0]);
    const frames = t.progress.keyframes.map((k: Kf) => k.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
  });

  it("replaces keyframes inside the window when an edge is added again", () => {
    const d = doc([solid("a")]);
    const one = applied(d, addTransition(d, { layer: sel("a"), kind: "dissolve" }).ops);
    const again = applied(
      one,
      addTransition(one, { layer: sel("a"), kind: "dissolve", duration: 600 }).ops,
    );
    expect(transitionOf(again, "a").progress.keyframes).toHaveLength(2);
    expect(transitionOf(again, "a").progress.keyframes[1]?.frame).toBe(18);
  });

  it("refuses a different kind or params on an existing transition", () => {
    const d = applied(
      doc([solid("a")]),
      addTransition(doc([solid("a")]), { layer: sel("a"), kind: "wipe" }).ops,
    );
    expect(refusal(() => addTransition(d, { layer: sel("a"), kind: "push" })).path).toEqual([
      "kind",
    ]);
    const e = refusal(() =>
      addTransition(d, { layer: sel("a"), kind: "wipe", params: { feather: { value: 1 } } }),
    );
    expect(e.path).toEqual(["params"]);
    expect(e.message).toContain("update_layer { transition: null }");
  });

  it("refuses adjustment layers and one-frame layers", () => {
    const { width: _w, height: _h, color: _c, ...rest } = solid("adj");
    const adj = { ...rest, type: "adjustment", effects: [] };
    const d = doc([adj, solid("one", { inFrame: 5, outFrame: 6 })]);
    expect(refusal(() => addTransition(d, { layer: sel("adj"), kind: "wipe" })).path).toEqual([
      "layer",
    ]);
    expect(refusal(() => addTransition(d, { layer: sel("one"), kind: "wipe" })).message).toContain(
      "one frame long",
    );
  });

  it("says 'an adjustment layer'", () => {
    const { width: _w, height: _h, color: _c, ...rest } = solid("adj");
    const d = doc([{ ...rest, type: "adjustment", effects: [] }]);
    expect(refusal(() => addTransition(d, { layer: sel("adj"), kind: "wipe" })).message).toContain(
      "is an adjustment layer",
    );
  });

  it("returns promptly on hostile angles, as an invalid params error", () => {
    const d = doc([solid("a")]);
    for (const kind of ["wipe", "push", "blinds"] as const)
      for (const big of [1e300, 1e15, -1e300]) {
        const byValue = refusal(() =>
          addTransition(d, {
            layer: sel("a"),
            kind,
            edge: "out",
            params: { angle: { value: big } },
          }),
        );
        expect(byValue.path.slice(0, 2)).toEqual(["params", "angle"]);
        const byKeyframes = refusal(() =>
          addTransition(d, {
            layer: sel("a"),
            kind,
            edge: "out",
            params: {
              angle: { keyframes: [{ frame: 0, value: big, interpolation: { type: "hold" } }] },
            },
          }),
        );
        expect(byKeyframes.path.slice(0, 2)).toEqual(["params", "angle"]);
      }
  });

  it("wraps a mirrored out angle back into range", () => {
    const d = doc([solid("a")]);
    const t = transitionOf(
      applied(
        d,
        addTransition(d, {
          layer: sel("a"),
          kind: "wipe",
          edge: "out",
          params: { angle: { value: 3500 } },
        }).ops,
      ),
      "a",
    );
    expect(t.angle).toEqual({ value: 3680 - 360 * 1 });
  });

  it("refuses a second edge that would overlap the first", () => {
    const d = doc([solid("a", { inFrame: 0, outFrame: 30 })]);
    const one = applied(
      d,
      addTransition(d, { layer: sel("a"), kind: "dissolve", duration: 600 }).ops,
    );
    const e = refusal(() =>
      addTransition(one, { layer: sel("a"), kind: "dissolve", edge: "out", duration: 600 }),
    );
    expect(e.path).toEqual(["duration"]);
    expect(e.message).toContain(
      "the out edge (frames 11–29) would overlap the in edge (frames 0–18)",
    );
    expect(e.message).toContain("at most 10 frames");
    const fits = addTransition(one, {
      layer: sel("a"),
      kind: "dissolve",
      edge: "out",
      duration: 300,
    });
    expect(fits.resolved.from_frame).toBeGreaterThan(18);
    const tight = doc([solid("t", { inFrame: 0, outFrame: 4 })]);
    const first = applied(
      tight,
      addTransition(tight, { layer: sel("t"), kind: "dissolve", duration: "slow" }).ops,
    );
    expect(
      refusal(() => addTransition(first, { layer: sel("t"), kind: "dissolve", edge: "out" }))
        .message,
    ).toContain("too short for both edges");
  });

  it("shrinks the duration to fit a short layer", () => {
    const d = doc([solid("a", { inFrame: 0, outFrame: 4 })]);
    const { resolved } = addTransition(d, { layer: sel("a"), kind: "dissolve", duration: "slow" });
    expect(resolved.duration_frames).toBe(3);
    expect(resolved.from_frame).toBe(0);
    expect(resolved.to_frame).toBe(3);
  });

  it("reports invalid params at their path", () => {
    const d = doc([solid("a")]);
    expect(
      refusal(() => addTransition(d, { layer: sel("a"), kind: "blinds", params: { count: 1 } }))
        .path,
    ).toEqual(["params", "count"]);
    expect(
      refusal(() =>
        addTransition(d, { layer: sel("a"), kind: "wipe", params: { progress: { value: 1 } } }),
      ).path,
    ).toEqual(["params", "progress"]);
  });
});
