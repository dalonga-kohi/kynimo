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
  applyBatch,
  applyOps,
  createSceneState,
  LayerPatchSchema,
  type Project,
  ProjectSchema,
  TRANSITION_KINDS,
  TransitionSchema,
  undo,
} from "./index.js";
import { solid } from "./ops.test-util.js";

const doc = (layers: Obj[]): Project =>
  ProjectSchema.parse(project({ compositions: [composition("main", layers)] }));

const point = prop([100, 50]);

/** One valid transition per kind. */
const valid: Record<string, Obj> = {
  dissolve: { kind: "dissolve", progress: prop(0.5) },
  "noise-dissolve": {
    kind: "noise-dissolve",
    progress: prop(0.5),
    seed: 7,
    scale: prop(16),
    feather: prop(0.2),
  },
  wipe: { kind: "wipe", progress: prop(0.5), angle: prop(-45), feather: prop(80) },
  clock: {
    kind: "clock",
    progress: prop(0.5),
    startAngle: prop(0),
    clockwise: true,
    center: point,
    feather: prop(10),
  },
  iris: {
    kind: "iris",
    progress: prop(0.5),
    shape: "diamond",
    center: point,
    feather: prop(40),
  },
  blinds: {
    kind: "blinds",
    progress: prop(0.5),
    count: 8,
    angle: prop(90),
    feather: prop(0.25),
  },
  pixelate: { kind: "pixelate", progress: prop(0.5), cell: prop(64) },
  push: { kind: "push", progress: prop(0.5), angle: prop(180) },
  zoom: { kind: "zoom", progress: prop(0.5), center: point, strength: prop(2) },
  glitch: { kind: "glitch", progress: prop(0.5), seed: 99, bands: 24, amount: prop(0.7) },
};

const parses = (v: unknown) => TransitionSchema.safeParse(v).success;

describe("TransitionSchema", () => {
  it("has a valid sample for each of the 10 kinds", () => {
    expect(Object.keys(valid)).toEqual([...TRANSITION_KINDS]);
    for (const kind of TRANSITION_KINDS) expect(parses(valid[kind]), kind).toBe(true);
  });

  it("accepts the limits and rejects values beyond them, one per limit family", () => {
    const wipe = valid.wipe as Obj;
    expect(parses({ ...wipe, feather: prop(4096) })).toBe(true);
    expect(parses({ ...wipe, feather: prop(4097) })).toBe(false);
    expect(parses({ ...wipe, feather: prop(-1) })).toBe(false);
    expect(parses({ ...wipe, angle: prop(3601) })).toBe(false);

    const zoom = valid.zoom as Obj;
    expect(parses({ ...zoom, center: prop([65536, -65536]) })).toBe(true);
    expect(parses({ ...zoom, center: prop([65537, 0]) })).toBe(false);

    const pixelate = valid.pixelate as Obj;
    expect(parses({ ...pixelate, cell: prop(2) })).toBe(true);
    expect(parses({ ...pixelate, cell: prop(1) })).toBe(false);
    expect(parses({ ...pixelate, cell: prop(513) })).toBe(false);

    const blinds = valid.blinds as Obj;
    expect(parses({ ...blinds, count: 2 })).toBe(true);
    expect(parses({ ...blinds, count: 128 })).toBe(true);
    expect(parses({ ...blinds, count: 1 })).toBe(false);
    expect(parses({ ...blinds, count: 129 })).toBe(false);
    expect(parses({ ...blinds, count: 3.5 })).toBe(false);

    const glitch = valid.glitch as Obj;
    expect(parses({ ...glitch, bands: 256 })).toBe(true);
    expect(parses({ ...glitch, bands: 257 })).toBe(false);
    expect(parses({ ...glitch, bands: 1 })).toBe(false);

    expect(parses({ ...glitch, seed: 0xffffffff })).toBe(true);
    expect(parses({ ...glitch, seed: 0x100000000 })).toBe(false);
    expect(parses({ ...glitch, seed: -1 })).toBe(false);

    expect(parses({ ...(valid.dissolve as Obj), progress: prop(1.5) })).toBe(false);
  });

  it("rejects an unknown kind, extra keys and missing fields", () => {
    expect(parses({ kind: "spin", progress: prop(0) })).toBe(false);
    expect(parses({ ...(valid.dissolve as Obj), feather: prop(1) })).toBe(false);
    expect(parses({ kind: "dissolve" })).toBe(false);
    expect(parses({ ...(valid.wipe as Obj), feather: undefined })).toBe(false);
  });

  it("validates progress keyframes", () => {
    const keyframes = [
      { frame: 0, value: 0, interpolation: { type: "linear" } },
      { frame: 30, value: 1, interpolation: { type: "linear" } },
    ];
    expect(parses({ kind: "dissolve", progress: { keyframes } })).toBe(true);
    const bad = [{ ...keyframes[0], value: 2 }, keyframes[1]];
    expect(parses({ kind: "dissolve", progress: { keyframes: bad } })).toBe(false);
  });
});

describe("layer transition", () => {
  it("defaults to null on drawn layers written without it", () => {
    expect(doc([solid("s")]).compositions[0]?.layers[0]).toMatchObject({ transition: null });
  });

  it("is not a field of null layers", () => {
    expect(doc([nullLayer("n")]).compositions[0]?.layers[0]).not.toHaveProperty("transition");
  });

  it("updateLayer sets, replaces and clears it, one change per op", () => {
    const d = doc([solid("s")]);
    const on = applyOps(d, [
      { op: "updateLayer", layer: "s", set: { transition: valid.dissolve } },
    ] as never);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.changes).toHaveLength(1);
    expect(on.doc.compositions[0]?.layers[0]).toMatchObject({ transition: valid.dissolve });
    const swapped = applyOps(on.doc, [
      { op: "updateLayer", layer: "s", set: { transition: valid.wipe } },
    ] as never);
    expect(swapped.ok && swapped.doc.compositions[0]?.layers[0]).toMatchObject({
      transition: valid.wipe,
    });
    const off = applyOps(on.doc, [{ op: "updateLayer", layer: "s", set: { transition: null } }]);
    expect(off.ok && off.doc.compositions[0]?.layers[0]).toMatchObject({ transition: null });
  });

  it("undo restores the previous transition", () => {
    const state = createSceneState(doc([solid("s")]));
    const r = applyBatch(state, "alice", [
      { op: "updateLayer", layer: "s", set: { transition: valid.push } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changes).toHaveLength(1);
    const u = undo(r.state, "alice");
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.state.doc.compositions[0]?.layers[0]).toMatchObject({ transition: null });
  });

  it("is accepted by the patch schema and rejects invalid transitions", () => {
    expect(LayerPatchSchema.safeParse({ transition: valid.glitch }).success).toBe(true);
    expect(LayerPatchSchema.safeParse({ transition: null }).success).toBe(true);
    expect(LayerPatchSchema.safeParse({ transition: { kind: "dissolve" } }).success).toBe(false);
  });

  it("rejects a transition on an adjustment layer with a pathed issue", () => {
    const found = issues(
      project({
        compositions: [
          composition("main", [{ ...visual("a"), type: "adjustment", transition: valid.dissolve }]),
        ],
      }),
    );
    expect(found).toContainEqual({
      path: "compositions.0.layers.0.transition",
      message: "adjustment layers have no transition; set transition to null",
    });
  });

  describe("updateLayer on layers without transitions", () => {
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
    const set = (layer: string, transition: unknown) =>
      applyOps(withTypes(), [{ op: "updateLayer", layer, set: { transition } } as never]);
    const fails = (layer: string, transition: unknown, message: string) => {
      const r = set(layer, transition);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors).toContainEqual({ path: ["ops", 0, "set", "transition"], message });
    };

    it("fails on a null layer", () =>
      fails(
        "n",
        valid.dissolve,
        "layer 'n' is a null layer and has no transition; transitions go on drawn layers",
      ));
    it("fails on an audio layer", () =>
      fails(
        "snd",
        valid.dissolve,
        "layer 'snd' is an audio layer and has no transition; transitions go on drawn layers",
      ));
    it("fails on an adjustment layer unless null", () => {
      fails("a", valid.dissolve, "adjustment layers have no transition; set transition to null");
      expect(set("a", null).ok).toBe(true);
    });
  });
});
