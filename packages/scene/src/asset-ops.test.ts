import { describe, expect, it } from "vitest";
import { composition, type Obj, project, visual } from "./fixtures.test-util.js";
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
import { omitId } from "./ops.test-util.js";

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

const imageBody = (overrides: Obj = {}): Obj => ({
  type: "image",
  name: "Logo",
  uri: `assets/${SHA}.png`,
  sha256: SHA,
  width: 64,
  height: 32,
  ...overrides,
});

const fontBody = (overrides: Obj = {}): Obj => ({
  type: "font",
  name: "Brand",
  uri: `assets/${SHA2}.ttf`,
  sha256: SHA2,
  family: "Brand Sans",
  weight: { min: 400, max: 400 },
  ...overrides,
});

const imageLayer = (id: string, assetId: string): Obj => ({
  ...visual(id),
  type: "image",
  assetId,
});

const textLayer = (id: string, family: string): Obj => ({
  ...visual(id),
  type: "text",
  content: { value: "Hi" },
  box: { mode: "point" },
  font: { family, weight: 400, size: { value: 48 } },
  tracking: { value: 0 },
  leading: { value: 1.2 },
  align: "left",
  textCase: "none",
  fill: { value: "#ffffff" },
});

const doc = (assets: Obj[] = [], layers: Obj[] = []): Project =>
  ProjectSchema.parse(
    project({
      assets: assets.map((a, i) => ({ id: `a${i + 1}`, ...a })),
      compositions: [composition("main", layers)],
    }),
  );

const ok = (r: ApplyResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const errors = (r: ApplyResult) => (r.ok ? [] : r.errors);

describe("asset ops", () => {
  it("appends assets with given or generated ids", () => {
    const r = ok(
      applyOps(doc(), [
        { op: "addAsset", asset: imageBody() },
        { op: "addAsset", id: "brand", asset: fontBody() },
      ]),
    );
    expect(r.doc.assets.map((a) => a.id)).toEqual(["asset-1", "brand"]);
    expect(r.idCounter).toBe(1);
    expect(r.changes.map((c) => c.type)).toEqual(["asset.insert", "asset.insert"]);
  });

  it("lets a later op of the batch use the new asset", () => {
    const r = ok(
      applyOps(doc(), [
        { op: "addAsset", id: "logo", asset: imageBody() },
        { op: "addLayer", composition: "main", id: "img", layer: omitId(imageLayer("x", "logo")) },
      ]),
    );
    expect(r.doc.compositions[0]?.layers[0]).toMatchObject({ id: "img", assetId: "logo" });
  });

  it("refuses an id in use, and a generated id skips ids in use", () => {
    const d = doc([imageBody()]);
    expect(errors(applyOps(d, [{ op: "addAsset", id: "a1", asset: imageBody() }]))).toEqual([
      { path: ["ops", 0, "id"], message: expect.stringContaining("already in use") },
    ]);
    const taken = ProjectSchema.parse({
      ...d,
      assets: [{ ...d.assets[0], id: "asset-1" }],
    });
    expect(
      ok(applyOps(taken, [{ op: "addAsset", asset: imageBody() }])).doc.assets.map((a) => a.id),
    ).toEqual(["asset-1", "asset-2"]);
  });

  it("validates the asset body and the resulting document", () => {
    expect(
      errors(applyOps(doc(), [{ op: "addAsset", asset: imageBody({ sha256: "nope" }) }]))[0]?.path,
    ).toEqual(["ops", 0, "asset", "sha256"]);
    // A second file covering the same weight of one family fails the document's integrity check.
    expect(
      errors(applyOps(doc([fontBody()]), [{ op: "addAsset", asset: fontBody() }]))[0]?.path,
    ).toEqual(["doc", "assets", 1, "weight"]);
  });

  it("removes an unused asset", () => {
    const r = ok(applyOps(doc([imageBody(), fontBody()]), [{ op: "removeAsset", asset: "a1" }]));
    expect(r.doc.assets.map((a) => a.id)).toEqual(["a2"]);
    expect(r.changes).toMatchObject([{ type: "asset.remove", assetId: "a1", index: 0 }]);
  });

  it("refuses to remove a missing asset or one a layer still uses, naming the layers", () => {
    const d = doc([imageBody()], [imageLayer("img", "a1")]);
    expect(errors(applyOps(d, [{ op: "removeAsset", asset: "zz" }]))).toEqual([
      { path: ["ops", 0, "asset"], message: expect.stringContaining("does not exist") },
    ]);
    expect(errors(applyOps(d, [{ op: "removeAsset", asset: "a1" }]))).toEqual([
      { path: ["ops", 0, "asset"], message: expect.stringContaining("used by layer 'img'") },
    ]);
    // Removing the layer first in the same batch frees it.
    ok(
      applyOps(d, [
        { op: "removeLayer", layer: "img" },
        { op: "removeAsset", asset: "a1" },
      ]),
    );
  });

  it("refuses to remove the last font file of a family text still uses, not one of several", () => {
    const d = doc(
      [
        fontBody(),
        fontBody({ sha256: SHA, uri: `assets/${SHA}.ttf`, weight: { min: 700, max: 700 } }),
      ],
      [textLayer("t", "Brand Sans")],
    );
    ok(applyOps(d, [{ op: "removeAsset", asset: "a1" }]));
    expect(
      errors(
        applyOps(d, [
          { op: "removeAsset", asset: "a1" },
          { op: "removeAsset", asset: "a2" },
        ]),
      ),
    ).toEqual([{ path: ["ops", 1, "asset"], message: expect.stringContaining("layer 't'") }]);
  });

  it("undoes and redoes an upload and a removal", () => {
    const start = createSceneState(doc());
    const added = applyBatch(start, "alice", [{ op: "addAsset", id: "logo", asset: imageBody() }]);
    if (!added.ok) throw new Error(JSON.stringify(added.errors));
    const back = undo(added.state, "alice");
    if (!back.ok) throw new Error(JSON.stringify(back.errors));
    expect(back.state.doc.assets).toEqual([]);
    const again = redo(back.state, "alice");
    if (!again.ok) throw new Error(JSON.stringify(again.errors));
    expect(again.state.doc.assets.map((a) => a.id)).toEqual(["logo"]);

    const removed = applyBatch(again.state, "alice", [{ op: "removeAsset", asset: "logo" }]);
    if (!removed.ok) throw new Error(JSON.stringify(removed.errors));
    const restored = undo(removed.state, "alice");
    if (!restored.ok) throw new Error(JSON.stringify(restored.errors));
    expect(restored.state.doc.assets).toEqual(again.state.doc.assets);
  });
});
