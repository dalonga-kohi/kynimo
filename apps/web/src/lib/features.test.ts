import { describe, expect, it } from "vitest";
import { drawFeature, FEATURE, FEATURES, type FeatureId, progress } from "./features";

/** A fake 2D context that logs every call and property write, in order. */
function recorder() {
  const log: string[] = [];
  const state: Record<string, unknown> = {};
  const target = {
    measureText: (text: string) => {
      log.push(`measureText(${text})`);
      return { width: text.length * 40 };
    },
  };
  const ctx = new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key as keyof typeof t];
      if (key in state) return state[key];
      return (...args: unknown[]) => {
        log.push(`${key}(${args.map(String).join(",")})`);
      };
    },
    set(_t, key: string, value) {
      state[key] = value;
      log.push(`${key}=${String(value)}`);
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

const draw = (id: FeatureId, frame: number) => {
  const { ctx, log } = recorder();
  drawFeature(ctx, 1920, 1080, id, frame);
  return log;
};

describe("drawFeature", () => {
  const ids = FEATURES.map((feature) => feature.id);

  it("draws the same calls for the same frame", () => {
    for (const id of ids)
      for (const frame of [0, 37, 96, 141, 179]) expect(draw(id, frame)).toEqual(draw(id, frame));
  });

  it("wraps frames around the six-second loop", () => {
    for (const id of ids) {
      expect(draw(id, FEATURE.frames)).toEqual(draw(id, 0));
      expect(draw(id, -1)).toEqual(draw(id, FEATURE.frames - 1));
    }
  });

  it("draws something on every poster frame", () => {
    for (const feature of FEATURES) {
      expect(feature.poster).toBeLessThan(FEATURE.frames);
      const marks = draw(feature.id, feature.poster).filter((line) =>
        /^(fill|stroke|fillRect|fillText|strokeText)\(/.test(line),
      );
      // More than the background fill alone.
      expect(marks.length, feature.id).toBeGreaterThan(1);
    }
  });

  it("never sets an alpha outside 0 to 1", () => {
    for (const id of ids)
      for (let frame = 0; frame < FEATURE.frames; frame += 7)
        for (const line of draw(id, frame)) {
          if (!line.startsWith("globalAlpha=")) continue;
          const alpha = Number(line.slice("globalAlpha=".length));
          expect(alpha, `${id} frame ${frame}`).toBeGreaterThanOrEqual(0);
          expect(alpha, `${id} frame ${frame}`).toBeLessThanOrEqual(1);
        }
  });
});

describe("progress", () => {
  it("runs 0 to 1 over its window and clamps outside it", () => {
    expect(progress(0, 10, 20)).toBe(0);
    expect(progress(20, 10, 20)).toBe(0.5);
    expect(progress(40, 10, 20)).toBe(1);
  });
});
