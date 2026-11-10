import { describe, expect, it } from "vitest";
import {
  common,
  composition,
  issues,
  nullLayer,
  type Obj,
  project,
  prop,
} from "./fixtures.test-util.js";
import { BehaviorSchema, MAX_BEHAVIORS } from "./index.js";
import { solid } from "./ops.test-util.js";

const wiggle = (overrides: Obj = {}): Obj => ({
  id: "w",
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
const oscillate = (overrides: Obj = {}): Obj => ({
  id: "o",
  name: "Oscillate",
  enabled: true,
  property: "rotation",
  type: "oscillate",
  frequency: prop(1),
  amplitude: prop(10),
  phase: 0,
  waveform: "sine",
  ...overrides,
});
const loop = (overrides: Obj = {}): Obj => ({
  id: "l",
  name: "Loop",
  enabled: true,
  property: "rotation",
  type: "loop",
  direction: "out",
  mode: "cycle",
  span: 0,
  ...overrides,
});
const inertia = (overrides: Obj = {}): Obj => ({
  id: "i",
  name: "Inertia",
  enabled: true,
  property: "position",
  type: "inertia",
  amplitude: 0.1,
  frequency: 3,
  decay: 4,
  ...overrides,
});
const link = (overrides: Obj = {}): Obj => ({
  id: "k",
  name: "Link",
  enabled: true,
  property: "position",
  type: "link",
  source: { layer: "b", property: "position" },
  multiply: 1,
  offset: [0, 0],
  delay: 0,
  ...overrides,
});

/** main: a (the layer under test), b (solid), n (null); other: o. */
const withBehaviors = (behaviors: Obj[], others: Obj[] = []) =>
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
        { ...solid("a"), behaviors },
        solid("b"),
        nullLayer("n"),
        { ...common("snd"), type: "audio", assetId: "m", volume: prop(1) },
        ...others,
      ]),
      composition("other", [solid("o")]),
    ],
  });

const first = (input: unknown) => issues(input)[0];

describe("behavior schema", () => {
  it("accepts one of each type, on any property of the right kind", () => {
    const behaviors = [
      wiggle(),
      oscillate(),
      loop(),
      inertia(),
      link({ property: "scale", source: { layer: "b", property: "scale" }, offset: [0, 0] }),
      oscillate({ id: "o2", property: "scale", amplitude: prop([0.1, 0.1]) }),
      wiggle({ id: "w2", property: "scale", linked: true, amplitude: prop([0.1, 0.1]) }),
    ];
    expect(issues(withBehaviors(behaviors))).toEqual([]);
  });

  it("accepts keyframed frequency and amplitude", () => {
    const kf = (frame: number, value: unknown) => ({
      frame,
      value,
      interpolation: { type: "linear" },
    });
    expect(
      issues(
        withBehaviors([
          wiggle({
            frequency: { keyframes: [kf(0, 1), kf(30, 3)] },
            amplitude: { keyframes: [kf(0, [1, 1]), kf(30, [5, 5])] },
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it("treats a missing behaviors list as empty", () => {
    const { behaviors: _behaviors, ...bare } = solid("a");
    const input = project({ compositions: [composition("main", [bare])] });
    expect(issues(input)).toEqual([]);
  });

  it("rejects out-of-range and malformed parameters at the field's path", () => {
    const bad = (b: Obj, field: string) => {
      const r = issues(withBehaviors([b]));
      expect(r.length, field).toBeGreaterThan(0);
      expect(r[0]?.path, field).toContain(`layers.0.behaviors.0${field === "" ? "" : `.${field}`}`);
    };
    bad(wiggle({ octaves: 0 }), "octaves");
    bad(wiggle({ octaves: 9 }), "octaves");
    bad(wiggle({ octaves: 1.5 }), "octaves");
    bad(wiggle({ seed: -1 }), "seed");
    bad(wiggle({ seed: 4294967296 }), "seed");
    bad(wiggle({ frequency: prop(-1) }), "frequency");
    bad(wiggle({ linked: "yes" }), "linked");
    bad(oscillate({ waveform: "noise" }), "waveform");
    bad(oscillate({ phase: "90" }), "phase");
    bad(loop({ direction: "up" }), "direction");
    bad(loop({ mode: "bounce" }), "mode");
    bad(loop({ span: -1 }), "span");
    bad(loop({ span: 1.5 }), "span");
    bad(inertia({ amplitude: -1 }), "amplitude");
    bad(inertia({ frequency: 0 }), "frequency");
    bad(inertia({ decay: -1 }), "decay");
    bad(link({ delay: -1 }), "delay");
    bad(link({ delay: 0.5 }), "delay");
    bad(link({ property: "bogus" }), "property");
    bad(link({ source: { layer: "b", property: "bogus" } }), "source.property");
    bad(link({ source: { layer: "B!", property: "position" } }), "source.layer");
    bad(wiggle({ extra: 1 }), "");
    bad({ ...wiggle(), type: "shake" }, "");
  });

  it("accepts the largest octave count and seed", () => {
    expect(BehaviorSchema.safeParse(wiggle({ octaves: 8, seed: 4294967295 })).success).toBe(true);
  });

  it("allows at most MAX_BEHAVIORS per layer", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => oscillate({ id: `o${i}`, property: "rotation" }));
    expect(issues(withBehaviors(many(MAX_BEHAVIORS)))).toEqual([]);
    expect(first(withBehaviors(many(MAX_BEHAVIORS + 1)))?.path).toBe(
      "compositions.0.layers.0.behaviors",
    );
  });
});

describe("behavior project checks", () => {
  it("refuses duplicate behavior ids within a layer, but not across layers", () => {
    const dup = withBehaviors([wiggle(), oscillate({ id: "w" })]);
    expect(issues(dup)).toEqual([
      {
        path: "compositions.0.layers.0.behaviors.1.id",
        message: expect.stringContaining("duplicate behavior id 'w'"),
      },
    ]);
    const across = withBehaviors([wiggle()], []);
    (across as { compositions: { layers: Obj[] }[] }).compositions[0]?.layers.splice(1, 1, {
      ...solid("b"),
      behaviors: [wiggle()],
    });
    expect(issues(across)).toEqual([]);
  });

  it("checks the value kind against the property, naming the expected kind", () => {
    const kind = (b: Obj) => issues(withBehaviors([b]));
    expect(kind(wiggle({ amplitude: prop(5) }))).toEqual([
      {
        path: "compositions.0.layers.0.behaviors.0.amplitude.value",
        message: expect.stringContaining("amplitude must be [x, y], not a number"),
      },
    ]);
    expect(kind(oscillate({ amplitude: prop([1, 2]) }))).toEqual([
      {
        path: "compositions.0.layers.0.behaviors.0.amplitude.value",
        message: expect.stringContaining("amplitude must be a number, not [x, y]"),
      },
    ]);
    const kfs = {
      keyframes: [
        { frame: 0, value: [1, 1], interpolation: { type: "linear" } },
        { frame: 10, value: 3, interpolation: { type: "linear" } },
      ],
    };
    expect(kind(wiggle({ amplitude: kfs }))).toEqual([
      {
        path: "compositions.0.layers.0.behaviors.0.amplitude.keyframes.1.value",
        message: expect.stringContaining("must be [x, y]"),
      },
    ]);
    expect(kind(link({ offset: 3 }))[0]).toMatchObject({
      path: "compositions.0.layers.0.behaviors.0.offset",
      message: expect.stringContaining("offset must be [x, y]"),
    });
    expect(
      kind(link({ property: "opacity", source: { layer: "b", property: "opacity" } }))[0],
    ).toMatchObject({ message: expect.stringContaining("offset must be a number") });
  });

  it("allows 'linked' only on vector properties", () => {
    expect(issues(withBehaviors([wiggle({ linked: true })]))).toEqual([]);
    expect(
      issues(withBehaviors([wiggle({ property: "rotation", amplitude: prop(3), linked: true })])),
    ).toEqual([
      {
        path: "compositions.0.layers.0.behaviors.0.linked",
        message: expect.stringContaining("'linked' applies to anchorPoint, position and scale"),
      },
    ]);
  });

  it("allows one link, one inertia and one loop per direction per property", () => {
    const second = (a: Obj, b: Obj) => issues(withBehaviors([a, b]));
    expect(second(inertia(), inertia({ id: "i2" }))[0]?.message).toContain("second inertia");
    expect(second(loop(), loop({ id: "l2" }))[0]?.message).toContain("second loop out");
    expect(
      second(loop({ direction: "in" }), loop({ id: "l2", direction: "in" }))[0]?.message,
    ).toContain("second loop in");
    expect(second(link(), link({ id: "k2" }))[0]?.message).toContain("second link");
    // Other properties, other directions and wiggles stack freely.
    expect(second(loop(), loop({ id: "l2", direction: "in" }))).toEqual([]);
    expect(second(inertia(), inertia({ id: "i2", property: "rotation" }))).toEqual([]);
    expect(second(wiggle(), wiggle({ id: "w2", seed: 8 }))).toEqual([]);
  });

  it("refuses a loop or inertia on a property that also has a link", () => {
    const r = issues(withBehaviors([link(), inertia(), loop({ property: "position" })]));
    expect(r).toHaveLength(2);
    for (const i of r) expect(i.message).toContain("the link would hide");
    expect(r.map((i) => i.path)).toEqual([
      "compositions.0.layers.0.behaviors.1.property",
      "compositions.0.layers.0.behaviors.2.property",
    ]);
    // Wiggle and oscillate add on top of a link, so they are fine.
    expect(
      issues(
        withBehaviors([
          link(),
          wiggle({ id: "w" }),
          oscillate({ id: "o", property: "position", amplitude: prop([1, 1]) }),
        ]),
      ),
    ).toEqual([]);
  });

  describe("link sources", () => {
    it("names the linking layer and behavior when the source is missing", () => {
      const r = issues(withBehaviors([link({ source: { layer: "gone", property: "position" } })]));
      expect(r).toEqual([
        {
          path: "compositions.0.layers.0.behaviors.0.source.layer",
          message: expect.stringMatching(
            /layer 'a' has a link behavior 'k' whose source layer 'gone' does not exist \(was it removed\?\)/,
          ),
        },
      ]);
    });

    it("refuses a source in another composition, with that composition named", () => {
      const r = issues(withBehaviors([link({ source: { layer: "o", property: "position" } })]));
      expect(r[0]).toMatchObject({
        path: "compositions.0.layers.0.behaviors.0.source.layer",
        message: expect.stringContaining("in composition 'other', not 'main'"),
      });
    });

    it("refuses an audio source", () => {
      const r = issues(withBehaviors([link({ source: { layer: "snd", property: "position" } })]));
      expect(r[0]?.message).toContain("an audio layer");
    });

    it("refuses a source property of another kind", () => {
      const r = issues(withBehaviors([link({ source: { layer: "b", property: "rotation" } })]));
      expect(r).toEqual([
        {
          path: "compositions.0.layers.0.behaviors.0.source.property",
          message: expect.stringContaining("link properties of the same kind"),
        },
      ]);
    });

    it("refuses reading its own property, allows another property of itself", () => {
      const self = link({ source: { layer: "a", property: "position" } });
      expect(first(withBehaviors([self]))?.message).toContain("reads its own position");
      const other = link({
        property: "position",
        source: { layer: "a", property: "anchorPoint" },
      });
      expect(issues(withBehaviors([other]))).toEqual([]);
    });

    it("accepts null layers as sources", () => {
      expect(
        issues(withBehaviors([link({ source: { layer: "n", property: "position" } })])),
      ).toEqual([]);
    });
  });

  describe("link cycles", () => {
    const pos = (id: string, to: string, extra: Obj = {}, property = "position") => ({
      ...solid(id),
      behaviors: [link({ id: `k-${id}`, property, source: { layer: to, property }, ...extra })],
    });
    const layers = (...ls: Obj[]) =>
      project({ compositions: [composition("main", ls), composition("other", [solid("o")])] });

    it("reports a two-layer cycle once, with the loop listed", () => {
      const r = issues(layers(pos("x", "y"), pos("y", "x")));
      expect(r).toEqual([
        {
          path: "compositions.0.layers.0.behaviors.0.source",
          message: expect.stringContaining(
            "link cycle (2 properties): x.position -> y.position -> x.position",
          ),
        },
      ]);
    });

    it("reports a three-layer cycle, whatever the delays, enabled flags or list order", () => {
      const r = issues(
        layers(
          pos("z", "x", { delay: 5 }),
          pos("x", "y", { enabled: false }),
          pos("y", "z", { delay: 100 }),
        ),
      );
      expect(r).toHaveLength(1);
      expect(r[0]?.message).toContain(
        "link cycle (3 properties): z.position -> x.position -> y.position -> z.position",
      );
      expect(r[0]?.path).toBe("compositions.0.layers.0.behaviors.0.source");
    });

    it("finds a cycle through different properties of one layer", () => {
      const a = {
        ...solid("a"),
        behaviors: [
          link({ id: "k1", property: "position", source: { layer: "a", property: "anchorPoint" } }),
          link({ id: "k2", property: "anchorPoint", source: { layer: "b", property: "position" } }),
        ],
      };
      const b = pos("b", "a");
      const r = issues(layers(a, b));
      expect(r).toHaveLength(1);
      expect(r[0]?.message).toContain("link cycle (3 properties)");
    });

    it("accepts chains, diamonds and links across properties without a loop", () => {
      const a = {
        ...solid("a"),
        behaviors: [
          link({ id: "k1", property: "position", source: { layer: "b", property: "position" } }),
          link({
            id: "k2",
            property: "scale",
            source: { layer: "c", property: "scale" },
            offset: [0, 0],
          }),
        ],
      };
      const b = pos("b", "c");
      const c = pos("c", "d");
      expect(issues(layers(a, b, c, solid("d")))).toEqual([]);
    });

    it("scales to long chains without recursion", () => {
      const n = 900; // the layer limit is 1000 per composition
      const chain = Array.from({ length: n }, (_, i) =>
        i === n - 1 ? solid(`l${i}`) : pos(`l${i}`, `l${i + 1}`),
      );
      expect(issues(layers(...chain))).toEqual([]);
      const closed = chain.map((l, i) => (i === n - 1 ? pos(`l${i}`, "l0") : l));
      expect(issues(layers(...closed))).toHaveLength(1);
    });
  });
});
