import { describe, expect, it } from "vitest";
import { nullLayer } from "./fixtures.test-util.js";
import { applyBatch, redo, undo } from "./index.js";
import { baseState, layerIds, omitId } from "./ops.test-util.js";

const hide = (layer: string, hidden = true) => [{ op: "updateLayer", layer, set: { hidden } }];

const must = (r: ReturnType<typeof applyBatch>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.state;
};

describe("per-actor undo/redo", () => {
  it("undoes then redoes the actor's last batch as one unit", () => {
    let s = must(
      applyBatch(baseState(), "alice", [...hide("a"), { op: "removeLayer", layer: "c" }]),
    );
    expect(layerIds(s.doc)).toEqual(["a", "b"]);
    const u = undo(s, "alice");
    if (!u.ok) throw new Error(JSON.stringify(u.errors));
    s = u.state;
    expect(layerIds(s.doc)).toEqual(["a", "b", "c"]);
    expect(s.doc).toEqual(baseState().doc);
    expect(u.changes.map((c) => c.type)).toEqual(["layer.insert", "layer.set"]);
    const r = redo(s, "alice");
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(layerIds(r.state.doc)).toEqual(["a", "b"]);
    expect(r.state.doc.compositions[0]?.layers[0]?.hidden).toBe(true);
  });

  it("undoes only the caller's own batch, not the latest change", () => {
    let s = must(applyBatch(baseState(), "alice", hide("a")));
    s = must(applyBatch(s, "bob", hide("c")));
    const u = undo(s, "alice");
    if (!u.ok) throw new Error(JSON.stringify(u.errors));
    const layers = u.state.doc.compositions[0]?.layers ?? [];
    expect(layers.map((l) => l.hidden)).toEqual([false, false, true]);
  });

  it("walks back through several batches in order", () => {
    let s = must(
      applyBatch(baseState(), "alice", [{ op: "updateLayer", layer: "a", set: { name: "one" } }]),
    );
    s = must(applyBatch(s, "alice", [{ op: "updateLayer", layer: "a", set: { name: "two" } }]));
    for (const expected of ["one", "a"]) {
      const u = undo(s, "alice");
      if (!u.ok) throw new Error("expected ok");
      s = u.state;
      expect(s.doc.compositions[0]?.layers[0]?.name).toBe(expected);
    }
    expect(undo(s, "alice")).toMatchObject({ ok: false, kind: "empty" });
  });

  it("a new batch clears that actor's redo", () => {
    let s = must(applyBatch(baseState(), "alice", hide("a")));
    const u = undo(s, "alice");
    if (!u.ok) throw new Error("expected ok");
    s = must(applyBatch(u.state, "alice", hide("b")));
    expect(redo(s, "alice")).toMatchObject({ ok: false, kind: "empty" });
  });

  it("fails with a conflict when another actor touched the same property, and leaves state alone", () => {
    let s = must(
      applyBatch(baseState(), "alice", [
        { op: "updateLayer", layer: "a", set: { name: "alice-name" } },
      ]),
    );
    s = must(applyBatch(s, "bob", [{ op: "updateLayer", layer: "a", set: { name: "bob-name" } }]));
    const u = undo(s, "alice");
    expect(u).toMatchObject({ ok: false, kind: "conflict", state: s });
    expect(s.doc.compositions[0]?.layers[0]?.name).toBe("bob-name");
  });

  it("does not conflict when the other actor touched a different property", () => {
    let s = must(
      applyBatch(baseState(), "alice", [
        { op: "updateLayer", layer: "a", set: { name: "alice-name" } },
      ]),
    );
    s = must(applyBatch(s, "bob", hide("a")));
    const u = undo(s, "alice");
    if (!u.ok) throw new Error(JSON.stringify(u.errors));
    expect(u.state.doc.compositions[0]?.layers[0]).toMatchObject({ name: "a", hidden: true });
  });

  it("conflicts when undoing would break integrity, and when redo no longer matches", () => {
    // alice removes c; bob adds a layer with id c back -> undo (re-insert c) conflicts.
    let s = must(applyBatch(baseState(), "alice", [{ op: "removeLayer", layer: "c" }]));
    s = must(
      applyBatch(s, "bob", [
        { op: "addLayer", composition: "main", id: "c", layer: omitId(nullLayer("c")) },
      ]),
    );
    expect(undo(s, "alice")).toMatchObject({ ok: false, kind: "conflict" });

    // redo conflict: alice hides a, undoes, bob renames-hides a differently
    let t = must(applyBatch(baseState(), "alice", hide("a")));
    const u = undo(t, "alice");
    if (!u.ok) throw new Error("expected ok");
    t = must(applyBatch(u.state, "bob", hide("a")));
    expect(redo(t, "alice")).toMatchObject({ ok: false, kind: "conflict" });
  });

  it("rejects an invalid actor and invalid ops without touching state", () => {
    const s = baseState();
    expect(applyBatch(s, "", hide("a"))).toMatchObject({ ok: false, kind: "invalid", state: s });
    expect(applyBatch(s, "alice", [{ op: "removeLayer", layer: "zzz" }])).toMatchObject({
      ok: false,
      kind: "invalid",
      state: s,
    });
  });
});
