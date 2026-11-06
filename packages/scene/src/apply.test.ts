import { describe, expect, it } from "vitest";
import { applyOps, OpSchema } from "./index.js";
import { baseDoc, layerIds, omitId, solid } from "./ops.test-util.js";
import { globMatch } from "./selectors.js";

const add = (extra: object = {}) => ({
  op: "addLayer",
  composition: "main",
  layer: omitId(solid("x")),
  ...extra,
});

describe("applyOps: happy path", () => {
  it("adds a layer with a generated id and a concrete change record", () => {
    const doc = baseDoc();
    const r = applyOps(doc, [add()]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(layerIds(r.doc)).toEqual(["layer-1", "a", "b", "c"]);
    expect(r.idCounter).toBe(1);
    expect(r.changes).toMatchObject([
      { type: "layer.insert", layerId: "layer-1", composition: "main", index: 0, op: 0 },
    ]);
    expect(layerIds(doc)).toEqual(["a", "b", "c"]); // input untouched
  });

  it("skips ids already in use and is deterministic", () => {
    const first = applyOps(baseDoc(), [add({ id: "layer-1" }), add()]);
    const again = applyOps(baseDoc(), [add({ id: "layer-1" }), add()]);
    if (!first.ok) throw new Error("expected ok");
    expect(layerIds(first.doc)).toEqual(["layer-2", "layer-1", "a", "b", "c"]);
    expect(again).toEqual(first);
  });

  it("resolves id, name and structured selectors to concrete ids", () => {
    const r = applyOps(baseDoc(), [
      { op: "updateLayer", layer: "a", set: { hidden: true } },
      { op: "updateLayer", layer: { name: "b" }, set: { name: "bee" } },
      {
        op: "updateLayer",
        layer: { type: "null", name: "c*", composition: "main" },
        set: { solo: true },
      },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(
      r.changes.map((c) =>
        c.type === "layer.set" ? [c.layerId, c.path.join("."), c.after] : null,
      ),
    ).toEqual([
      ["a", "hidden", true],
      ["b", "name", "bee"],
      ["c", "solo", true],
    ]);
  });

  it("sets constant and keyframed transform tracks, reorders, reparents and edits markers", () => {
    const r = applyOps(baseDoc(), [
      { op: "setTransformTrack", layer: "a", property: "opacity", track: { value: 0.5 } },
      {
        op: "setTransformTrack",
        layer: "a",
        property: "position",
        track: {
          keyframes: [
            { frame: 0, value: [0, 0], interpolation: { type: "linear" } },
            { frame: 30, value: [100, 0], interpolation: { type: "hold" } },
          ],
        },
      },
      { op: "reorderLayer", layer: "c", index: 0 },
      { op: "setParent", layer: "b", parent: null },
      { op: "setParent", layer: "c", parent: "a" },
      {
        op: "addMarker",
        target: { layer: "a" },
        marker: { frame: 5, durationFrames: 0, name: "hit" },
      },
      {
        op: "addMarker",
        target: { composition: "main" },
        id: "m1",
        marker: { frame: 0, durationFrames: 10, name: "intro" },
      },
      { op: "removeMarker", marker: "m1" },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const layers = r.doc.compositions[0]?.layers ?? [];
    expect(layerIds(r.doc)).toEqual(["c", "a", "b"]);
    expect(layers.find((l) => l.id === "c")).toMatchObject({ parent: "a" });
    expect(layers.find((l) => l.id === "b")).toMatchObject({ parent: null });
    expect(layers.find((l) => l.id === "a")?.markers).toMatchObject([{ id: "marker-1", frame: 5 }]);
    expect(r.doc.compositions[0]?.markers).toEqual([]);
  });

  it("removes a layer and treats a no-change batch as success with no changes", () => {
    const r = applyOps(baseDoc(), [{ op: "removeLayer", layer: "c" }]);
    if (!r.ok) throw new Error("expected ok");
    expect(layerIds(r.doc)).toEqual(["a", "b"]);
    const same = applyOps(baseDoc(), [{ op: "updateLayer", layer: "a", set: { hidden: false } }]);
    expect(same).toMatchObject({ ok: true, changes: [] });
  });
});

describe("applyOps: rejection returns the original doc with pathed errors", () => {
  const rejects = (ops: unknown) => {
    const doc = baseDoc();
    const r = applyOps(doc, ops);
    if (r.ok) throw new Error("expected rejection");
    expect(r.doc).toBe(doc);
    return r.errors;
  };

  it("unknown id", () => {
    expect(rejects([{ op: "removeLayer", layer: "nope" }])).toMatchObject([
      { path: ["ops", 0, "layer"], message: expect.stringContaining("no layer matches") },
    ]);
    expect(rejects([add({ composition: "ghost" })])).toMatchObject([
      { path: ["ops", 0, "composition"] },
    ]);
    expect(rejects([{ op: "removeMarker", marker: "nope" }])).toMatchObject([
      { path: ["ops", 0, "marker"] },
    ]);
  });

  it("bad or ambiguous selector", () => {
    expect(rejects([{ op: "removeLayer", layer: {} }])[0]?.path.slice(0, 3)).toEqual([
      "ops",
      0,
      "layer",
    ]);
    expect(rejects([{ op: "removeLayer", layer: "Not An Id" }])[0]?.path.slice(0, 3)).toEqual([
      "ops",
      0,
      "layer",
    ]);
    expect(rejects([{ op: "removeLayer", layer: { type: "null" } }])).toMatchObject([
      { path: ["ops", 0, "layer"], message: expect.stringContaining("3 layers match") },
    ]);
  });

  it("malformed ops and values", () => {
    expect(rejects([{ op: "frobnicate" }])[0]?.path[0]).toBe("ops");
    expect(rejects([{ op: "updateLayer", layer: "a", set: {} }])[0]?.path.slice(0, 2)).toEqual([
      "ops",
      0,
    ]);
    expect(
      rejects([
        { op: "setTransformTrack", layer: "a", property: "opacity", track: { value: 7 } },
      ])[0]?.path.slice(0, 3),
    ).toEqual(["ops", 0, "track"]);
    expect(rejects("not an array")[0]?.path).toEqual(["ops"]);
  });

  it("integrity failures are reported with doc paths", () => {
    // 'b' still has 'a' as its parent.
    expect(rejects([{ op: "removeLayer", layer: "a" }])).toMatchObject([
      { path: ["doc", "compositions", 0, "layers", 0, "parent"] },
    ]);
    // parenting cycle
    expect(rejects([{ op: "setParent", layer: "a", parent: "b" }])[0]?.message).toContain(
      "parenting cycle",
    );
    // out before in
    expect(rejects([{ op: "updateLayer", layer: "a", set: { outFrame: -5 } }])[0]?.path[0]).toBe(
      "doc",
    );
  });
});

describe("applyOps: atomic batches", () => {
  it("a failing op leaves nothing applied and the id counter unchanged", () => {
    const doc = baseDoc();
    const r = applyOps(doc, [add(), { op: "removeLayer", layer: "nope" }], 7);
    expect(r).toMatchObject({ ok: false, doc });
    expect(layerIds(doc)).toEqual(["a", "b", "c"]);
    // the caller keeps its counter on failure, so the next id is still layer-8
    const next = applyOps(doc, [add()], 7);
    expect(next.ok && layerIds(next.doc)[0]).toBe("layer-8");
  });

  it("an integrity failure on the final state rolls back earlier ops, but a fixed-up batch passes", () => {
    expect(applyOps(baseDoc(), [{ op: "removeLayer", layer: "a" }]).ok).toBe(false);
    const ok = applyOps(baseDoc(), [
      { op: "setParent", layer: "b", parent: null },
      { op: "removeLayer", layer: "a" },
    ]);
    expect(ok.ok).toBe(true);
  });
});

describe("selectors and ids: hostile and edge input", () => {
  it("glob matching is linear: a pathological pattern finishes immediately", () => {
    const start = Date.now();
    expect(globMatch("*a*a*a*a*a*a*a*b", "a".repeat(200))).toBe(false);
    expect(Date.now() - start).toBeLessThan(200);
    expect(globMatch("t*e*", "title")).toBe(true);
    expect(globMatch("*", "")).toBe(true);
    expect(globMatch("a", "ab")).toBe(false);
  });

  it("a generated marker id never collides with markers inside a layer added in the same batch", () => {
    const layer = {
      ...omitId(solid("x")),
      markers: [{ id: "marker-1", frame: 0, durationFrames: 0, name: "m" }],
    };
    const r = applyOps(baseDoc(), [
      add({ layer }),
      {
        op: "addMarker",
        target: { layer: "a" },
        marker: { frame: 1, durationFrames: 0, name: "n" },
      },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.changes.at(-1)).toMatchObject({ type: "marker.insert", markerId: "marker-2" });
  });

  it("rejects a reused marker id with an ops path; layer and marker ids are separate namespaces", () => {
    const m = { frame: 0, durationFrames: 0, name: "m" };
    const dup = applyOps(baseDoc(), [
      { op: "addMarker", target: { layer: "a" }, id: "m1", marker: m },
      { op: "addMarker", target: { layer: "b" }, id: "m1", marker: m },
    ]);
    expect(dup).toMatchObject({ ok: false, errors: [{ path: ["ops", 1, "id"] }] });
    expect(
      applyOps(baseDoc(), [{ op: "addMarker", target: { layer: "a" }, id: "c", marker: m }]).ok,
    ).toBe(true);
  });

  it("selectors resolve against the working document, so later ops see earlier ones in the batch", () => {
    const r = applyOps(baseDoc(), [
      { op: "updateLayer", layer: "a", set: { name: "title-1" } },
      { op: "updateLayer", layer: { name: "title-*" }, set: { hidden: true } },
    ]);
    expect(r.ok && r.changes.map((c) => c.type === "layer.set" && c.layerId)).toEqual(["a", "a"]);
  });

  it("track schemas are per property and exported for MCP schemas", () => {
    const bad = OpSchema.safeParse({
      op: "setTransformTrack",
      layer: "a",
      property: "opacity",
      track: { value: 7 },
    });
    expect(bad.success).toBe(false);
    expect(
      OpSchema.safeParse({
        op: "setTransformTrack",
        layer: "a",
        property: "scale",
        track: { value: [1, 1] },
      }).success,
    ).toBe(true);
  });
});
