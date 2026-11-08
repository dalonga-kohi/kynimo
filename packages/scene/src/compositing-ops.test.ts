import { describe, expect, it } from "vitest";
import { composition, nullLayer, type Obj, project, prop } from "./fixtures.test-util.js";
import {
  type ApplyResult,
  applyBatch,
  applyOps,
  createSceneState,
  type Project,
  ProjectSchema,
  redo,
  undo,
} from "./index.js";
import { omitId, solid } from "./ops.test-util.js";

const square = {
  closed: true,
  vertices: [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ].map((point) => ({ point, inTangent: [0, 0], outTangent: [0, 0] })),
};

const maskBody = (overrides: Obj = {}): Obj => ({
  name: "m",
  mode: "add",
  inverted: false,
  path: prop(square),
  feather: prop([0, 0]),
  opacity: prop(1),
  expansion: prop(0),
  ...overrides,
});

/** main: s1, s2, s3 (solids), n (null); other: o (solid). */
const doc = (layers: Obj[] = [solid("s1"), solid("s2"), solid("s3"), nullLayer("n")]): Project =>
  ProjectSchema.parse(
    project({
      compositions: [composition("main", layers), composition("other", [solid("o")])],
    }),
  );

const ok = (r: ApplyResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const errors = (r: ApplyResult) => (r.ok ? [] : r.errors);
const layerOf = (d: Project, id: string) =>
  d.compositions.flatMap((c) => c.layers).find((l) => l.id === id) as Obj | undefined;
const masksOf = (d: Project, id: string) =>
  ((layerOf(d, id)?.masks ?? []) as Obj[]).map((m) => m.id);
const ids = (d: Project, comp: string) =>
  d.compositions.find((c) => c.id === comp)?.layers.map((l) => l.id);

describe("mask ops", () => {
  it("adds masks with generated ids, appended by default or at an index", () => {
    const r = ok(
      applyOps(doc(), [
        { op: "addMask", layer: "s1", mask: maskBody() },
        { op: "addMask", layer: "s1", mask: maskBody(), id: "first", index: 0 },
        { op: "addMask", layer: "s2", mask: maskBody() },
      ]),
    );
    expect(masksOf(r.doc, "s1")).toEqual(["first", "mask-1"]);
    expect(masksOf(r.doc, "s2")).toEqual(["mask-2"]);
    expect(r.idCounter).toBe(2);
    expect(r.changes[0]).toMatchObject({ type: "layer.set", layerId: "s1", path: ["masks"] });
  });

  it("updates and removes a mask by id", () => {
    const r = ok(
      applyOps(doc(), [
        { op: "addMask", layer: "s1", mask: maskBody(), id: "a" },
        { op: "addMask", layer: "s1", mask: maskBody(), id: "b" },
        {
          op: "updateMask",
          layer: "s1",
          mask: "a",
          set: { mode: "subtract", opacity: { value: 0.5 } },
        },
        { op: "removeMask", layer: "s1", mask: "b" },
      ]),
    );
    expect(layerOf(r.doc, "s1")?.masks).toMatchObject([{ id: "a", mode: "subtract", name: "m" }]);
  });

  it("an update that changes nothing records no change", () => {
    const start = ok(applyOps(doc(), [{ op: "addMask", layer: "s1", mask: maskBody(), id: "a" }]));
    const r = ok(
      applyOps(start.doc, [{ op: "updateMask", layer: "s1", mask: "a", set: { mode: "add" } }]),
    );
    expect(r.changes).toEqual([]);
  });

  it("rejects bad targets with pathed, actionable errors", () => {
    const d = ok(applyOps(doc(), [{ op: "addMask", layer: "s1", mask: maskBody(), id: "a" }])).doc;
    expect(errors(applyOps(d, [{ op: "addMask", layer: "n", mask: maskBody() }]))).toMatchObject([
      { path: ["ops", 0, "layer"], message: expect.stringContaining("null layer") },
    ]);
    expect(
      errors(applyOps(d, [{ op: "addMask", layer: "s1", mask: maskBody(), id: "a" }])),
    ).toMatchObject([{ path: ["ops", 0, "id"], message: expect.stringContaining("already") }]);
    expect(
      errors(applyOps(d, [{ op: "addMask", layer: "s1", mask: maskBody(), index: 5 }])),
    ).toMatchObject([{ path: ["ops", 0, "index"] }]);
    expect(errors(applyOps(d, [{ op: "removeMask", layer: "s1", mask: "zz" }]))).toMatchObject([
      { path: ["ops", 0, "mask"], message: expect.stringContaining("its masks: a") },
    ]);
    expect(
      errors(applyOps(d, [{ op: "updateMask", layer: "s1", mask: "a", set: {} }])),
    ).toMatchObject([{ path: ["ops", 0, "set"] }]);
    expect(
      errors(applyOps(d, [{ op: "updateMask", layer: "s1", mask: "a", set: { id: "b" } }])),
    ).not.toEqual([]);
  });

  it("undoes and redoes mask edits", () => {
    const s0 = createSceneState(doc());
    const a = applyBatch(s0, "me", [{ op: "addMask", layer: "s1", mask: maskBody() }]);
    if (!a.ok) throw new Error("expected ok");
    const u = undo(a.state, "me");
    if (!u.ok) throw new Error("expected ok");
    expect(u.state.doc).toEqual(s0.doc);
    const r = redo(u.state, "me");
    expect(r.ok && masksOf(r.state.doc, "s1")).toEqual(["mask-1"]);
  });
});

describe("setMatte", () => {
  it("sets a matte from a selector and clears it", () => {
    const set = ok(
      applyOps(doc(), [
        { op: "setMatte", layer: "s1", matte: { layer: { name: "s2" }, mode: "luma" } },
      ]),
    );
    expect(layerOf(set.doc, "s1")?.matte).toEqual({ layerId: "s2", mode: "luma" });
    const cleared = ok(applyOps(set.doc, [{ op: "setMatte", layer: "s1", matte: null }]));
    expect(layerOf(cleared.doc, "s1")?.matte).toBeNull();
  });

  it("rejects a source in another composition, a non-drawing source and a cycle", () => {
    const m = (layer: string, source: string) => ({
      op: "setMatte",
      layer,
      matte: { layer: source, mode: "alpha" },
    });
    expect(errors(applyOps(doc(), [m("s1", "o")]))).toMatchObject([
      { path: ["ops", 0, "matte", "layer"], message: expect.stringContaining("same composition") },
    ]);
    expect(errors(applyOps(doc(), [m("n", "s1")]))).toMatchObject([{ path: ["ops", 0, "layer"] }]);
    // Integrity rules from the schema still apply to the result.
    expect(errors(applyOps(doc(), [m("s1", "n")]))).toMatchObject([
      { path: ["doc", "compositions", 0, "layers", 0, "matte", "layerId"] },
    ]);
    expect(errors(applyOps(doc(), [m("s1", "s2"), m("s2", "s1")]))[0]?.message).toContain(
      "track matte cycle",
    );
  });
});

describe("precompose", () => {
  it("moves the layers into a new composition and puts a precomp layer at the topmost", () => {
    const start = doc([
      solid("s1"),
      { ...solid("s2"), matte: { layerId: "s3", mode: "alpha" } },
      nullLayer("n"),
      { ...solid("s3"), parent: "n" },
    ]);
    const r = ok(applyOps(start, [{ op: "precompose", layers: ["s3", "s2", "n"], name: "Group" }]));
    expect(ids(r.doc, "main")).toEqual(["s1", "layer-2"]);
    expect(ids(r.doc, "comp-1")).toEqual(["s2", "n", "s3"]);
    const comp = r.doc.compositions.find((c) => c.id === "comp-1");
    expect(comp).toMatchObject({
      name: "Group",
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
      durationFrames: 90,
      background: null,
      markers: [],
    });
    expect(layerOf(r.doc, "layer-2")).toMatchObject({
      type: "precomp",
      name: "Group",
      compositionId: "comp-1",
      inFrame: 0,
      outFrame: 90,
      startFrame: 0,
      solo: false,
      transform: { anchorPoint: { value: [960, 540] }, position: { value: [960, 540] } },
    });
    // Moved layers keep everything, links included.
    expect(layerOf(r.doc, "s2")?.matte).toEqual({ layerId: "s3", mode: "alpha" });
    expect(layerOf(r.doc, "s3")?.parent).toBe("n");
    expect(r.changes.map((c) => c.type)).toEqual([
      "composition.insert",
      ...Array(3).fill(["layer.remove", "layer.insert"]).flat(),
      "layer.insert",
    ]);
  });

  it("uses given ids, a default name, and keeps a soloed selection soloed", () => {
    const r = ok(
      applyOps(doc([solid("s1"), { ...solid("s2"), solo: true }]), [
        { op: "precompose", layers: ["s2"], id: "group", layerId: "group-layer" },
      ]),
    );
    expect(ids(r.doc, "main")).toEqual(["s1", "group-layer"]);
    expect(layerOf(r.doc, "group-layer")).toMatchObject({ name: "s2 Comp", solo: true });
    expect(r.idCounter).toBe(0);
  });

  it("lets later ops in the batch target the new composition and layer", () => {
    const r = ok(
      applyOps(doc(), [
        { op: "precompose", layers: ["s2"], id: "g" },
        { op: "addMask", layer: { type: "precomp" }, mask: maskBody() },
        { op: "addLayer", composition: "g", layer: omitId(solid("x")) },
      ]),
    );
    expect(ids(r.doc, "g")).toEqual(["layer-3", "s2"]);
  });

  it("refuses to break parents or mattes that cross the boundary", () => {
    const start = doc([
      { ...solid("s1"), parent: "n" },
      { ...solid("s2"), matte: { layerId: "s3", mode: "alpha" } },
      solid("s3"),
      nullLayer("n"),
    ]);
    const p = (...layers: string[]) => [{ op: "precompose", layers }];
    expect(errors(applyOps(start, p("s1")))).toMatchObject([
      {
        path: ["ops", 0, "layers", 0],
        message: expect.stringContaining("has parent 'n', which is not being precomposed"),
      },
    ]);
    expect(errors(applyOps(start, p("s3", "n")))).toMatchObject([
      {
        path: ["ops", 0, "layers", 1],
        message: expect.stringContaining("'s1' (not being precomposed) has parent 'n'"),
      },
    ]);
    expect(errors(applyOps(start, p("s3")))[0]?.message).toContain("track matte 's3'");
    expect(errors(applyOps(start, p("s2")))[0]?.message).toContain("track matte 's3'");
    expect(applyOps(start, p("s1", "n", "s2", "s3")).ok).toBe(true);
  });

  it("rejects layers of several compositions, repeats and taken ids", () => {
    const p = (op: Obj) => applyOps(doc(), [{ op: "precompose", ...op }]);
    expect(errors(p({ layers: ["s1", "o"] }))).toMatchObject([{ path: ["ops", 0, "layers", 1] }]);
    expect(errors(p({ layers: ["s1", { name: "s1" }] }))[0]?.message).toContain("listed twice");
    expect(errors(p({ layers: ["s1"], id: "other" }))).toMatchObject([{ path: ["ops", 0, "id"] }]);
    expect(errors(p({ layers: ["s1"], layerId: "s2" }))).toMatchObject([
      { path: ["ops", 0, "layerId"] },
    ]);
    expect(errors(p({ layers: [] }))).toMatchObject([{ path: ["ops", 0, "layers"] }]);
  });

  it("undoes to the exact original document and redoes", () => {
    const s0 = createSceneState(doc());
    const a = applyBatch(s0, "me", [{ op: "precompose", layers: ["s1", "s3"] }]);
    if (!a.ok) throw new Error(JSON.stringify(a.errors));
    const u = undo(a.state, "me");
    if (!u.ok) throw new Error(JSON.stringify(u.errors));
    expect(u.state.doc).toEqual(s0.doc);
    const r = redo(u.state, "me");
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.state.doc).toEqual(a.state.doc);
  });

  it("undo conflicts when the new composition was edited since", () => {
    const s0 = createSceneState(doc());
    const a = applyBatch(s0, "me", [{ op: "precompose", layers: ["s1"], id: "g" }]);
    if (!a.ok) throw new Error("expected ok");
    const b = applyBatch(a.state, "you", [
      {
        op: "addMarker",
        target: { composition: "g" },
        marker: { frame: 0, durationFrames: 0, name: "x" },
      },
    ]);
    if (!b.ok) throw new Error(JSON.stringify(b.errors));
    const u = undo(b.state, "me");
    expect(u.ok).toBe(false);
    expect(u.state.doc).toEqual(b.state.doc);
  });
});
