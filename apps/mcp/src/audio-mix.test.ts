import { evaluateFrame } from "@kynimo/engine";
import { type Project, ProjectSchema, SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { frameSample, mixAudio, planAudio } from "./audio-mix.js";

type Obj = Record<string, unknown>;
const linear = { type: "linear" };
const kf = (frame: number, value: number) => ({ frame, value, interpolation: linear });

const audio = (id: string, o: Obj = {}): Obj => ({
  id,
  name: id,
  inFrame: 0,
  outFrame: 90,
  startFrame: 0,
  hidden: false,
  solo: false,
  editor: { locked: false, shy: false, label: null },
  markers: [],
  type: "audio",
  assetId: "song",
  volume: { value: 1 },
  ...o,
});
const precomp = (id: string, compositionId: string): Obj => ({
  id,
  name: id,
  inFrame: 0,
  outFrame: 90,
  startFrame: 0,
  hidden: false,
  solo: false,
  editor: { locked: false, shy: false, label: null },
  markers: [],
  type: "precomp",
  compositionId,
  parent: null,
  blendMode: "normal",
  matte: null,
  masks: [],
  transform: {
    anchorPoint: { value: [0, 0] },
    position: { value: [0, 0] },
    scale: { value: [1, 1] },
    rotation: { value: 0 },
    skew: { value: 0 },
    opacity: { value: 1 },
  },
});
const comp = (id: string, layers: Obj[], fps = { num: 30, den: 1 }): Obj => ({
  id,
  name: id,
  width: 64,
  height: 36,
  fps,
  durationFrames: 90,
  background: "#000000",
  layers,
  markers: [],
});
const project = (layers: Obj[], extra: Obj[] = [], fps = { num: 30, den: 1 }): Project =>
  ProjectSchema.parse({
    formatVersion: SCENE_FORMAT_VERSION,
    name: "T",
    mainCompositionId: "main",
    style: null,
    assets: ["song", "other"].map((id) => ({
      id,
      name: id,
      type: "audio",
      uri: `assets/${id}.flac`,
      sha256: "0".repeat(64),
      durationMs: 3000,
    })),
    compositions: [comp("main", layers, fps), ...extra],
  });

const ramp = (n: number, f: (i: number) => number) => {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[2 * i] = f(i);
    out[2 * i + 1] = 0 - f(i);
  }
  return out;
};
const FPS = { num: 30, den: 1 };
const SPF = 1600;

describe("frameSample", () => {
  it("counts whole samples per frame at integer rates", () => {
    expect(frameSample(0, FPS)).toBe(0);
    expect(frameSample(1, FPS)).toBe(1600);
    expect(frameSample(10, { num: 24, den: 1 })).toBe(20_000);
  });

  it("is exact for fractional rates", () => {
    const fps = { num: 30_000, den: 1001 };
    let sum = 0;
    for (let f = 0; f < 1001; f++) sum += frameSample(f + 1, fps) - frameSample(f, fps);
    expect(sum).toBe(frameSample(1001, fps));
    expect(frameSample(1001, fps)).toBe(Math.floor((48_000 * 1001 * 1001) / 30_000));
  });

  it("floors toward minus infinity for negative frames", () => {
    expect(frameSample(-1, FPS)).toBe(-1600);
    const fps = { num: 30_000, den: 1001 };
    expect(frameSample(-1, fps)).toBe(-Math.ceil((48_000 * 1001) / 30_000));
  });

  it("throws when the arithmetic would be inexact", () => {
    expect(() => frameSample(2 ** 40, { num: 30, den: 1 })).toThrow(RangeError);
  });
});

describe("planAudio", () => {
  it("lists active layers in order and nested audio separately", () => {
    const doc = project(
      [
        audio("a"),
        precomp("p", "inner"),
        audio("late", { inFrame: 50 }),
        audio("h", { hidden: true }),
      ],
      [comp("inner", [audio("deep", { assetId: "other" })])],
    );
    expect(planAudio(doc, "main", 0, 10)).toEqual({
      layers: [{ id: "a", assetId: "song" }],
      nested: [{ id: "deep", compositionId: "inner" }],
    });
    expect(planAudio(doc, "main", 40, 60).layers.map((l) => l.id)).toEqual(["a", "late"]);
  });

  it("de-duplicates precomps used twice", () => {
    const doc = project(
      [precomp("p1", "inner"), precomp("p2", "inner")],
      [comp("inner", [audio("deep")])],
    );
    expect(planAudio(doc, "main", 0, 10).nested).toHaveLength(1);
  });
});

describe("mixAudio", () => {
  const pcm = (n = 3 * SPF, f = (i: number) => (i % 1000) / 2000) =>
    new Map([["song", ramp(n, f)]]);

  it("copies source samples exactly at unity gain", () => {
    const src = pcm();
    const doc = project([audio("a")]);
    const r = mixAudio(doc, "main", 0, 2, src);
    expect(r.samples.length).toBe(2 * 3 * SPF);
    expect(Array.from(r.samples)).toEqual(Array.from(src.get("song") as Float32Array));
    expect(r.mixed).toEqual(["a"]);
    expect(r.clipped).toBe(0);
  });

  it("covers just the requested frames", () => {
    const src = pcm(10 * SPF);
    const r = mixAudio(project([audio("a")]), "main", 3, 4, src);
    expect(r.samples.length).toBe(2 * 2 * SPF);
    expect(r.samples[0]).toBe((src.get("song") as Float32Array)[2 * 3 * SPF]);
  });

  it("shifts by startFrame, positive and negative", () => {
    const src = pcm(10 * SPF, (i) => i / 100_000);
    const pos = mixAudio(project([audio("a", { startFrame: 2 })]), "main", 0, 3, src);
    expect(pos.samples[0]).toBe(0);
    expect(pos.samples[2 * 2 * SPF]).toBe(0);
    expect(pos.samples[2 * (2 * SPF + 5)]).toBe(Math.fround(5 / 100_000));
    const neg = mixAudio(project([audio("a", { startFrame: -2 })]), "main", 0, 1, src);
    expect(neg.samples[0]).toBe(Math.fround((2 * SPF) / 100_000));
  });

  it("gates by in and out frames", () => {
    const src = pcm(10 * SPF, () => 0.25);
    const r = mixAudio(project([audio("a", { inFrame: 1, outFrame: 2 })]), "main", 0, 2, src);
    const nonzero = (f: number) => r.samples[2 * f * SPF + 10] !== 0;
    expect([nonzero(0), nonzero(1), nonzero(2)]).toEqual([false, true, false]);
  });

  it("mutes hidden layers and applies the solo rule", () => {
    const src = pcm(3 * SPF, () => 0.25);
    const hidden = mixAudio(project([audio("a", { hidden: true })]), "main", 0, 1, src);
    expect(hidden.mixed).toEqual([]);
    expect(hidden.samples.every((v) => v === 0)).toBe(true);
    const solo = mixAudio(project([audio("a"), audio("b", { solo: true })]), "main", 0, 1, src);
    expect(solo.mixed).toEqual(["b"]);
    expect(solo.samples[0]).toBe(0.25);
  });

  it("ramps volume across a frame toward the next frame's value", () => {
    const src = pcm(4 * SPF, () => 1);
    const doc = project([audio("a", { volume: { keyframes: [kf(0, 0), kf(2, 1)] } })]);
    const r = mixAudio(doc, "main", 0, 1, src);
    // v(0)=0, v(1)=0.5, v(2)=1: frame 0 ramps 0 -> 0.5, frame 1 ramps 0.5 -> 1.
    expect(r.samples[0]).toBe(0);
    expect(r.samples[2 * (SPF / 2)]).toBeCloseTo(0.25, 6);
    expect(r.samples[2 * SPF]).toBeCloseTo(0.5, 6);
    expect(r.samples[2 * (SPF + SPF / 2)]).toBeCloseTo(0.75, 6);
  });

  it("holds the frame's volume when the layer is inactive on the next frame", () => {
    const src = pcm(4 * SPF, () => 1);
    const doc = project([
      audio("a", { outFrame: 1, volume: { keyframes: [kf(0, 0.5), kf(2, 1)] } }),
    ]);
    const r = mixAudio(doc, "main", 0, 0, src);
    expect(r.samples[2 * (SPF - 1)]).toBeCloseTo(0.5, 6);
  });

  it("sums layers in order", () => {
    const src = new Map([
      ["song", ramp(2 * SPF, () => 0.25)],
      ["other", ramp(2 * SPF, () => 0.5)],
    ]);
    const doc = project([audio("a"), audio("b", { assetId: "other", volume: { value: 0.5 } })]);
    const r = mixAudio(doc, "main", 0, 1, src);
    expect(r.samples[0]).toBe(0.5);
    expect(r.samples[1]).toBe(-0.5);
    expect(r.mixed).toEqual(["a", "b"]);
  });

  it("clamps and counts clipped values", () => {
    const src = pcm(SPF, () => 0.9);
    const doc = project([audio("a"), audio("b")]);
    const r = mixAudio(doc, "main", 0, 0, src);
    expect(r.clipped).toBe(2 * SPF);
    expect(r.samples[0]).toBe(1);
    expect(r.samples[1]).toBe(-1);
  });

  it("is silent after a source that is shorter than the range", () => {
    const src = pcm(SPF / 2, () => 0.5);
    const r = mixAudio(project([audio("a")]), "main", 0, 1, src);
    expect(r.samples[2 * (SPF / 2 - 1)]).toBe(0.5);
    expect(r.samples[2 * (SPF / 2)]).toBe(0);
    expect(r.samples[r.samples.length - 1]).toBe(0);
  });

  it("throws naming an asset with no decoded audio", () => {
    expect(() => mixAudio(project([audio("a")]), "main", 0, 1, new Map())).toThrow(/'song'/);
  });

  it("does not mix audio in nested precomps", () => {
    const doc = project([precomp("p", "inner")], [comp("inner", [audio("deep")])]);
    const r = mixAudio(doc, "main", 0, 1, new Map());
    expect(r.mixed).toEqual([]);
    expect(planAudio(doc, "main", 0, 1).nested).toEqual([{ id: "deep", compositionId: "inner" }]);
  });

  it("keeps frame boundaries exact at 30000/1001", () => {
    const fps = { num: 30_000, den: 1001 };
    const doc = project([audio("a")], [], fps);
    const n = frameSample(20, fps);
    const src = new Map([["song", ramp(n, (i) => (i % 97) / 200)]]);
    const r = mixAudio(doc, "main", 0, 19, src);
    expect(r.samples.length).toBe(2 * n);
    expect(Array.from(r.samples)).toEqual(Array.from(src.get("song") as Float32Array));
  });
});

describe("agreement with the engine", () => {
  const layers = [
    audio("plain", { volume: { keyframes: [kf(0, 0), kf(20, 2)] }, startFrame: 5 }),
    audio("windowed", { inFrame: 10, outFrame: 30, startFrame: -4, volume: { value: 0.3 } }),
    audio("muted", { hidden: true }),
  ];
  const variants: [string, Obj[]][] = [
    ["plain", layers],
    ["solo", layers.map((l) => (l.id === "windowed" ? { ...l, solo: true } : l))],
    ["hidden", layers.map((l) => (l.id === "windowed" ? { ...l, hidden: true } : l))],
  ];

  for (const [name, set] of variants) {
    it(`matches evaluateFrame audio (${name})`, () => {
      const doc = project(set);
      const src = new Map([["song", ramp(90 * SPF, () => 1)]]);
      for (const f of [0, 5, 9, 10, 15, 29, 30, 50]) {
        const expected = evaluateFrame(doc, f).audio;
        const plan = planAudio(doc, "main", f, f);
        expect(plan.layers.map((l) => l.id)).toEqual(expected.map((a) => a.id));
        // At the frame's first sample the mix is the sum of the engine's volumes times the source.
        const r = mixAudio(doc, "main", f, f, src);
        const first = frameSample(f, FPS);
        const sum = expected.reduce(
          (acc, a) => acc + (first - frameSample(f - a.layerFrame, FPS) < 0 ? 0 : a.volume),
          0,
        );
        expect(r.samples[0]).toBeCloseTo(Math.min(1, sum), 5);
      }
    });
  }
});
