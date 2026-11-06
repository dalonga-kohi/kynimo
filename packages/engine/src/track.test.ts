import {
  type Animatable,
  type Interpolation,
  type Keyframe,
  type PositionKeyframe,
  springSettleFrames,
} from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { cubicPath } from "./path.js";
import { sampleColor, sampleNumber, samplePosition, sampleSegment, sampleVector } from "./track.js";

const fps = { num: 30, den: 1 };
const linear: Interpolation = { type: "linear" };
const kf = <T>(frame: number, value: T, interpolation: Interpolation = linear): Keyframe<T> => ({
  frame,
  value,
  interpolation,
});

describe("sampleNumber", () => {
  it("returns constants as-is", () => {
    expect(sampleNumber({ value: 3 }, 100, fps)).toBe(3);
  });

  it("holds the first value before and the last value after the keyframes", () => {
    const track = { keyframes: [kf(10, 1), kf(20, 5)] };
    expect(sampleNumber(track, -5, fps)).toBe(1);
    expect(sampleNumber(track, 10, fps)).toBe(1);
    expect(sampleNumber(track, 20, fps)).toBe(5);
    expect(sampleNumber(track, 99, fps)).toBe(5);
  });

  it("interpolates linearly, holds, and eases", () => {
    expect(sampleNumber({ keyframes: [kf(0, 0), kf(10, 10)] }, 5, fps)).toBe(5);
    const hold = { keyframes: [kf(0, 0, { type: "hold" }), kf(10, 10)] };
    expect(sampleNumber(hold, 9, fps)).toBe(0);
    expect(sampleNumber(hold, 10, fps)).toBe(10);
    const easeIn = {
      keyframes: [kf(0, 0, { type: "bezier", x1: 0.42, y1: 0, x2: 1, y2: 1 }), kf(10, 10)],
    };
    expect(sampleNumber(easeIn, 5, fps)).toBeLessThan(5);
  });

  it("renders every stored keyframe value exactly at its frame, for every interpolation", () => {
    const spring: Interpolation = { type: "spring", damping: 0.4, response: 0.5 };
    const settle = springSettleFrames(spring, fps);
    const keyframes = [
      kf(0, 0.1, { type: "bezier", x1: 0.3, y1: -0.6, x2: 0.7, y2: 1.8 }),
      kf(12, 0.73, spring),
      kf(12 + settle, 0.2, { type: "hold" }),
      kf(30 + settle, 0.9),
      kf(45 + settle, 0.35),
    ];
    for (const k of keyframes) expect(sampleNumber({ keyframes }, k.frame, fps)).toBe(k.value);
  });

  it("lets a spring overshoot and land on the next keyframe at the settle frame", () => {
    const spring: Interpolation = { type: "spring", damping: 0.3, response: 0.6 };
    const settle = springSettleFrames(spring, fps);
    const track = { keyframes: [kf(0, 0, spring), kf(settle + 5, 100)] };
    const samples = Array.from({ length: settle }, (_, f) => sampleNumber(track, f, fps));
    expect(Math.max(...samples)).toBeGreaterThan(100);
    expect(sampleNumber(track, settle, fps)).toBe(100);
    expect(sampleNumber(track, settle + 3, fps)).toBe(100);
  });

  it("finds the right segment among many keyframes", () => {
    const keyframes = Array.from({ length: 1000 }, (_, i) => kf(i * 2, i));
    expect(sampleNumber({ keyframes }, 777, fps)).toBe(388.5);
    expect(sampleSegment(keyframes, 1998, fps).from.frame).toBe(1998);
  });
});

describe("sampleVector", () => {
  it("interpolates vectors of any dimension", () => {
    const track: Animatable<[number, number, number]> = {
      keyframes: [kf(0, [0, 0, 0]), kf(10, [10, 20, 30])],
    };
    expect(sampleVector(track, 5, fps)).toEqual([5, 10, 15]);
  });
});

describe("sampleColor", () => {
  it("returns float RGBA, exact at keyframes", () => {
    const track = { keyframes: [kf(0, "#ff0000"), kf(10, "#0000ff80")] };
    expect(sampleColor(track, 0, fps)).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(sampleColor(track, 10, fps)).toEqual({ r: 0, g: 0, b: 1, a: 128 / 255 });
    expect(sampleColor({ value: "#ffffff" }, 3, fps)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    const mid = sampleColor(track, 5, fps);
    expect(mid.a).toBeCloseTo((1 + 128 / 255) / 2, 12);
  });
});

describe("samplePosition", () => {
  const pk = (
    frame: number,
    value: [number, number],
    spatial?: PositionKeyframe["spatial"],
  ): PositionKeyframe => ({
    frame,
    value,
    interpolation: linear,
    ...(spatial ? { spatial } : {}),
  });

  it("handles constant and separate tracks", () => {
    expect(samplePosition({ value: [3, 4] }, 0, fps)).toEqual([3, 4]);
    const separate = {
      separate: { x: { keyframes: [kf(0, 0), kf(10, 100)] }, y: { value: 7 } },
    };
    expect(samplePosition(separate, 5, fps)).toEqual([50, 7]);
  });

  it("moves in a straight line without spatial handles", () => {
    const track = { keyframes: [pk(0, [0, 0]), pk(10, [100, 50])] };
    expect(samplePosition(track, 5, fps)).toEqual([50, 25]);
  });

  it("follows the bezier motion path when handles are set", () => {
    const track = {
      keyframes: [
        pk(0, [0, 0], { inTangent: [0, 0], outTangent: [0, 50] }),
        pk(10, [100, 0], { inTangent: [0, 50], outTangent: [0, 0] }),
      ],
    };
    const path = cubicPath([0, 0], [0, 50], [100, 50], [100, 0]);
    const mid = samplePosition(track, 5, fps);
    expect(mid).toEqual(path.at(0.5));
    expect(mid[1]).toBeGreaterThan(30); // bulges off the straight line
    expect(samplePosition(track, 0, fps)).toEqual([0, 0]);
    expect(samplePosition(track, 10, fps)).toEqual([100, 0]);
  });
});
