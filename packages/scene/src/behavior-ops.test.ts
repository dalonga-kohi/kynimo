import { describe, expect, it } from "vitest";
import { common, composition, nullLayer, type Obj, project, prop } from "./fixtures.test-util.js";
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
import { solid } from "./ops.test-util.js";

const wiggleBody = (overrides: Obj = {}): Obj => ({
  name: "Wiggle",
  enabled: true,
  property: "position",
  type: "wiggle",
  frequency: prop(2),
  amplitude: prop([20, 0]),
  octaves: 2,
  seed: 7,
  linked: false,
  ...overrides,
});
const linkBody = (source: string, overrides: Obj = {}): Obj => ({
  name: "Follow",
  enabled: true,
  property: "position",
  type: "link",
  source: { layer: source, property: "position" },
  multiply: 1,
  offset: [0, 0],
  delay: 0,
  ...overrides,
});

/** main: s1, s2 (solids), n (null), snd (audio); other: o (solid). */
const doc = (layers: Obj[] = [solid("s1"), solid("s2"), nullLayer("n")]): Project =>
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
          ...layers,
          { ...common("snd"), type: "audio", assetId: "m", volume: prop(1) },
        ]),
        composition("other", [solid("o")]),
      ],
    }),
  );

const ok = (r: ApplyResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const errors = (r: ApplyResult) => (r.ok ? [] : r.errors);
const layerOf = (d: Project, id: string) =>
  d.compositions.flatMap((c) => c.layers).find((l) => l.id === id) as Obj | undefined;
const behaviorIds = (d: Project, id: string) =>
  ((layerOf(d, id)?.behaviors ?? []) as Obj[]).map((b) => b.id);

describe("behavior ops", () => {
  it("adds behaviors with generated ids, appended by default or at an index", () => {
    const r = ok(
      applyOps(doc(), [
        { op: "addBehavior", layer: "s1", behavior: wiggleBody() },
        { op: "addBehavior", layer: "s1", behavior: wiggleBody(), id: "first", index: 0 },
        { op: "addBehavior", layer: "s2", behavior: wiggleBody() },
        { op: "addBehavior", layer: "n", behavior: wiggleBody() },
      ]),
    );
    expect(behaviorIds(r.doc, "s1")).toEqual(["first", "behavior-1"]);
    expect(behaviorIds(r.doc, "s2")).toEqual(["behavior-2"]);
    expect(behaviorIds(r.doc, "n")).toEqual(["behavior-3"]);
    expect(r.idCounter).toBe(3);
    expect(r.changes[0]).toMatchObject({ type: "layer.set", layerId: "s1", path: ["behaviors"] });
  });

  it("skips generated ids a layer already uses", () => {
    const r = ok(
      applyOps(doc(), [
        { op: "addBehavior", layer: "s1", behavior: wiggleBody(), id: "behavior-1" },
        { op: "addBehavior", layer: "s1", behavior: wiggleBody() },
      ]),
    );
    expect(behaviorIds(r.doc, "s1")).toEqual(["behavior-1", "behavior-2"]);
  });

  it("updates and removes a behavior by id", () => {
    const r = ok(
      applyOps(doc(), [
        { op: "addBehavior", layer: "s1", behavior: wiggleBody(), id: "a" },
        { op: "addBehavior", layer: "s1", behavior: wiggleBody(), id: "b" },
        {
          op: "updateBehavior",
          layer: "s1",
          behavior: "a",
          set: { enabled: false, octaves: 4, frequency: { value: 5 } },
        },
        { op: "removeBehavior", layer: "s1", behavior: "b" },
      ]),
    );
    expect(layerOf(r.doc, "s1")?.behaviors).toMatchObject([
      { id: "a", type: "wiggle", enabled: false, octaves: 4, frequency: { value: 5 }, seed: 7 },
    ]);
  });

  it("an update that changes nothing records no change", () => {
    const start = ok(
      applyOps(doc(), [{ op: "addBehavior", layer: "s1", behavior: wiggleBody(), id: "a" }]),
    );
    const r = ok(
      applyOps(start.doc, [
        { op: "updateBehavior", layer: "s1", behavior: "a", set: { octaves: 2 } },
      ]),
    );
    expect(r.changes).toEqual([]);
  });

  it("rejects bad targets with pathed, actionable errors", () => {
    const d = ok(
      applyOps(doc(), [{ op: "addBehavior", layer: "s1", behavior: wiggleBody(), id: "a" }]),
    ).doc;
    expect(
      errors(applyOps(d, [{ op: "addBehavior", layer: "snd", behavior: wiggleBody() }])),
    ).toMatchObject([
      { path: ["ops", 0, "layer"], message: expect.stringContaining("audio layer") },
    ]);
    expect(
      errors(applyOps(d, [{ op: "addBehavior", layer: "s1", behavior: wiggleBody(), id: "a" }])),
    ).toMatchObject([{ path: ["ops", 0, "id"], message: expect.stringContaining("already") }]);
    expect(
      errors(applyOps(d, [{ op: "addBehavior", layer: "s1", behavior: wiggleBody(), index: 5 }])),
    ).toMatchObject([{ path: ["ops", 0, "index"] }]);
    expect(
      errors(applyOps(d, [{ op: "removeBehavior", layer: "s1", behavior: "zz" }])),
    ).toMatchObject([
      { path: ["ops", 0, "behavior"], message: expect.stringContaining("its behaviors: a") },
    ]);
    expect(
      errors(applyOps(d, [{ op: "updateBehavior", layer: "s1", behavior: "a", set: {} }])),
    ).toMatchObject([{ path: ["ops", 0, "set"] }]);
    expect(
      errors(applyOps(d, [{ op: "updateBehavior", layer: "s1", behavior: "a", set: { id: "b" } }])),
    ).not.toEqual([]);
    // An invalid behavior body is refused at its field.
    expect(
      errors(
        applyOps(d, [{ op: "addBehavior", layer: "s1", behavior: wiggleBody({ octaves: 99 }) }]),
      ),
    ).toMatchObject([{ path: ["ops", 0, "behavior", "octaves"] }]);
  });

  it("refuses to change a behavior's type", () => {
    const d = ok(
      applyOps(doc(), [{ op: "addBehavior", layer: "s1", behavior: wiggleBody(), id: "a" }]),
    ).doc;
    expect(
      errors(
        applyOps(d, [
          { op: "updateBehavior", layer: "s1", behavior: "a", set: { type: "oscillate" } },
        ]),
      ),
    ).toEqual([
      {
        path: ["ops", 0, "set", "type"],
        message: "a behavior's type can't change; remove it and add a new behavior",
      },
    ]);
  });

  it("refuses fields the behavior's type does not have", () => {
    const d = ok(
      applyOps(doc(), [{ op: "addBehavior", layer: "s1", behavior: wiggleBody(), id: "a" }]),
    ).doc;
    expect(
      errors(
        applyOps(d, [
          { op: "updateBehavior", layer: "s1", behavior: "a", set: { waveform: "sine" } },
        ]),
      ),
    ).toMatchObject([
      {
        path: ["ops", 0, "set", "waveform"],
        message: expect.stringContaining("not a field of a wiggle behavior"),
      },
    ]);
  });

  it("validates the merged behavior, with a pathed op error rather than a throw", () => {
    const d = ok(
      applyOps(doc(), [{ op: "addBehavior", layer: "s1", behavior: wiggleBody(), id: "a" }]),
    ).doc;
    const bad = (set: Obj) =>
      errors(applyOps(d, [{ op: "updateBehavior", layer: "s1", behavior: "a", set }]));
    // Zero is no valid octave count.
    expect(bad({ octaves: 0 })).toMatchObject([{ path: ["ops", 0, "set", "octaves"] }]);
    // A plain number is no valid wiggle frequency track.
    expect(bad({ frequency: 3 })).not.toEqual([]);
    // Integrity rules still apply to the result: a number amplitude on a vector property.
    expect(bad({ amplitude: { value: 5 } })).toMatchObject([
      {
        path: ["doc", "compositions", 0, "layers", 0, "behaviors", 0, "amplitude", "value"],
        message: expect.stringContaining("must be [x, y]"),
      },
    ]);
  });

  it("checks link sources at op time and in the project", () => {
    expect(
      errors(applyOps(doc(), [{ op: "addBehavior", layer: "s1", behavior: linkBody("o") }])),
    ).toMatchObject([
      {
        path: ["ops", 0, "behavior", "source", "layer"],
        message: expect.stringContaining("same composition"),
      },
    ]);
    expect(
      errors(applyOps(doc(), [{ op: "addBehavior", layer: "s1", behavior: linkBody("snd") }]))[0]
        ?.message,
    ).toContain("audio layer");
    const cycle = applyOps(doc(), [
      { op: "addBehavior", layer: "s1", behavior: linkBody("s2") },
      { op: "addBehavior", layer: "s2", behavior: linkBody("s1") },
    ]);
    expect(errors(cycle)[0]?.message).toContain("link cycle");
    const linked = ok(
      applyOps(doc(), [{ op: "addBehavior", layer: "s1", behavior: linkBody("s2"), id: "k" }]),
    );
    // Moving the source to another composition of an update is caught at op time too.
    expect(
      errors(
        applyOps(linked.doc, [
          {
            op: "updateBehavior",
            layer: "s1",
            behavior: "k",
            set: { source: { layer: "o", property: "position" } },
          },
        ]),
      ),
    ).toMatchObject([{ path: ["ops", 0, "set", "source", "layer"] }]);
  });

  it("removing a link's source layer fails validation naming the linking layer", () => {
    const linked = ok(
      applyOps(doc(), [{ op: "addBehavior", layer: "s1", behavior: linkBody("s2"), id: "k" }]),
    );
    const r = applyOps(linked.doc, [{ op: "removeLayer", layer: "s2" }]);
    expect(errors(r)).toMatchObject([
      {
        path: ["doc", "compositions", 0, "layers", 0, "behaviors", 0, "source", "layer"],
        message: expect.stringContaining("layer 's1' has a link behavior 'k'"),
      },
    ]);
    // Removing the behavior first works.
    expect(
      applyOps(linked.doc, [
        { op: "removeBehavior", layer: "s1", behavior: "k" },
        { op: "removeLayer", layer: "s2" },
      ]).ok,
    ).toBe(true);
  });

  it("undoes and redoes behavior edits", () => {
    const s0 = createSceneState(doc());
    const a = applyBatch(s0, "me", [{ op: "addBehavior", layer: "s1", behavior: wiggleBody() }]);
    if (!a.ok) throw new Error("expected ok");
    const u = undo(a.state, "me");
    if (!u.ok) throw new Error("expected ok");
    expect(u.state.doc).toEqual(s0.doc);
    const r = redo(u.state, "me");
    expect(r.ok && behaviorIds(r.state.doc, "s1")).toEqual(["behavior-1"]);

    const b = applyBatch(a.state, "me", [
      { op: "updateBehavior", layer: "s1", behavior: "behavior-1", set: { octaves: 5 } },
    ]);
    if (!b.ok) throw new Error("expected ok");
    const ub = undo(b.state, "me");
    expect(ub.ok && ub.state.doc).toEqual(a.state.doc);
  });
});

describe("precompose and links", () => {
  const start = () =>
    doc([
      { ...solid("s1"), behaviors: [{ ...linkBody("s2"), id: "k" }] },
      solid("s2"),
      solid("s3"),
      {
        ...solid("s4"),
        behaviors: [
          { ...linkBody("s4", { source: { layer: "s4", property: "anchorPoint" } }), id: "self" },
        ],
      },
    ]);
  const p = (...layers: string[]) => [{ op: "precompose", layers }];

  it("refuses to split a link from its source, from either side", () => {
    expect(errors(applyOps(start(), p("s1")))).toMatchObject([
      {
        path: ["ops", 0, "layers", 0],
        message: expect.stringContaining(
          "layer 's1' has a link behavior pointing at layer 's2', which is not being precomposed",
        ),
      },
    ]);
    expect(errors(applyOps(start(), p("s2")))).toMatchObject([
      {
        path: ["ops", 0, "layers", 0],
        message: expect.stringContaining(
          "'s1' (not being precomposed) has a link behavior pointing at layer 's2'; add 's1' to layers, or remove the link behavior first",
        ),
      },
    ]);
  });

  it("allows precomposing a link with its source, and a layer linked to itself", () => {
    const r = ok(applyOps(start(), p("s1", "s2")));
    expect(layerOf(r.doc, "s1")?.behaviors).toMatchObject([{ id: "k" }]);
    expect(applyOps(start(), p("s4")).ok).toBe(true);
    expect(applyOps(start(), p("s3")).ok).toBe(true);
  });

  it("the precomp layer it makes has an empty behavior list", () => {
    const r = ok(applyOps(start(), [{ op: "precompose", layers: ["s3"], layerId: "g" }]));
    expect(layerOf(r.doc, "g")?.behaviors).toEqual([]);
  });
});
