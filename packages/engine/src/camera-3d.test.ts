import { describe, expect, it } from "vitest";
import { applyToPoint } from "./affine.js";
import { evaluateFrame, MAX_FRAME_MOTION_TRANSFORMS } from "./evaluate.js";
import {
  composition,
  deepFreeze,
  layer,
  type Obj,
  project,
  prop,
  solid,
  transform,
} from "./fixtures.test-util.js";
import {
  affineToProjective,
  type Projective,
  projectiveDepth,
  projectPoint,
} from "./projective.js";
import type { ResolvedLayer } from "./resolved.js";

const ZOOM = (1920 * 50) / 36;
const linear = { type: "linear" };
const kf = (frame: number, value: unknown) => ({ frame, value, interpolation: linear });

/** A 3D solid; `t` overrides transform tracks. Origin-anchored, so layer (0, 0) sits at `position`. */
const three = (id: string, t: Obj = {}, extra: Obj = {}) =>
  solid(id, { threeD: true, transform: transform(t), ...extra });

/** A camera that frames a 1920x1080 composition like the default one. */
const camera = (id: string, t: Obj = {}, extra: Obj = {}) =>
  layer(id, "null", {
    type: "camera",
    zoom: prop(ZOOM),
    pointOfInterest: null,
    transform: transform({ position: prop([960, 540]), positionZ: prop(-ZOOM), ...t }),
    ...extra,
  });

const evaluate = (layers: Obj[], frame = 10, extra: Obj[] = []) =>
  evaluateFrame(project([composition("main", layers), ...extra]), frame);
const pick = (layers: Obj[], id: string, frame = 10): ResolvedLayer => {
  const found = evaluate(layers, frame).layers.find((l) => l.id === id);
  if (found === undefined) throw new Error(`layer ${id} not resolved`);
  return found;
};
const proj = (l: ResolvedLayer): Projective => {
  if (l.projection === null) throw new Error(`layer ${l.id} has no projection`);
  return l.projection;
};
const at = (l: ResolvedLayer, x = 0, y = 0) => projectPoint(proj(l), [x, y]);

const close = (a: readonly number[], b: readonly number[], digits = 9) => {
  expect(a).toHaveLength(b.length);
  a.forEach((v, i) => {
    expect(v).toBeCloseTo(b[i] as number, digits);
  });
};

describe("3D layers with the default camera", () => {
  it("a flat 3D layer projects to the same pixels as its 2D matrix, with W = zoom", () => {
    const t = {
      anchorPoint: prop([10, 20]),
      position: prop([300, 200]),
      scale: prop([2, 1.5]),
      rotation: prop(20),
      skew: prop(10),
    };
    const flat = pick([solid("a", { transform: transform(t) })], "a");
    const deep = pick([three("a", t)], "a");
    expect(flat.projection).toBeNull();
    const p = proj(deep);
    expect(projectiveDepth(p, [0, 0])).toBeCloseTo(ZOOM, 9);
    const expected = affineToProjective(flat.matrix);
    // W is zoom everywhere on the plane; dividing the entries by it gives the 2D matrix.
    const normalized = p.map((v) => v / projectiveDepth(p, [0, 0]));
    expected.forEach((v, i) => {
      if (i === 6 || i === 7) expect(normalized[i]).toBeCloseTo(0, 9);
      else expect(normalized[i]).toBeCloseTo(v, 9);
    });
    close(at(deep, 7, 9), applyToPoint(flat.matrix, [7, 9]));
  });

  it("the resolved matrix is exact at the anchor point and matches the 2D matrix when flat", () => {
    const t = { anchorPoint: prop([50, 50]), position: prop([960, 540]), rotation: prop(30) };
    const flat = pick([solid("a", { transform: transform(t) })], "a");
    const deep = pick([three("a", t)], "a");
    close(deep.matrix, flat.matrix, 9);
  });

  it("is deterministic: evaluating twice gives deep-equal output", () => {
    const doc = project([
      composition("main", [
        three("a", { rotationY: prop(25), positionZ: prop(300) }, { motionBlur: blur() }),
        camera("cam", { position: { keyframes: [kf(0, [960, 540]), kf(20, [1200, 540])] } }),
        solid("flat"),
      ]),
    ]);
    deepFreeze(doc);
    expect(evaluateFrame(doc, 7)).toEqual(evaluateFrame(doc, 7));
  });
});

const blur = (rest: Obj = {}) => ({ shutterAngle: 180, shutterPhase: -90, samples: 2, ...rest });

describe("X and Y rotation", () => {
  const centered = { anchorPoint: prop([50, 50]), position: prop([960, 540]) };

  it("positive rotationX tilts the top edge away from the camera (greater depth)", () => {
    const l = pick([three("a", { ...centered, rotationX: prop(30) })], "a");
    const top = projectiveDepth(proj(l), [50, 0]);
    const bottom = projectiveDepth(proj(l), [50, 100]);
    expect(top).toBeGreaterThan(ZOOM);
    expect(bottom).toBeLessThan(ZOOM);
    // The vertical middle stays on the screen center line, the near edge draws bigger.
    close(at(l, 50, 50), [960, 540]);
    const nearHeight = at(l, 0, 100)[0] - 960;
    const farWidth = 960 - at(l, 0, 0)[0];
    expect(Math.abs(nearHeight)).toBeGreaterThan(Math.abs(farWidth));
  });

  it("positive rotationY turns the right edge away from the camera", () => {
    const l = pick([three("a", { ...centered, rotationY: prop(30) })], "a");
    const right = projectiveDepth(proj(l), [100, 50]);
    const left = projectiveDepth(proj(l), [0, 50]);
    expect(right).toBeGreaterThan(ZOOM);
    expect(left).toBeLessThan(ZOOM);
    close(at(l, 50, 50), [960, 540]);
  });

  it("rotationX 180 shows the layer upside down at the same depth", () => {
    const l = pick([three("a", { ...centered, rotationX: prop(180) })], "a");
    close(at(l, 50, 0), [960, 540 + 50]);
    expect(projectiveDepth(proj(l), [50, 0])).toBeCloseTo(ZOOM, 9);
  });

  it("rotation (Z) still turns clockwise on screen, inside the X/Y rotations", () => {
    const l = pick([three("a", { ...centered, rotation: prop(90) })], "a");
    close(at(l, 100, 50), [960, 540 + 50]);
  });
});

describe("cameras", () => {
  it("are not drawn: neither in layers nor with a projection", () => {
    const out = evaluate([camera("cam"), three("a")]);
    expect(out.layers.map((l) => l.id)).toEqual(["a"]);
  });

  it("a layer at positionZ = +zoom appears half size about the center", () => {
    const l = pick(
      [three("a", { position: prop([960, 540]), positionZ: prop(ZOOM) }), camera("cam")],
      "a",
    );
    close(at(l, 0, 0), [960, 540]);
    close(at(l, 100, 0), [960 + 50, 540]);
    expect(projectiveDepth(proj(l), [0, 0])).toBeCloseTo(2 * ZOOM, 9);
  });

  it("a layer at positionZ = -zoom/2 appears twice as big", () => {
    const l = pick(
      [three("a", { position: prop([960, 540]), positionZ: prop(-ZOOM / 2) }), camera("cam")],
      "a",
    );
    close(at(l, 100, 0), [960 + 200, 540]);
  });

  it("a camera moved along x shifts the layer the opposite way", () => {
    const t = { position: prop([500, 300]) };
    const base = at(pick([three("a", t)], "a"));
    const moved = at(pick([three("a", t), camera("cam", { position: prop([1060, 540]) })], "a"));
    close(base, [500, 300]);
    close(moved, [400, 300]);
  });

  it("zoom changes the field of view: a longer lens magnifies about the center", () => {
    const l = pick(
      [three("a", { position: prop([960, 540]) }), camera("cam", {}, { zoom: prop(ZOOM * 2) })],
      "a",
    );
    // The camera still sits at -ZOOM, so depth is ZOOM and the lens doubles the magnification.
    close(at(l, 100, 0), [960 + 200, 540]);
  });

  it("keyframed zoom is sampled at the camera's own layer time", () => {
    const cam = camera(
      "cam",
      {},
      { zoom: { keyframes: [kf(0, ZOOM), kf(10, ZOOM * 2)] }, startFrame: 0 },
    );
    const l = pick([three("a", { position: prop([960, 540]) }), cam], "a", 10);
    close(at(l, 100, 0), [960 + 200, 540]);
  });

  it("the point of interest lands at the screen center from any camera position", () => {
    const l = pick(
      [
        three("a", { position: prop([960, 540]) }),
        camera(
          "cam",
          { position: prop([200, 100]), positionZ: prop(-1500) },
          { pointOfInterest: prop([960, 540, 0]) },
        ),
      ],
      "a",
    );
    close(at(l, 0, 0), [960, 540], 6);
    // Looking at it from the left, the layer's right edge recedes.
    expect(projectiveDepth(proj(l), [100, 0])).toBeGreaterThan(projectiveDepth(proj(l), [0, 0]));
  });

  it("a point of interest straight ahead leaves the default view unchanged", () => {
    const ahead = at(
      pick(
        [
          three("a", { position: prop([300, 200]) }),
          camera("cam", {}, { pointOfInterest: prop([960, 540, 0]) }),
        ],
        "a",
      ),
      40,
      50,
    );
    const plain = at(pick([three("a", { position: prop([300, 200]) })], "a"), 40, 50);
    close(ahead, plain, 6);
  });

  it("a point of interest straight below the camera (parallel to +y) is still defined", () => {
    const l = pick(
      [
        three("a", { position: prop([960, 540]) }),
        camera(
          "cam",
          { position: prop([960, -1000]), positionZ: prop(0) },
          { pointOfInterest: prop([960, 540, 0]) },
        ),
      ],
      "a",
    );
    expect(proj(l).every(Number.isFinite)).toBe(true);
    close(at(l, 0, 0), [960, 540], 6);
  });

  it("a point of interest at the camera position is the identity (zero direction)", () => {
    const l = pick(
      [
        three("a", { position: prop([300, 200]) }),
        camera("cam", {}, { pointOfInterest: prop([960, 540, -ZOOM]) }),
      ],
      "a",
    );
    const plain = pick([three("a", { position: prop([300, 200]) })], "a");
    close(proj(l), proj(plain), 6);
  });

  it("the topmost active camera wins; hidden and out-of-range ones are skipped; solo is ignored", () => {
    const l = three("a", { position: prop([500, 300]) });
    const top = camera("top", { position: prop([1060, 540]) });
    const below = camera("below", { position: prop([1260, 540]) });
    const x = (layers: Obj[]) => at(pick(layers, "a"))[0];
    expect(x([l, top, below])).toBeCloseTo(400, 6);
    expect(x([l, { ...top, hidden: true }, below])).toBeCloseTo(200, 6);
    expect(x([l, { ...top, inFrame: 0, outFrame: 5 }, below])).toBeCloseTo(200, 6);
    expect(x([l, { ...top, inFrame: 11, outFrame: 20 }, below])).toBeCloseTo(200, 6);
    expect(x([l, { ...top, hidden: true }, { ...below, hidden: true }])).toBeCloseTo(500, 6);
    // Solo on another layer does not switch the camera off.
    expect(x([{ ...l, solo: true }, top, below])).toBeCloseTo(400, 6);
  });

  it("a camera parented to a null follows the null", () => {
    const rig = layer("rig", "null", { transform: transform({ position: prop([100, 0]) }) });
    const cam = camera("cam", { position: prop([960, 540]) }, { parent: "rig" });
    const l = pick([three("a", { position: prop([500, 300]) }), cam, rig], "a");
    close(at(l), [400, 300], 6);
  });
});

describe("parent chains", () => {
  it("a 2D null parent drives a 3D child like a 2D parent drives a 2D child", () => {
    const parent = layer("p", "null", {
      transform: transform({ position: prop([100, 50]), rotation: prop(90), positionZ: prop(800) }),
    });
    const t = { position: prop([10, 20]) };
    const flatChild = pick([solid("c", { parent: "p", transform: transform(t) }), parent], "c");
    const deepChild = pick([three("c", t, { parent: "p" }), parent], "c");
    close(at(deepChild, 3, 4), applyToPoint(flatChild.matrix, [3, 4]), 6);
    expect(projectiveDepth(proj(deepChild), [3, 4])).toBeCloseTo(ZOOM, 6);
  });

  it("a 3D null parent with positionZ moves a 3D child", () => {
    const parent = layer("p", "null", {
      threeD: true,
      transform: transform({ position: prop([960, 540]), positionZ: prop(ZOOM) }),
    });
    const child = three("c", {}, { parent: "p" });
    const l = pick([child, parent], "c");
    close(at(l, 100, 0), [960 + 50, 540], 6);
  });

  it("a 3D null parent's rotationY turns its child's plane", () => {
    const parent = layer("p", "null", {
      threeD: true,
      transform: transform({ position: prop([960, 540]), rotationY: prop(40) }),
    });
    const l = pick([three("c", {}, { parent: "p" }), parent], "c");
    expect(projectiveDepth(proj(l), [100, 0])).toBeGreaterThan(ZOOM);
  });

  it("a 2D child of a 3D parent is unaffected by the parent's 3D switch and Z properties", () => {
    const t = { position: prop([100, 50]), rotation: prop(15) };
    const parentWith = (threeD: boolean, z: Obj) =>
      layer("p", "null", {
        threeD,
        transform: transform({ ...t, ...z }),
      });
    const child = solid("c", { parent: "p", transform: transform({ position: prop([5, 6]) }) });
    const off = pick([child, parentWith(false, {})], "c");
    const on = pick([child, parentWith(true, {})], "c");
    const onZ = pick(
      [child, parentWith(true, { positionZ: prop(500), rotationX: prop(40), rotationY: prop(30) })],
      "c",
    );
    expect(on).toEqual(off);
    expect(onZ).toEqual(off);
    expect(onZ.projection).toBeNull();
  });

  it("a 2D layer ignores its own Z properties", () => {
    const plain = pick([solid("a")], "a");
    const z = pick(
      [
        solid("a", {
          transform: transform({
            positionZ: prop(500),
            rotationX: prop(40),
            rotationY: prop(30),
          }),
        }),
      ],
      "a",
    );
    expect(z.matrix).toEqual(plain.matrix);
    expect(z.projection).toBeNull();
  });
});

describe("resolved matrix of a 3D layer", () => {
  it("is the first-order approximation of the projection at the anchor", () => {
    const l = pick(
      [
        three("a", {
          anchorPoint: prop([50, 50]),
          position: prop([700, 300]),
          rotationY: prop(35),
          rotationX: prop(-10),
        }),
      ],
      "a",
    );
    close(applyToPoint(l.matrix, [50, 50]), at(l, 50, 50), 9);
    close(applyToPoint(l.matrix, [50.001, 50]), at(l, 50.001, 50), 4);
  });

  it("falls back to the 2D world matrix when the anchor is behind the camera", () => {
    const t = { position: prop([100, 100]), positionZ: prop(-ZOOM * 2) };
    const l = pick([three("a", t)], "a");
    expect(projectiveDepth(proj(l), [0, 0])).toBeLessThan(0);
    const flat = pick([solid("a", { transform: transform(t) })], "a");
    expect(l.matrix).toEqual(flat.matrix);
  });
});

describe("depth sorting", () => {
  const ids = (layers: Obj[], extra: Obj[] = []) =>
    evaluate(layers, 10, extra).layers.map((l) => l.id);
  const z = (v: number) => ({ positionZ: prop(v) });

  it("sorts a run of 3D layers nearest first, whatever their order in the document", () => {
    expect(ids([three("far", z(100)), three("near", z(-100)), three("mid", z(0))])).toEqual([
      "near",
      "mid",
      "far",
    ]);
  });

  it("keeps document order on equal depth", () => {
    expect(ids([three("a", z(0)), three("b", z(0)), three("c", z(0))])).toEqual(["a", "b", "c"]);
    expect(ids([three("a", z(5)), three("b", z(5)), three("c", z(-5)), three("d", z(5))])).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("a 2D layer splits two runs, each sorted alone", () => {
    expect(
      ids([
        three("a", z(100)),
        three("b", z(-100)),
        solid("flat"),
        three("c", z(100)),
        three("d", z(-100)),
      ]),
    ).toEqual(["b", "a", "flat", "d", "c"]);
  });

  it("an adjustment layer ends a run", () => {
    expect(
      ids([
        three("a", z(100)),
        three("b", z(-100)),
        layer("adj", "adjustment", { effects: [], motionBlur: null }),
        three("c", z(100)),
        three("d", z(-100)),
      ]),
    ).toEqual(["b", "a", "adj", "d", "c"]);
  });

  it("cameras, null layers and hidden layers do not split a run", () => {
    expect(
      ids([
        three("a", z(100)),
        camera("cam"),
        layer("n", "null"),
        { ...three("hidden", z(0)), hidden: true },
        three("b", z(-100)),
      ]),
    ).toEqual(["b", "a"]);
  });

  it("sorts by depth through the active camera, not by positionZ alone", () => {
    // The camera sits behind the layers at z = 500, looking back: the larger positionZ is nearer.
    const cam = camera("cam", { positionZ: prop(500), rotationY: prop(180) });
    expect(ids([three("a", z(-100)), three("b", z(100)), cam])).toEqual(["b", "a"]);
  });

  it("sorts by the anchor point's depth", () => {
    const tilted = three("tilt", {
      anchorPoint: prop([0, 0]),
      rotationY: prop(60),
      positionZ: prop(0),
    });
    const flatDeep = three("deep", z(10));
    // Same anchor depth order as positionZ: the tilted layer's anchor is at z = 0, nearer than 10.
    expect(ids([flatDeep, tilted])).toEqual(["tilt", "deep"]);
  });

  it("mattes stay linked by id after sorting", () => {
    const m = three("m", z(100));
    const t = three("t", z(-100), { matte: { layerId: "m", mode: "alpha" } });
    const out = evaluate([m, t]).layers;
    expect(out.map((l) => l.id)).toEqual(["t", "m"]);
    expect(out[0]?.matte?.layerId).toBe("m");
  });
});

describe("nested compositions", () => {
  it("a precomp is a flat card: the parent's camera does not reach its contents", () => {
    const inner = composition("inner", [three("inside", { position: prop([300, 200]) })], {
      width: 1920,
      height: 1080,
    });
    const precomp = layer("pre", "precomp", { compositionId: "inner" });
    const outerCam = camera("cam", { position: prop([1560, 540]) });
    const out = evaluate([precomp, outerCam], 10, [inner]);
    const nested = (out.layers[0] as Extract<ResolvedLayer, { type: "precomp" }>).composition;
    const inside = nested?.layers[0] as ResolvedLayer;
    close(at(inside), [300, 200], 6);
    expect(out.layers[0]?.projection).toBeNull();
  });

  it("a camera inside a precomp does not move the parent's 3D layers", () => {
    const inner = composition("inner", [
      camera("inner-cam", { position: prop([1560, 540]) }),
      three("inside", { position: prop([300, 200]) }),
    ]);
    const precomp = layer("pre", "precomp", { compositionId: "inner" });
    const out = evaluate([three("outside", { position: prop([500, 300]) }), precomp], 10, [inner]);
    close(at(out.layers[0] as ResolvedLayer), [500, 300], 6);
    const nested = (out.layers[1] as Extract<ResolvedLayer, { type: "precomp" }>).composition;
    close(at(nested?.layers[0] as ResolvedLayer), [-300, 200], 6);
  });
});

describe("motion blur with 3D", () => {
  const camMoving = camera("cam", {
    position: { keyframes: [kf(0, [960, 540]), kf(10, [1060, 540])] },
  });

  it("each sample carries a projection, and samples the camera's motion too", () => {
    const l = pick(
      [three("a", { position: prop([500, 300]) }, { motionBlur: blur() }), camMoving],
      "a",
      5,
    );
    expect(l.motion).toHaveLength(2);
    const [s0, s1] = l.motion ?? [];
    // Camera x at 4.875 and 5.125 is 960 + 48.75 and 960 + 51.25; the layer moves opposite.
    close(projectPoint(s0?.projection as Projective, [0, 0]), [451.25, 300], 6);
    close(projectPoint(s1?.projection as Projective, [0, 0]), [448.75, 300], 6);
    close(
      applyToPoint((s0 as { matrix: readonly number[] }).matrix as never, [0, 0]),
      [451.25, 300],
      6,
    );
    close(at(l), [450, 300], 6);
  });

  it("a layer's own motion blurs too, and a 2D layer's samples have no projection", () => {
    const moving = { position: { keyframes: [kf(0, [0, 0]), kf(10, [100, 0])] } };
    const l = pick([three("a", moving, { motionBlur: blur() })], "a", 5);
    const xs = (l.motion ?? []).map((s) => projectPoint(s.projection as Projective, [0, 0])[0]);
    expect(xs[0]).toBeCloseTo(48.75, 6);
    expect(xs[1]).toBeCloseTo(51.25, 6);
    const flat = pick([solid("f", { transform: transform(moving), motionBlur: blur() })], "f", 5);
    for (const s of flat.motion ?? []) expect(s.projection).toBeNull();
  });

  it("charges the camera's parent chain against the motion transform budget", () => {
    const count = 990;
    const rig = Array.from({ length: count }, (_, i) =>
      layer(`r${i}`, "null", { parent: i === 0 ? null : `r${i - 1}` }),
    );
    // Two blurred layers with different shutters sample at different times, so the chain is walked twice.
    const a = three("a", {}, { motionBlur: blur({ samples: 64 }) });
    const b = three("b", {}, { motionBlur: blur({ samples: 64, shutterPhase: 0 }) });
    expect(MAX_FRAME_MOTION_TRANSFORMS).toBeLessThan(2 * count * 64);
    const cam = camera("cam", {}, { parent: `r${count - 1}` });
    expect(() => evaluate([a, b, cam, ...rig])).toThrow(/motion blur transform samples/);
    // Without the long chain the same layers are far inside the budget.
    expect(() => evaluate([a, b, camera("cam"), ...rig.slice(0, 5)])).not.toThrow();
  });
});

describe("non-finite 3D transforms", () => {
  it("throws a RangeError naming the layer", () => {
    expect(() => evaluate([three("far", { positionZ: prop(1e308) })])).toThrow(RangeError);
    expect(() => evaluate([three("far", { positionZ: prop(1e308) })])).toThrow(
      "the 3D transform of layer 'far' is not finite; check positionZ, rotations and the camera zoom",
    );
  });
});

describe("behaviors on the new properties", () => {
  it("an oscillate on positionZ moves a 3D layer, a link follows another layer's positionZ", () => {
    const wiggle = {
      id: "w",
      name: "w",
      enabled: true,
      type: "oscillate",
      property: "positionZ",
      frequency: prop(1),
      amplitude: prop(100),
      phase: 90,
      waveform: "sine",
    };
    const a = three("a", {}, { behaviors: [wiggle] });
    expect(projectiveDepth(proj(pick([a], "a", 0)), [0, 0])).toBeCloseTo(ZOOM + 100, 6);
    const link = {
      id: "l",
      name: "l",
      enabled: true,
      type: "link",
      property: "positionZ",
      source: { layer: "a", property: "positionZ" },
      multiply: 2,
      offset: 0,
      delay: 0,
    };
    const b = three("b", {}, { behaviors: [link] });
    expect(projectiveDepth(proj(pick([a, b], "b", 0)), [0, 0])).toBeCloseTo(ZOOM + 200, 6);
  });
});
