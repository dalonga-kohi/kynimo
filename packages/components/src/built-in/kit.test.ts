import type { DurationToken } from "@kynimo/guidelines";
import { keynote } from "@kynimo/guidelines";
import { springSettleFrames } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { createComponentStyle } from "../style.js";
import { enterEase, envelope } from "./kit.js";

const FPS = { num: 30, den: 1 };

function ctxOf(durationFrames: number, pack = keynote) {
  return {
    width: 1920,
    height: 1080,
    fps: FPS,
    durationFrames,
    frame: 0,
    seed: 1,
    depth: 0,
    random: () => 0.5,
    style: createComponentStyle(pack, { width: 1920, height: 1080 }, FPS),
    assetSize: () => null,
  } as never as Parameters<typeof envelope>[0];
}

const TOKENS: DurationToken[] = ["fast", "base", "slow"];

describe("envelope", () => {
  for (const span of [1, 2, 3, 10, 150])
    for (const exit of [null, "fast"] as const)
      for (const enter of TOKENS)
        it(`fits an enter of '${enter}' and ${exit === null ? "no exit" : "an exit"} in ${span} frames`, () => {
          const ctx = ctxOf(span);
          const env = envelope(ctx, { enter, exit });
          expect(env.span).toBe(span);
          expect(env.exitStart).toBe(span - 1 - env.exitFrames);
          if (exit === null) expect(env.exitFrames).toBe(0);
          if (span >= 2) {
            expect(env.enterEnd).toBeGreaterThanOrEqual(1);
            expect(env.enterEnd + env.exitFrames).toBeLessThanOrEqual(span - 1);
            expect(env.exitStart).toBeGreaterThanOrEqual(env.enterEnd);
          } else {
            expect(env.enterEnd).toBe(0);
            expect(env.exitFrames).toBe(0);
          }
        });

  it("keeps the full windows when they fit", () => {
    const ctx = ctxOf(150);
    const enter = ctx.style.frames("base");
    const exit = ctx.style.frames("fast");
    expect(envelope(ctx, { enter: "base", exit: "fast" })).toEqual({
      span: 150,
      enterEnd: enter,
      exitFrames: exit,
      exitStart: 149 - exit,
    });
  });

  it("shrinks both windows in proportion when they don't fit", () => {
    const ctx = ctxOf(10);
    const enter = Math.max(1, ctx.style.frames("slow"));
    const exit = Math.max(1, ctx.style.frames("fast"));
    expect(enter + exit).toBeGreaterThan(9);
    const k = 9 / (enter + exit);
    const env = envelope(ctx, { enter: "slow", exit: "fast" });
    expect(env.enterEnd).toBe(Math.max(1, Math.floor(enter * k)));
    expect(env.exitFrames).toBe(Math.max(1, Math.floor(exit * k)));
    expect(env.enterEnd).toBeLessThan(enter);
  });

  it("drops an exit that still doesn't fit after shrinking", () => {
    const env = envelope(ctxOf(2), { enter: "base", exit: "fast" });
    expect(env).toEqual({ span: 2, enterEnd: 1, exitFrames: 0, exitStart: 1 });
    const three = envelope(ctxOf(3), { enter: "slow", exit: "slow" });
    expect(three.exitFrames).toBe(1);
    expect(three.enterEnd + three.exitFrames).toBeLessThanOrEqual(2);
  });

  it("shows the entered state, with no exit, for a one-frame instance", () => {
    expect(envelope(ctxOf(1), { enter: "base", exit: "fast" })).toEqual({
      span: 1,
      enterEnd: 0,
      exitFrames: 0,
      exitStart: 0,
    });
  });
});

describe("enterEase", () => {
  const ctx = ctxOf(150);
  const spring = ctx.style.easing("gentle");

  it("uses the spring when it settles within the window", () => {
    if (spring.type !== "spring")
      throw new Error("expected the pack's spring token to be a spring");
    const settle = springSettleFrames(spring, FPS);
    expect(enterEase(ctx, "gentle", settle)).toEqual(spring);
    expect(enterEase(ctx, "gentle", settle + 20)).toEqual(spring);
  });

  it("falls back to the pack's enter easing when the window is one frame short", () => {
    if (spring.type !== "spring")
      throw new Error("expected the pack's spring token to be a spring");
    const settle = springSettleFrames(spring, FPS);
    expect(enterEase(ctx, "gentle", settle - 1)).toEqual(ctx.style.easing("enter"));
  });
});
