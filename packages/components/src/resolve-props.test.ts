import { keynote, playfulSaas } from "@kynimo/guidelines";
import type { Json } from "@kynimo/scene";
import { ProjectSchema } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { audioAsset, imageAsset, kf } from "./fixtures.test-util.js";
import { MAX_NUMBER, type PropDescriptor, PropDescriptorSchema } from "./props.js";
import { type ResolveEnv, resolveProps } from "./resolve-props.js";

const d = "A prop.";
const env = (over: Partial<ResolveEnv> = {}): ResolveEnv => ({
  who: "component 'demo@1.0.0' on layer 'inst'",
  assets: [],
  pack: keynote,
  frame: 0,
  fps: { num: 30, den: 1 },
  ...over,
});
const resolve = (
  descriptors: Record<string, PropDescriptor>,
  given: Record<string, unknown>,
  over: Partial<ResolveEnv> = {},
) => resolveProps(descriptors, given as Record<string, Json>, env(over));

const num: PropDescriptor = {
  type: "number",
  description: d,
  default: 1,
  min: 0,
  max: 10,
  animatable: true,
};

describe("resolveProps: defaults and plain values", () => {
  const all: Record<string, PropDescriptor> = {
    n: num,
    p: { type: "point", description: d, default: [1, 2] },
    c: { type: "color", description: d, default: { role: "accent" } },
    s: { type: "string", description: d, default: "hi", maxLength: 5 },
    b: { type: "boolean", description: d, default: true },
    e: { type: "enum", description: d, values: ["x", "y"], default: "y" },
    a: { type: "asset", description: d, assetType: "image", default: null },
  };

  it("fills every missing prop from its descriptor", () => {
    expect(resolve(all, {})).toEqual({
      n: 1,
      p: [1, 2],
      c: keynote.color.accent,
      s: "hi",
      b: true,
      e: "y",
      a: null,
    });
  });

  it("takes plain values as given", () => {
    const image = imageAsset("logo");
    const assets = ProjectSchema.shape.assets.parse([image]);
    expect(
      resolve(
        all,
        { n: 4, p: [5, 6], c: "#112233", s: "abc", b: false, e: "x", a: "logo" },
        { assets },
      ),
    ).toEqual({ n: 4, p: [5, 6], c: "#112233", s: "abc", b: false, e: "x", a: "logo" });
    expect(resolve(all, { c: { role: "surface" }, a: null })).toMatchObject({
      c: keynote.color.surface,
      a: null,
    });
  });

  it("keeps an eight-digit literal color", () => {
    expect(resolve(all, { c: "#11223344" }).c).toBe("#11223344");
  });
});

describe("resolveProps: animation", () => {
  it("samples keyframed numbers at the frame", () => {
    const given = { n: { keyframes: [kf(0, 0), kf(10, 10)] } };
    expect(resolve({ n: num }, given, { frame: 5 }).n).toBe(5);
    expect(resolve({ n: num }, given, { frame: 0 }).n).toBe(0);
    expect(resolve({ n: num }, given, { frame: 99 }).n).toBe(10);
  });

  it("clamps an overshooting easing to min and max", () => {
    const overshoot = { type: "bezier", x1: 0.3, y1: 3, x2: 0.7, y2: 3 };
    const given = { n: { keyframes: [kf(0, 0, overshoot), kf(10, 10)] } };
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (frame) => resolve({ n: num }, given, { frame }).n as number,
    );
    expect(Math.max(...values)).toBe(10);
    for (const v of values) expect(v).toBeLessThanOrEqual(10);
  });

  it("rounds a sampled integer prop", () => {
    const int: PropDescriptor = { ...num, integer: true } as PropDescriptor;
    const given = { n: { keyframes: [kf(0, 0), kf(10, 10)] } };
    expect(resolve({ n: int }, given, { frame: 3 }).n).toBe(3);
    expect(resolve({ n: int }, { n: { keyframes: [kf(0, 0), kf(3, 1)] } }, { frame: 1 }).n).toBe(0);
    expect(resolve({ n: int }, { n: { keyframes: [kf(0, 0), kf(3, 1)] } }, { frame: 2 }).n).toBe(1);
  });

  it("samples keyframed points", () => {
    const p: PropDescriptor = { type: "point", description: d, default: [0, 0], animatable: true };
    expect(
      resolve({ p }, { p: { keyframes: [kf(0, [0, 0]), kf(10, [100, -50])] } }, { frame: 5 }).p,
    ).toEqual([50, -25]);
  });

  it("samples keyframed colors into hex", () => {
    const c: PropDescriptor = {
      type: "color",
      description: d,
      default: "#000000",
      animatable: true,
    };
    const given = { c: { keyframes: [kf(0, "#ff0000"), kf(10, "#0000ff")] } };
    expect(resolve({ c }, given, { frame: 0 }).c).toBe("#ff0000");
    expect(resolve({ c }, given, { frame: 10 }).c).toBe("#0000ff");
    expect(resolve({ c }, given, { frame: 5 }).c).toMatch(/^#[0-9a-f]{6}$/);
    expect(resolve({ c }, given, { frame: 5 }).c).not.toBe("#ff0000");
  });

  it("keeps alpha in a sampled color", () => {
    const c: PropDescriptor = {
      type: "color",
      description: d,
      default: "#000000",
      animatable: true,
    };
    const given = { c: { keyframes: [kf(0, "#ff000000"), kf(10, "#ff0000ff")] } };
    expect(resolve({ c }, given, { frame: 0 }).c).toBe("#ff000000");
    expect(resolve({ c }, given, { frame: 10 }).c).toBe("#ff0000");
  });
});

describe("resolveProps: style", () => {
  const c: PropDescriptor = {
    type: "color",
    description: d,
    default: { role: "accent" },
    animatable: true,
  };

  it("resolves a color role via the given pack", () => {
    expect(resolve({ c }, {}, { pack: playfulSaas }).c).toBe(playfulSaas.color.accent);
    expect(resolve({ c }, { c: { role: "text" } }, { pack: playfulSaas }).c).toBe(
      playfulSaas.color.text,
    );
    expect(playfulSaas.color.accent).not.toBe(keynote.color.accent);
  });
});

describe("resolveProps: errors", () => {
  const fails = (
    descriptors: Record<string, PropDescriptor>,
    given: Record<string, unknown>,
    pattern: RegExp,
  ) => {
    try {
      resolve(descriptors, given);
    } catch (e) {
      expect(e).toBeInstanceOf(RangeError);
      expect((e as Error).message).toMatch(/^component 'demo@1\.0\.0' on layer 'inst': props\./);
      expect((e as Error).message).toMatch(pattern);
      return;
    }
    throw new Error("expected resolveProps to throw");
  };

  it("rejects an unknown key and lists the real props", () => {
    fails({ n: num }, { nope: 1 }, /props\.nope is not a prop of this component; its props are: n/);
  });

  it("rejects wrong types and out-of-range values, naming the expectation", () => {
    fails({ n: num }, { n: "7" }, /props\.n must be a number from 0 to 10 \(got "7"\)/);
    fails({ n: num }, { n: 11 }, /props\.n must be a number from 0 to 10 \(got 11\)/);
    fails(
      { n: { ...num, integer: true } as PropDescriptor },
      { n: 1.5 },
      /an integer from 0 to 10/,
    );
    fails(
      { p: { type: "point", description: d, default: [0, 0] } },
      { p: [1] },
      /props\.p must be \[x, y\]/,
    );
    fails(
      { p: { type: "point", description: d, default: [0, 0] } },
      { p: [1e9, 0] },
      /props\.p must be \[x, y\]/,
    );
    fails(
      { c: { type: "color", description: d, default: "#000000" } },
      { c: "red" },
      /props\.c must be a lowercase hex color/,
    );
    fails(
      { c: { type: "color", description: d, default: "#000000" } },
      { c: { role: "primary" } },
      /unknown color role 'primary'/,
    );
    fails(
      { s: { type: "string", description: d, default: "", maxLength: 3 } },
      { s: "abcd" },
      /props\.s must be a string of at most 3 characters \(got 4\)/,
    );
    fails(
      { b: { type: "boolean", description: d, default: true } },
      { b: "yes" },
      /props\.b must be true or false/,
    );
    fails(
      { e: { type: "enum", description: d, values: ["x", "y"], default: "x" } },
      { e: "z" },
      /props\.e must be one of: x, y/,
    );
  });

  it("rejects keyframes on a prop that is not animatable", () => {
    fails(
      { n: { ...num, animatable: false } as PropDescriptor },
      { n: { keyframes: [kf(0, 1)] } },
      /props\.n is not animatable/,
    );
    fails(
      { n: { type: "number", description: d, default: 0 } },
      { n: { keyframes: [kf(0, 1)] } },
      /props\.n is not animatable/,
    );
  });

  it("points at the bad keyframe", () => {
    fails(
      { n: num },
      { n: { keyframes: [kf(0, 1), kf(5, 99)] } },
      /props\.n\.keyframes\[1\]\.value must be a number from 0 to 10/,
    );
    fails(
      { n: num },
      { n: { keyframes: [kf(5, 1), kf(5, 2)] } },
      /props\.n\.keyframes\[1\]\.frame.*increasing/,
    );
    fails({ n: num }, { n: { keyframes: [] } }, /props\.n\.keyframes/);
    fails({ n: num }, { n: { keyframes: [kf(0, 1)], value: 2 } }, /props\.n/);
  });

  it("allows only literal colors in color keyframes", () => {
    const c: PropDescriptor = {
      type: "color",
      description: d,
      default: "#000000",
      animatable: true,
    };
    fails(
      { c },
      { c: { keyframes: [kf(0, { role: "accent" })] } },
      /props\.c\.keyframes\[0\]\.value/,
    );
  });

  it("checks asset ids and types", () => {
    const a: PropDescriptor = { type: "asset", description: d, assetType: "image", default: null };
    fails({ a }, { a: "missing" }, /props\.a refers to unknown asset 'missing'/);
    fails({ a }, { a: 5 }, /props\.a must be an image asset id or null/);
    const assets = ProjectSchema.shape.assets.parse([audioAsset("song")]);
    try {
      resolve({ a }, { a: "song" }, { assets });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toMatch(
        /props\.a refers to audio asset 'song', expected an image asset/,
      );
    }
  });

  it("truncates echoed values to 60 characters", () => {
    try {
      resolve({ n: num }, { n: "x".repeat(500) });
      throw new Error("expected throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message.length).toBeLessThan(250);
      expect(message).toContain("...");
    }
  });
});

describe("resolveProps: hostile input", () => {
  it("rejects JSON at the depth limit where a scalar belongs, without recursing", () => {
    let deep: Json = 1;
    for (let i = 0; i < 16; i++) deep = { a: deep };
    expect(() => resolve({ n: num }, { n: deep })).toThrow(/props\.n must be a number/);
  });

  it("survives unprintable values in error messages", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => resolve({ n: num }, { n: cyclic })).toThrow(/\[unprintable\]/);
  });

  it("rejects a string far over maxLength", () => {
    const s: PropDescriptor = { type: "string", description: d, default: "", maxLength: 100 };
    expect(() => resolve({ s }, { s: "y".repeat(12_000) })).toThrow(
      /at most 100 characters \(got 12000\)/,
    );
  });

  it("rejects non-finite numbers", () => {
    expect(() => resolve({ n: num }, { n: Number.NaN })).toThrow(/props\.n must be a number/);
    expect(() => resolve({ n: num }, { n: Number.POSITIVE_INFINITY })).toThrow(/props\.n must be/);
  });

  it("rejects ten thousand keyframes through the scene's own limit", () => {
    const keyframes = Array.from({ length: 10_000 }, (_, i) => kf(i, 1));
    expect(() => resolve({ n: num }, { n: { keyframes } })).toThrow(/props\.n\.keyframes/);
  });

  it("does not treat inherited names as props", () => {
    expect(() => resolve({ n: num }, JSON.parse('{"__proto__": 1}'))).toThrow(/not a prop/);
    expect(() => resolve({ n: num }, { constructor: 1 })).toThrow(/not a prop/);
  });
});

describe("resolveProps: finite numbers", () => {
  const free: PropDescriptor = { type: "number", description: d, default: 0, animatable: true };

  it("keeps overshooting keyframes at the extremes finite and within bounds", () => {
    const overshoot = { type: "bezier", x1: 0.3, y1: 5, x2: 0.7, y2: -5 };
    for (let frame = 0; frame <= 10; frame++) {
      const v = resolve(
        { n: free },
        { n: { keyframes: [kf(0, -MAX_NUMBER, overshoot), kf(10, MAX_NUMBER)] } },
        { frame },
      ).n as number;
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(MAX_NUMBER);
    }
    const bounded = { ...free, min: 0, max: 5 } as PropDescriptor;
    for (let frame = 0; frame <= 10; frame++) {
      const v = resolve(
        { n: bounded },
        { n: { keyframes: [kf(0, 0, overshoot), kf(10, 5)] } },
        { frame },
      ).n as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it("rejects values beyond the range, plain and in keyframes", () => {
    expect(() => resolve({ n: free }, { n: 1.7e308 })).toThrow(
      /props\.n must be a number from -1000000000 to 1000000000/,
    );
    expect(() => resolve({ n: free }, { n: { keyframes: [kf(0, 1.7e308)] } })).toThrow(
      /props\.n\.keyframes\[0\]\.value/,
    );
  });

  it("rejects descriptor numbers beyond the range", () => {
    expect(PropDescriptorSchema.safeParse({ ...free, default: 1.7e308 }).success).toBe(false);
    expect(PropDescriptorSchema.safeParse({ ...free, max: 2e9 }).success).toBe(false);
    expect(PropDescriptorSchema.safeParse({ ...free, min: -2e9 }).success).toBe(false);
  });
});

describe("resolveProps: bounded errors", () => {
  it("truncates a huge unknown key", () => {
    const key = "k".repeat(1_000_000);
    let message = "";
    expect(() => {
      try {
        resolve({ n: num }, { [key]: 1 });
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    }).toThrow(/not a prop/);
    expect(message.length).toBeLessThan(400);
  });
});
