import { describe, expect, it } from "vitest";
import {
  common,
  composition,
  nullLayer,
  type Obj,
  project,
  prop,
  visual,
} from "./fixtures.test-util.js";
import { applyOps, DeformSchema, LayerSchema, ProjectSchema, withLayerDefaults } from "./index.js";
import { omitId, solid } from "./ops.test-util.js";

const pin = (id: string) => ({ id, rest: [2, 3], position: prop([6, 9]) });

const unsupported: Obj[] = [
  nullLayer("nul"),
  { ...visual("adj"), type: "adjustment" },
  withLayerDefaults({ ...common("cam"), type: "camera" }, undefined) as Obj,
  { ...common("aud"), type: "audio", assetId: "track", volume: prop(1) },
];

const doc = (layers: Obj[]) =>
  ProjectSchema.parse(
    project({
      assets: [
        {
          id: "track",
          type: "audio",
          name: "Track",
          uri: "assets/track.bin",
          sha256: "a".repeat(64),
          durationMs: 1000,
        },
      ],
      compositions: [composition("main", layers)],
    }),
  );

describe("DeformSchema", () => {
  it("defaults to density 24 and ten iterations, and accepts both bounds", () => {
    expect(DeformSchema.parse({ pins: [] })).toEqual({ pins: [], density: 24, iterations: 10 });
    const pins = Array.from({ length: 32 }, (_, i) => pin(`pin-${i}`));
    expect(DeformSchema.safeParse({ pins, density: 4, iterations: 1 }).success).toBe(true);
    expect(DeformSchema.safeParse({ pins, density: 64, iterations: 30 }).success).toBe(true);
  });

  it.each([
    { density: 3 },
    { density: 65 },
    { density: 4.5 },
    { iterations: 0 },
    { iterations: 31 },
    { iterations: 10.5 },
    { pins: Array.from({ length: 33 }, (_, i) => pin(`pin-${i}`)) },
    { pins: [{ ...pin("p"), rest: [0, Number.POSITIVE_INFINITY] }] },
    { pins: [{ ...pin("p"), position: prop([Number.NaN, 0]) }] },
    { pins: [{ ...pin("p"), position: prop([0, 1, 2]) }] },
    { pins: [pin("not an id")] },
  ])("rejects invalid inputs %o", (patch) => {
    expect(DeformSchema.safeParse({ pins: [pin("p")], ...patch }).success).toBe(false);
  });

  it("points to the duplicate pin's id", () => {
    const parsed = DeformSchema.safeParse({ pins: [pin("same"), pin("same")] });
    if (parsed.success) throw new Error("duplicate pin was accepted");
    expect(parsed.error.issues[0]).toMatchObject({ path: ["pins", 1, "id"] });
  });
});

describe("layer deform", () => {
  it("defaults to null in existing documents and older addLayer operations", () => {
    const original = doc([solid("old")]);
    expect(original.compositions[0]?.layers[0]).toHaveProperty("deform", null);
    const added = applyOps(original, [
      { op: "addLayer", composition: "main", id: "added", layer: omitId(solid("added")) },
    ]);
    if (!added.ok) throw new Error(JSON.stringify(added.errors));
    expect(added.doc.compositions[0]?.layers[0]).toHaveProperty("deform", null);
  });

  it("updates and clears deformation through typed layer changes", () => {
    const original = doc([solid("s")]);
    const pins = [pin("wrist")];
    const changed = applyOps(original, [
      { op: "updateLayer", layer: "s", set: { deform: { pins } } },
    ]);
    if (!changed.ok) throw new Error(JSON.stringify(changed.errors));
    expect(changed.changes).toMatchObject([
      {
        type: "layer.set",
        path: ["deform"],
        before: null,
        after: { pins, density: 24, iterations: 10 },
      },
    ]);
    const cleared = applyOps(changed.doc, [
      { op: "updateLayer", layer: "s", set: { deform: null } },
    ]);
    expect(cleared.ok && cleared.doc).toEqual(original);
  });

  it.each(unsupported)(
    "rejects the field and returns atomic op errors for $type layers",
    (layer) => {
      const original = doc([solid("s"), layer]);
      expect(LayerSchema.safeParse({ ...layer, deform: null }).success).toBe(false);
      for (const deform of [null, { pins: [pin("p")] }]) {
        const changed = applyOps(original, [
          { op: "updateLayer", layer: "s", set: { deform: { pins: [pin("p")] } } },
          { op: "updateLayer", layer: layer.id, set: { deform } },
        ]);
        if (changed.ok) throw new Error("deform patch was accepted");
        expect(changed.doc).toBe(original);
        expect(changed.doc.compositions[0]?.layers[0]).toHaveProperty("deform", null);
        expect(changed.errors).toMatchObject([
          { path: ["ops", 1, "set", "deform"], message: expect.stringContaining(`'${layer.id}'`) },
        ]);
      }
    },
  );
});
