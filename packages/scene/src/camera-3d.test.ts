import { describe, expect, it } from "vitest";
import {
  common,
  composition,
  issues,
  nullLayer,
  type Obj,
  project,
  prop,
  visual,
} from "./fixtures.test-util.js";
import {
  applyOps,
  BehaviorPropertySchema,
  LayerPatchSchema,
  OpSchema,
  type Project,
  ProjectSchema,
  TRANSFORM_PROPERTIES,
  TransformSchema,
  VECTOR_TRANSFORM_PROPERTIES,
  withLayerDefaults,
} from "./index.js";
import { solid } from "./ops.test-util.js";

const camera = (id: string, extra: Obj = {}): Obj => {
  const { blendMode, matte, masks, threeD, ...rest } = visual(id);
  void blendMode;
  void matte;
  void masks;
  void threeD;
  return { ...rest, type: "camera", zoom: prop(1777.8), pointOfInterest: null, ...extra };
};

const doc = (layers: Obj[], extra: Obj = {}): Project =>
  ProjectSchema.parse(project({ compositions: [composition("main", layers)], ...extra }));

describe("3D transform tracks", () => {
  it("list the new properties in order, as scalar properties", () => {
    expect(TRANSFORM_PROPERTIES).toEqual([
      "anchorPoint",
      "position",
      "positionZ",
      "scale",
      "rotation",
      "rotationX",
      "rotationY",
      "skew",
      "opacity",
    ]);
    for (const p of ["positionZ", "rotationX", "rotationY"]) {
      expect(VECTOR_TRANSFORM_PROPERTIES as readonly string[]).not.toContain(p);
      expect(BehaviorPropertySchema.safeParse(p).success).toBe(true);
    }
  });

  it("default to 0 when an older addLayer transform omits them", () => {
    const { positionZ, rotationX, rotationY, ...old } = visual("x").transform as Obj;
    void positionZ;
    void rotationX;
    void rotationY;
    expect(TransformSchema.parse(old)).toMatchObject({
      positionZ: { value: 0 },
      rotationX: { value: 0 },
      rotationY: { value: 0 },
    });
  });

  it("are kept on a 2D layer without an issue", () => {
    const layer = {
      ...nullLayer("n"),
      transform: {
        ...(nullLayer("n").transform as Obj),
        positionZ: prop(500),
        rotationX: prop(30),
        rotationY: prop(-30),
      },
    };
    expect(issues(project({ compositions: [composition("main", [layer])] }))).toEqual([]);
  });

  it("reject non-finite values", () => {
    for (const track of ["positionZ", "rotationX", "rotationY"])
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const layer = {
          ...nullLayer("n"),
          transform: { ...(nullLayer("n").transform as Obj), [track]: prop(bad) },
        };
        expect(
          issues(project({ compositions: [composition("main", [layer])] })).map((i) => i.path),
        ).toEqual([`compositions.0.layers.0.transform.${track}.value`]);
      }
  });

  it("take keyframes through setTransformTrack and behaviors through addBehavior", () => {
    const d = doc([solid("s")]);
    const keyframes = [
      { frame: 0, value: 0, interpolation: { type: "linear" } },
      { frame: 30, value: 400, interpolation: { type: "linear" } },
    ];
    const r = applyOps(d, [
      { op: "setTransformTrack", layer: "s", property: "positionZ", track: { keyframes } },
      { op: "updateLayer", layer: "s", set: { threeD: true } },
      {
        op: "addBehavior",
        layer: "s",
        id: "w",
        behavior: {
          name: "Wobble",
          enabled: true,
          type: "wiggle",
          property: "rotationY",
          frequency: { value: 2 },
          amplitude: { value: 10 },
          octaves: 1,
          seed: 1,
          linked: false,
        },
      },
    ] as never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const layer = r.doc.compositions[0]?.layers[0];
    expect(layer).toMatchObject({
      threeD: true,
      transform: { positionZ: { keyframes } },
      behaviors: [{ id: "w", property: "rotationY" }],
    });
  });

  it("a keyframed vector amplitude on a scalar 3D property is refused", () => {
    const r = applyOps(doc([solid("s")]), [
      {
        op: "addBehavior",
        layer: "s",
        id: "w",
        behavior: {
          name: "W",
          enabled: true,
          type: "oscillate",
          property: "positionZ",
          frequency: { value: 1 },
          amplitude: { value: [1, 2] },
          phase: 0,
          waveform: "sine",
        },
      },
    ] as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.message).toContain("positionZ");
  });
});

describe("threeD", () => {
  it("defaults to false on visual layers written without it, null layers included", () => {
    const { threeD, ...bare } = visual("s");
    void threeD;
    const d = doc([
      { ...bare, type: "solid", width: 8, height: 8, color: "#ffffff" },
      nullLayer("n"),
    ]);
    expect(d.compositions[0]?.layers[0]).toMatchObject({ threeD: false });
    expect(d.compositions[0]?.layers[1]).toMatchObject({ threeD: false });
  });

  it("rejects an adjustment layer with threeD: true, at threeD", () => {
    const found = issues(
      project({
        compositions: [
          composition("main", [
            { ...visual("a"), type: "adjustment", effects: [], motionBlur: null, threeD: true },
          ]),
        ],
      }),
    );
    expect(found).toEqual([
      {
        path: "compositions.0.layers.0.threeD",
        message: "adjustment layers cannot be 3D; set threeD to false",
      },
    ]);
  });
});

describe("camera layers", () => {
  it("validates, with no threeD, blend mode, matte, masks, effects or motion blur", () => {
    const d = doc([camera("cam")]);
    const layer = d.compositions[0]?.layers[0];
    expect(layer).toMatchObject({ type: "camera", zoom: { value: 1777.8 }, pointOfInterest: null });
    for (const key of ["threeD", "blendMode", "matte", "masks", "effects", "motionBlur"])
      expect(layer).not.toHaveProperty(key);
  });

  it("rejects fields a camera lacks", () => {
    for (const extra of [{ threeD: true }, { blendMode: "normal" }, { masks: [] }, { effects: [] }])
      expect(
        issues(project({ compositions: [composition("main", [camera("c", extra)])] })),
      ).not.toEqual([]);
  });

  it.each([
    ["zoom 0.5", { zoom: prop(0.5) }],
    ["zoom 100001", { zoom: prop(100_001) }],
    ["zoom NaN", { zoom: prop(Number.NaN) }],
    ["zoom Infinity", { zoom: prop(Number.POSITIVE_INFINITY) }],
    ["poi NaN", { pointOfInterest: prop([0, Number.NaN, 0]) }],
    ["poi Infinity", { pointOfInterest: prop([0, 0, Number.POSITIVE_INFINITY]) }],
    ["poi of two numbers", { pointOfInterest: prop([0, 0]) }],
  ])("rejects %s", (_n, extra) => {
    expect(
      issues(project({ compositions: [composition("main", [camera("c", extra)])] })),
    ).not.toEqual([]);
  });

  it("accepts the zoom bounds, a point of interest and keyframed zoom", () => {
    for (const extra of [
      { zoom: prop(1) },
      { zoom: prop(100_000) },
      { pointOfInterest: prop([960, 540, 0]) },
      {
        zoom: {
          keyframes: [
            { frame: 0, value: 1000, interpolation: { type: "linear" } },
            { frame: 30, value: 2000, interpolation: { type: "linear" } },
          ],
        },
      },
    ])
      expect(
        issues(project({ compositions: [composition("main", [camera("c", extra)])] })),
      ).toEqual([]);
  });

  it("may be parented to a null, and a null to a camera is refused", () => {
    expect(
      issues(
        project({
          compositions: [composition("main", [camera("c", { parent: "n" }), nullLayer("n")])],
        }),
      ),
    ).toEqual([]);
  });

  it("refuses a layer parented to a camera, at parent", () => {
    const found = issues(
      project({
        compositions: [composition("main", [{ ...nullLayer("n", "c") }, camera("c")])],
      }),
    );
    expect(found).toEqual([
      {
        path: "compositions.0.layers.0.parent",
        message:
          "cameras cannot be parents; parent the layer to a null and the camera to the same null instead",
      },
    ]);
  });

  it("cannot be a track matte source", () => {
    const found = issues(
      project({
        compositions: [
          composition("main", [
            { ...solid("s"), matte: { layerId: "c", mode: "alpha" } },
            camera("c"),
          ]),
        ],
      }),
    );
    expect(found.map((f) => f.path)).toEqual(["compositions.0.layers.0.matte.layerId"]);
  });

  it("can be targeted by selector type and carries behaviors", () => {
    const d = doc([camera("c")]);
    const r = applyOps(d, [
      {
        op: "setTransformTrack",
        layer: { type: "camera" },
        property: "positionZ",
        track: prop(-900),
      },
    ] as never);
    expect(r.ok && r.doc.compositions[0]?.layers[0]).toMatchObject({
      transform: { positionZ: { value: -900 } },
    });
  });
});

describe("withLayerDefaults for cameras", () => {
  const comp = ProjectSchema.parse(project()).compositions[0];

  it("frames the composition with a 50 mm lens: position, positionZ = -zoom, point of interest", () => {
    const filled = withLayerDefaults({ type: "camera", name: "Camera" }, comp) as Obj;
    expect(filled).toMatchObject({
      zoom: { value: 2666.7 },
      pointOfInterest: { value: [960, 540, 0] },
      transform: { position: { value: [960, 540] }, positionZ: { value: -2666.7 } },
    });
    expect(filled).not.toHaveProperty("blendMode");
    expect(filled).not.toHaveProperty("masks");
    const r = applyOps(ProjectSchema.parse(project()), [
      { op: "addLayer", composition: "main", layer: filled },
    ] as never);
    expect(r.ok).toBe(true);
  });

  it("uses a given constant zoom for positionZ and leaves a given point of interest", () => {
    const filled = withLayerDefaults(
      { type: "camera", name: "C", zoom: { value: 1000 }, pointOfInterest: null },
      comp,
    ) as Obj;
    expect(filled).toMatchObject({ zoom: { value: 1000 }, pointOfInterest: null });
    expect(filled.transform).toMatchObject({ positionZ: { value: -1000 } });
  });

  it("gives other layers the zero Z tracks", () => {
    const filled = withLayerDefaults({ type: "null", name: "N" }, comp) as Obj;
    expect(filled.transform).toMatchObject({
      positionZ: { value: 0 },
      rotationX: { value: 0 },
      rotationY: { value: 0 },
    });
  });
});

describe("updateLayer 3D fields", () => {
  const withTypes = () =>
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
            solid("s"),
            nullLayer("n"),
            { ...visual("a"), type: "adjustment", effects: [], motionBlur: null },
            camera("c"),
            { ...common("snd"), type: "audio", assetId: "m", volume: prop(1) },
          ]),
        ],
      }),
    );
  const run = (layer: string, set: Obj) =>
    applyOps(withTypes(), [{ op: "updateLayer", layer, set } as never]);
  const fails = (layer: string, set: Obj, key: string, message: string) => {
    const r = run(layer, set);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ path: ["ops", 0, "set", key], message }]);
  };

  it("turns threeD on and off for drawn and null layers", () => {
    for (const id of ["s", "n"]) {
      const on = run(id, { threeD: true });
      expect(on.ok).toBe(true);
      if (!on.ok) continue;
      expect(on.doc.compositions[0]?.layers.find((l) => l.id === id)).toMatchObject({
        threeD: true,
      });
    }
  });

  it("fails threeD on a camera", () =>
    fails("c", { threeD: true }, "threeD", "layer 'c' is a camera: camera layers are always 3D"));
  it("fails threeD on an audio layer", () =>
    fails(
      "snd",
      { threeD: false },
      "threeD",
      "layer 'snd' is an audio layer and has no transform, so no threeD",
    ));
  it("fails threeD: true on an adjustment layer, accepts false", () => {
    fails("a", { threeD: true }, "threeD", "adjustment layers cannot be 3D; set threeD to false");
    expect(run("a", { threeD: false }).ok).toBe(true);
  });

  it("sets zoom and pointOfInterest on a camera", () => {
    const r = run("c", { zoom: { value: 1200 }, pointOfInterest: { value: [1, 2, 3] } });
    expect(r.ok && r.doc.compositions[0]?.layers[3]).toMatchObject({
      zoom: { value: 1200 },
      pointOfInterest: { value: [1, 2, 3] },
    });
    const off = run("c", { pointOfInterest: null });
    expect(off.ok && off.doc.compositions[0]?.layers[3]).toMatchObject({ pointOfInterest: null });
  });

  it.each([
    ["s", "a solid"],
    ["n", "a null"],
    ["a", "an adjustment"],
    ["snd", "an audio"],
  ])("fails zoom and pointOfInterest on %s with a pathed error", (id, what) => {
    for (const key of ["zoom", "pointOfInterest"])
      fails(
        id,
        { [key]: key === "zoom" ? { value: 1000 } : null },
        key,
        `layer '${id}' is ${what} layer; only camera layers have ${key}`,
      );
  });

  it("never reaches an internal error for any patch field on any layer type", () => {
    const patches: Obj[] = [
      { name: "x" },
      { hidden: true },
      { solo: true },
      { inFrame: 1 },
      { outFrame: 10 },
      { startFrame: 1 },
      { motionBlur: {} },
      { motionBlur: null },
      { threeD: true },
      { threeD: false },
      { zoom: { value: 1000 } },
      { pointOfInterest: null },
    ];
    for (const id of ["s", "n", "a", "c", "snd"])
      for (const set of patches) {
        const r = run(id, set);
        if (!r.ok)
          for (const e of r.errors) {
            expect(e.message).not.toMatch(/internal/i);
            expect(e.path.slice(0, 3)).toEqual(["ops", 0, "set"]);
          }
      }
  });

  it("LayerPatchSchema accepts the new fields", () => {
    expect(LayerPatchSchema.safeParse({ threeD: true }).success).toBe(true);
    expect(LayerPatchSchema.safeParse({ zoom: { value: 0.5 } }).success).toBe(false);
    expect(LayerPatchSchema.safeParse({ pointOfInterest: { value: [0, 0] } }).success).toBe(false);
  });

  it("addLayer of a camera and masks on one fail cleanly", () => {
    const r = applyOps(withTypes(), [{ op: "addMask", layer: "c", mask: {} }] as never);
    expect(r.ok).toBe(false);
    expect(OpSchema.safeParse({ op: "setEffects", layer: "c", effects: [] }).success).toBe(true);
    const e = applyOps(withTypes(), [{ op: "setEffects", layer: "c", effects: [] }] as never);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.errors[0]?.message).toContain("is a camera layer");
  });
});
