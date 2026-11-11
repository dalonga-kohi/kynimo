import { withLayerDefaults } from "@kynimo/scene";
import { beforeEach, describe, expect, it } from "vitest";
import { KynimoService, ToolError } from "./service.js";
import { MemoryStore } from "./store.js";

const settings = {
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  duration_frames: 90,
  background: "#000000",
};

const solid = (name: string) =>
  withLayerDefaults({ type: "solid", name, width: 100, height: 100, color: "#ff0000" }, {
    width: 1920,
    height: 1080,
    durationFrames: 90,
  } as never);

const addSolid = (name: string, id?: string) => ({
  op: "addLayer",
  composition: "main",
  layer: solid(name),
  ...(id ? { id } : {}),
});

async function rejection(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a ToolError");
}

let n = 0;
const ids = () => `p-${(++n).toString(16).padStart(32, "0")}`;

describe("KynimoService", () => {
  let store: MemoryStore;
  let svc: KynimoService;
  let project: string;

  beforeEach(async () => {
    store = new MemoryStore();
    svc = new KynimoService(store, "agent", { makeId: ids });
    project = (await svc.createProject({ name: "Demo", idempotency_key: "c1", ...settings })).id;
  });

  const write = (base: number, key: string, ops: unknown[]) =>
    svc.write(
      { project_id: project, base_version: base, idempotency_key: key },
      { kind: "ops", ops },
    );

  it("creates a project at version 1 with an empty main composition", async () => {
    const p = await svc.getProject(project);
    expect(p).toMatchObject({ name: "Demo", version: 1, main_composition_id: "main" });
    expect(p.compositions).toEqual([
      expect.objectContaining({ id: "main", width: 1920, duration_frames: 90, layers: 0 }),
    ]);
    expect(await svc.listProjects()).toEqual([{ id: project, name: "Demo", version: 1 }]);
  });

  it("replays create_project for a repeated key and rejects a reused key with a different request", async () => {
    const again = await svc.createProject({ name: "Demo", idempotency_key: "c1", ...settings });
    expect(again).toMatchObject({ id: project, replayed: true });
    expect(await svc.listProjects()).toHaveLength(1);
    const e = await rejection(
      svc.createProject({ name: "Other", idempotency_key: "c1", ...settings }),
    );
    expect(e.kind).toBe("key_reused");
    expect(await svc.getWriteOutcome("c1")).toMatchObject({ status: "applied", version: 1 });
  });

  it("applies a batch atomically as one new version and reports concrete ids", async () => {
    const r = await write(1, "w1", [
      addSolid("bg"),
      { op: "updateLayer", layer: { name: "bg" }, set: { hidden: true } },
      {
        op: "setTransformTrack",
        layer: { name: "bg" },
        property: "opacity",
        track: {
          keyframes: [
            { frame: 0, value: 0, interpolation: { type: "linear" } },
            { frame: 15, value: 1, interpolation: { type: "linear" } },
          ],
        },
      },
    ]);
    expect(r).toMatchObject({
      version: 2,
      changed: true,
      layers_added: ["layer-1"],
      replayed: false,
    });
    expect(r.layers_changed).toEqual([]);

    const scene = await svc.getScene(project, "summary");
    if (scene.detail !== "summary") throw new Error("expected summary");
    expect(scene.compositions[0]?.layers).toEqual([
      expect.objectContaining({
        id: "layer-1",
        name: "bg",
        type: "solid",
        hidden: true,
        animated: [{ property: "transform.opacity", keyframes: 2, first_frame: 0, last_frame: 15 }],
      }),
    ]);
  });

  it("rejects an invalid batch with pathed errors and leaves the version unchanged", async () => {
    const e = await rejection(
      write(1, "w1", [
        addSolid("a"),
        { op: "updateLayer", layer: { name: "missing" }, set: { solo: true } },
      ]),
    );
    expect(e.kind).toBe("invalid");
    expect(e.errors[0]?.path).toEqual(["ops", 1, "layer"]);
    expect((await svc.getProject(project)).version).toBe(1);
    expect((await svc.getProject(project)).compositions[0]?.layers).toBe(0);
  });

  it("validates layer bodies in full on the server", async () => {
    const e = await rejection(
      write(1, "w1", [
        { op: "addLayer", composition: "main", layer: { ...(solid("a") as object), color: "red" } },
      ]),
    );
    expect(e.kind).toBe("invalid");
    expect(e.errors[0]?.path).toEqual(["ops", 0, "layer", "color"]);
  });

  it("rejects a stale base_version as a conflict and names the current version", async () => {
    await write(1, "w1", [addSolid("a")]);
    const e = await rejection(write(1, "w2", [addSolid("b")]));
    expect(e).toMatchObject({ kind: "conflict", currentVersion: 2 });
    expect((await svc.getProject(project)).version).toBe(2);
  });

  it("returns the original result for a retry with the same key, without applying twice", async () => {
    const first = await write(1, "w1", [addSolid("a")]);
    const retry = await write(1, "w1", [addSolid("a")]);
    expect(retry).toEqual({ ...first, replayed: true });
    expect((await svc.getProject(project)).compositions[0]?.layers).toBe(1);
  });

  it("rejects the same key with a different request", async () => {
    await write(1, "w1", [addSolid("a")]);
    expect((await rejection(write(1, "w1", [addSolid("b")]))).kind).toBe("key_reused");
    expect((await rejection(write(2, "w1", [addSolid("a")]))).kind).toBe("key_reused");
  });

  it("replays a stored rejection for a retried rejected write", async () => {
    const bad = [{ op: "removeLayer", layer: "nope" }];
    const first = await rejection(write(1, "w1", bad));
    const again = await rejection(write(1, "w1", bad));
    expect(again).toMatchObject({ kind: first.kind, errors: first.errors });
    expect(await svc.getWriteOutcome("w1", project)).toMatchObject({
      status: "rejected",
      kind: "invalid",
    });
  });

  it("answers get_write_outcome for applied and unknown keys", async () => {
    await write(1, "w1", [addSolid("a")]);
    expect(await svc.getWriteOutcome("w1", project)).toMatchObject({
      status: "applied",
      version: 2,
      result: expect.objectContaining({ layers_added: ["layer-1"] }),
    });
    expect(await svc.getWriteOutcome("never", project)).toEqual({ status: "unknown" });
  });

  it("scopes keys to the actor", async () => {
    await write(1, "w1", [addSolid("a")]);
    const other = new KynimoService(store, "editor", { makeId: ids });
    expect(await other.getWriteOutcome("w1", project)).toEqual({ status: "unknown" });
    const r = await other.write(
      { project_id: project, base_version: 2, idempotency_key: "w1" },
      { kind: "ops", ops: [addSolid("b")] },
    );
    expect(r.replayed).toBe(false);
  });

  it("keeps a no-op batch at the same version", async () => {
    await write(1, "w1", [addSolid("a", "a")]);
    const r = await write(2, "w2", [{ op: "updateLayer", layer: "a", set: { name: "a" } }]);
    expect(r).toMatchObject({ version: 2, changed: false });
  });

  it("undoes and redoes the actor's own writes, each as a new version", async () => {
    await write(1, "w1", [addSolid("a", "a")]);
    const u = await svc.write(
      { project_id: project, base_version: 2, idempotency_key: "u1" },
      { kind: "undo" },
    );
    expect(u).toMatchObject({ version: 3, layers_removed: ["a"] });
    const r = await svc.write(
      { project_id: project, base_version: 3, idempotency_key: "r1" },
      { kind: "redo" },
    );
    expect(r).toMatchObject({ version: 4, layers_added: ["a"] });
    const e = await rejection(
      svc.write({ project_id: project, base_version: 4, idempotency_key: "r2" }, { kind: "redo" }),
    );
    expect(e.kind).toBe("empty");
  });

  it("refuses an undo whose properties another actor changed later", async () => {
    await write(1, "w1", [addSolid("a", "a")]);
    const editor = new KynimoService(store, "editor", { makeId: ids });
    await editor.write(
      { project_id: project, base_version: 2, idempotency_key: "e1" },
      { kind: "ops", ops: [{ op: "updateLayer", layer: "a", set: { name: "renamed" } }] },
    );
    const e = await rejection(
      svc.write({ project_id: project, base_version: 3, idempotency_key: "u1" }, { kind: "undo" }),
    );
    expect(e.kind).toBe("conflict");
  });

  it("serializes concurrent writes so exactly one wins a version", async () => {
    const results = await Promise.allSettled([
      write(1, "a", [addSolid("a")]),
      write(1, "b", [addSolid("b")]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await svc.getProject(project)).version).toBe(2);
  });

  it("keeps at most the store's key limit per project, dropping the oldest", async () => {
    const small = new KynimoService(new MemoryStore({ maxWriteKeys: 3 }), "agent", { makeId: ids });
    const id = (await small.createProject({ name: "S", idempotency_key: "c", ...settings })).id;
    for (const key of ["old-0", "old-1", "old-2"])
      await rejection(
        small.write({ project_id: id, base_version: 9, idempotency_key: key }, { kind: "undo" }),
      );
    await small.write(
      { project_id: id, base_version: 1, idempotency_key: "new" },
      { kind: "ops", ops: [addSolid("a")] },
    );
    expect(await small.getWriteOutcome("old-0", id)).toEqual({ status: "unknown" });
    expect(await small.getWriteOutcome("old-1", id)).toMatchObject({ status: "rejected" });
    expect(await small.getWriteOutcome("new", id)).toMatchObject({ status: "applied" });
  });

  it("finds layers by selector and gets one in full", async () => {
    await write(1, "w1", [addSolid("title-a"), addSolid("title-b"), addSolid("bg")]);
    const found = await svc.findLayers(project, { name: "title*" }, 50);
    expect(found.total).toBe(2);
    expect(found.layers.map((l) => l.name).sort()).toEqual(["title-a", "title-b"]);
    expect((await svc.findLayers(project, { name: "title*" }, 1)).layers).toHaveLength(1);

    const one = await svc.getLayer(project, { name: "bg" });
    expect(one.layer).toMatchObject({ type: "solid", name: "bg", color: "#ff0000" });
    expect((await rejection(svc.getLayer(project, { name: "title*" }))).message).toMatch(
      /2 layers match/,
    );
    expect((await rejection(svc.getLayer(project, "nope"))).kind).toBe("not_found");
  });

  it("returns the full document, optionally filtered to one composition", async () => {
    const full = await svc.getScene(project, "full", "main");
    if (full.detail !== "full") throw new Error("expected full");
    expect(full.document.compositions.map((c) => c.id)).toEqual(["main"]);
    expect((await rejection(svc.getScene(project, "full", "nope"))).kind).toBe("not_found");
  });

  it("reports unknown projects as not found", async () => {
    expect((await rejection(svc.getProject("p-missing"))).kind).toBe("not_found");
  });

  it("records a rejected create_project with paths named after its inputs", async () => {
    const e = await rejection(
      svc.createProject({
        name: "Bad",
        idempotency_key: "c2",
        ...settings,
        fps: { num: 1000, den: 1 },
      }),
    );
    expect(e.kind).toBe("invalid");
    expect(e.errors[0]?.path[0]).toBe("fps");
    expect(await svc.getWriteOutcome("c2")).toMatchObject({ status: "rejected", kind: "invalid" });
    expect(await svc.listProjects()).toHaveLength(1);
  });

  describe("describeMotion", () => {
    it("describes the main composition, filtered by selector and window", async () => {
      await write(1, "a", [addSolid("Title", "title"), addSolid("Bg", "bg")]);
      await write(2, "k", [
        {
          op: "setTransformTrack",
          layer: "title",
          property: "opacity",
          track: {
            keyframes: [
              { frame: 0, value: 0, interpolation: { type: "linear" } },
              { frame: 30, value: 1, interpolation: { type: "linear" } },
            ],
          },
        },
      ]);
      const d = await svc.describeMotion(project, { layer: { name: "Ti*" } });
      expect(d).toMatchObject({ project_id: project, version: 3, composition: "main" });
      expect(d.layers.map((l) => [l.id, l.properties.map((p) => p.property)])).toEqual([
        ["title", ["transform.opacity"]],
      ]);
      const late = await svc.describeMotion(project, { from_frame: 40 });
      expect(late.layers.flatMap((l) => l.properties)).toEqual([]);
    });

    it("names bad windows, unknown compositions and selectors matching nothing here", async () => {
      const window = await rejection(svc.describeMotion(project, { from_frame: 50, to_frame: 10 }));
      expect(window.errors[0]?.path).toEqual(["to_frame"]);
      const range = await rejection(svc.describeMotion(project, { to_frame: 90 }));
      expect(range.errors).toEqual([
        { path: ["to_frame"], message: "must be a frame from 0 to 89" },
      ]);
      expect((await rejection(svc.describeMotion(project, { composition: "x" }))).kind).toBe(
        "not_found",
      );
      const none = await rejection(svc.describeMotion(project, { layer: { name: "Nope" } }));
      expect(none.kind).toBe("not_found");
      await write(1, "pre", [addSolid("Moved", "moved")]);
      await write(2, "pc", [{ op: "precompose", layers: ["moved"], id: "inner" }]);
      const elsewhere = await rejection(svc.describeMotion(project, { layer: "moved" }));
      expect(elsewhere.message).toMatch(/matches exist in inner \(pass composition\)/);
      const inner = await svc.describeMotion(project, { composition: "inner", layer: "moved" });
      expect(inner.layers.map((l) => l.id)).toEqual(["moved"]);
    });
  });
});
