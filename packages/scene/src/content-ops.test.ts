import { describe, expect, it } from "vitest";
import { composition, type Obj, project, prop, visual } from "./fixtures.test-util.js";
import {
  type ApplyResult,
  applyBatch,
  applyOps,
  createSceneState,
  MAX_SHAPE_ITEMS,
  MAX_TEXT_ANIMATORS,
  type Project,
  ProjectSchema,
  redo,
  SCENE_FORMAT_VERSION,
  undo,
} from "./index.js";
import { solid } from "./ops.test-util.js";

const text = (id: string, animators: Obj[] = []): Obj => ({
  ...visual(id),
  type: "text",
  content: prop("Hi"),
  box: { mode: "point" },
  font: { family: "Inter", weight: 400, size: prop(48) },
  tracking: prop(0),
  leading: prop(1.2),
  align: "left",
  textCase: "none",
  animators,
  fill: prop("#ffffff"),
});

const animator = (name = "Fade"): Obj => ({
  name,
  selector: {
    unit: "characters",
    start: prop(0),
    end: {
      keyframes: [
        { frame: 0, value: 0, interpolation: { type: "linear" } },
        { frame: 30, value: 1, interpolation: { type: "hold" } },
      ],
    },
    offset: prop(0),
    shape: "square",
    easeHigh: prop(0),
    easeLow: prop(0),
    order: "forward",
    seed: 0,
    amount: prop(1),
  },
  properties: { opacity: prop(0) },
});

const rect = (id: string): Obj => ({
  type: "rect",
  id,
  name: id,
  position: prop([0, 0]),
  size: prop([200, 100]),
  cornerRadius: prop(0),
});

const fill = (id: string): Obj => ({
  type: "fill",
  id,
  name: id,
  paint: { type: "solid", color: prop("#ff3366") },
  opacity: prop(1),
  rule: "nonzero",
});

const shape = (id: string, contents: Obj[] = []): Obj => ({
  ...visual(id),
  type: "shape",
  contents,
});

const doc = (): Project =>
  ProjectSchema.parse(
    project({
      compositions: [
        composition("main", [text("t"), shape("s", [rect("r1"), fill("f1")]), solid("sol")]),
      ],
    }),
  );

const ok = (r: ApplyResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const errors = (r: ApplyResult) => (r.ok ? [] : r.errors);
const layerOf = (d: Project, id: string) =>
  d.compositions.flatMap((c) => c.layers).find((l) => l.id === id) as Obj;

describe("setTextAnimators", () => {
  it("replaces the list whole with one layer.set change", () => {
    const first = ok(
      applyOps(doc(), [{ op: "setTextAnimators", layer: "t", animators: [animator("a")] }]),
    );
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]).toMatchObject({
      type: "layer.set",
      layerId: "t",
      path: ["animators"],
      before: [],
    });
    const second = ok(
      applyOps(first.doc, [
        { op: "setTextAnimators", layer: "t", animators: [animator("b"), animator("c")] },
      ]),
    );
    expect((layerOf(second.doc, "t").animators as Obj[]).map((a) => a.name)).toEqual(["b", "c"]);
    const cleared = ok(
      applyOps(second.doc, [{ op: "setTextAnimators", layer: "t", animators: [] }]),
    );
    expect(layerOf(cleared.doc, "t").animators).toEqual([]);
  });

  it("refuses non-text layers naming the type", () => {
    expect(
      errors(applyOps(doc(), [{ op: "setTextAnimators", layer: "sol", animators: [] }])),
    ).toMatchObject([{ path: ["ops", 0, "layer"], message: expect.stringContaining("solid") }]);
  });

  it("is a no-op for the same value", () => {
    const r = ok(applyOps(doc(), [{ op: "setTextAnimators", layer: "t", animators: [] }]));
    expect(r.changes).toEqual([]);
  });

  it("refuses more than the maximum and invalid animators", () => {
    const many = Array.from({ length: MAX_TEXT_ANIMATORS + 1 }, (_, i) => animator(`a${i}`));
    expect(
      errors(applyOps(doc(), [{ op: "setTextAnimators", layer: "t", animators: many }])),
    ).toMatchObject([{ path: ["ops", 0, "animators"] }]);
    const bad = { ...animator(), properties: { opacity: prop(5) } };
    expect(
      errors(applyOps(doc(), [{ op: "setTextAnimators", layer: "t", animators: [bad] }])),
    ).not.toEqual([]);
  });

  it("undoes and redoes", () => {
    const s0 = createSceneState(doc());
    const a = applyBatch(s0, "me", [
      { op: "setTextAnimators", layer: "t", animators: [animator()] },
    ]);
    if (!a.ok) throw new Error(JSON.stringify(a.errors));
    const u = undo(a.state, "me");
    if (!u.ok) throw new Error("expected ok");
    expect(u.state.doc).toEqual(s0.doc);
    const r = redo(u.state, "me");
    expect(r.ok && r.state.doc).toEqual(a.state.doc);
  });
});

describe("setShapeContents", () => {
  it("replaces the contents whole with one layer.set change", () => {
    const r = ok(
      applyOps(doc(), [{ op: "setShapeContents", layer: "s", contents: [rect("r2"), fill("f2")] }]),
    );
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ type: "layer.set", layerId: "s", path: ["contents"] });
    expect((layerOf(r.doc, "s").contents as Obj[]).map((i) => i.id)).toEqual(["r2", "f2"]);
  });

  it("refuses non-shape layers naming the type", () => {
    expect(
      errors(applyOps(doc(), [{ op: "setShapeContents", layer: "t", contents: [] }])),
    ).toMatchObject([{ path: ["ops", 0, "layer"], message: expect.stringContaining("text") }]);
  });

  it("is a no-op for the same value", () => {
    const r = ok(
      applyOps(doc(), [{ op: "setShapeContents", layer: "s", contents: [rect("r1"), fill("f1")] }]),
    );
    expect(r.changes).toEqual([]);
  });

  it("validates items and the maximum like the layer schema", () => {
    expect(
      errors(
        applyOps(doc(), [
          { op: "setShapeContents", layer: "s", contents: [{ ...rect("r"), size: prop("x") }] },
        ]),
      ),
    ).not.toEqual([]);
    const many = Array.from({ length: MAX_SHAPE_ITEMS + 1 }, (_, i) => rect(`r${i}`));
    expect(
      errors(applyOps(doc(), [{ op: "setShapeContents", layer: "s", contents: many }])),
    ).toMatchObject([{ path: ["ops", 0, "contents"] }]);
  });

  it("refuses duplicate item ids through whole-document validation", () => {
    expect(
      errors(
        applyOps(doc(), [{ op: "setShapeContents", layer: "s", contents: [rect("x"), rect("x")] }]),
      ),
    ).not.toEqual([]);
  });

  it("undoes and redoes", () => {
    const s0 = createSceneState(doc());
    const a = applyBatch(s0, "me", [
      { op: "setShapeContents", layer: "s", contents: [rect("r9")] },
    ]);
    if (!a.ok) throw new Error(JSON.stringify(a.errors));
    const u = undo(a.state, "me");
    if (!u.ok) throw new Error("expected ok");
    expect(u.state.doc).toEqual(s0.doc);
    const r = redo(u.state, "me");
    expect(r.ok && r.state.doc).toEqual(a.state.doc);
  });
});

it("ops don't move the scene format version", () => {
  expect(SCENE_FORMAT_VERSION).toBe(14);
});
