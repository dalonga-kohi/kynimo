import { describe, expect, it } from "vitest";
import { nullLayer } from "./fixtures.test-util.js";
import { applyBatch, MAX_HISTORY, redo, undo } from "./index.js";
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

describe("undo/redo: every change kind", () => {
  it("undoes and redoes a reorder, and conflicts if another actor reorders", () => {
    let s = must(applyBatch(baseState(), "alice", [{ op: "reorderLayer", layer: "c", index: 0 }]));
    expect(layerIds(s.doc)).toEqual(["c", "a", "b"]);
    const u = undo(s, "alice");
    if (!u.ok) throw new Error("expected ok");
    expect(layerIds(u.state.doc)).toEqual(["a", "b", "c"]);
    const r = redo(u.state, "alice");
    expect(r.ok && layerIds(r.state.doc)).toEqual(["c", "a", "b"]);
    s = must(applyBatch(s, "bob", [{ op: "reorderLayer", layer: "c", index: 2 }]));
    expect(undo(s, "alice")).toMatchObject({ ok: false, kind: "conflict" });
  });

  it("undoes and redoes marker add and remove", () => {
    const m = { frame: 3, durationFrames: 0, name: "m" };
    let s = must(
      applyBatch(baseState(), "alice", [
        { op: "addMarker", target: { layer: "a" }, id: "m1", marker: m },
      ]),
    );
    s = must(applyBatch(s, "alice", [{ op: "removeMarker", marker: "m1" }]));
    const markers = (st: typeof s) => st.doc.compositions[0]?.layers[0]?.markers.length;
    expect(markers(s)).toBe(0);
    const u1 = undo(s, "alice");
    if (!u1.ok) throw new Error("expected ok");
    expect(markers(u1.state)).toBe(1);
    const u2 = undo(u1.state, "alice");
    if (!u2.ok) throw new Error("expected ok");
    expect(markers(u2.state)).toBe(0);
    const r = redo(u2.state, "alice");
    expect(r.ok && markers(r.state)).toBe(1);
  });

  it("undoing an add conflicts if another actor edited the new layer (checked per layer, not per property)", () => {
    let s = must(
      applyBatch(baseState(), "alice", [
        { op: "addLayer", composition: "main", id: "n", layer: omitId(nullLayer("n")) },
      ]),
    );
    s = must(applyBatch(s, "bob", hide("n")));
    expect(undo(s, "alice")).toMatchObject({ ok: false, kind: "conflict" });
  });

  it("keeps at most MAX_HISTORY batches per actor", () => {
    let s = baseState();
    for (let k = 0; k < MAX_HISTORY + 5; k++)
      s = must(
        applyBatch(s, "alice", [{ op: "updateLayer", layer: "a", set: { startFrame: k + 1 } }]),
      );
    let n = 0;
    for (let r = undo(s, "alice"); r.ok; r = undo(r.state, "alice")) n++;
    expect(n).toBe(MAX_HISTORY);
  });

  it("is deterministic and not corrupted by callers mutating returned changes", () => {
    const run = () => {
      let s = must(
        applyBatch(baseState(), "alice", [{ op: "updateLayer", layer: "a", set: { name: "x" } }]),
      );
      const u = undo(s, "alice");
      if (!u.ok) throw new Error("expected ok");
      for (const c of u.changes) if (c.type === "layer.set") c.after = "tampered";
      const r = redo(u.state, "alice");
      if (!r.ok) throw new Error("expected ok");
      s = r.state;
      return s.doc;
    };
    expect(run()).toEqual(run());
    expect(run().compositions[0]?.layers[0]?.name).toBe("x");
  });
});
