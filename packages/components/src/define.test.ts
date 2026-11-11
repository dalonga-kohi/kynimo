import { describe, expect, it } from "vitest";
import { type ComponentDefinition, defineComponent } from "./define.js";
import type { PropDescriptor } from "./props.js";

const base = (props: Record<string, unknown>): ComponentDefinition =>
  ({
    id: "demo",
    version: "1.0.0",
    title: "Demo",
    description: "A demo.",
    props,
    evaluate: () => ({ width: 10, height: 10, layers: [] }),
  }) as unknown as ComponentDefinition;

const d = "What it does.";

describe("defineComponent", () => {
  it("accepts one of each descriptor type and returns the definition frozen", () => {
    const def = defineComponent(
      base({
        count: { type: "number", description: d, default: 3, min: 0, max: 10, integer: true },
        offset: { type: "point", description: d, default: [1, 2], animatable: true },
        tone: { type: "color", description: d, default: { role: "accent" }, animatable: true },
        fixed: { type: "color", description: d, default: "#ff0000" },
        title: { type: "string", description: d, default: "Hi", maxLength: 10 },
        on: { type: "boolean", description: d, default: true },
        align: { type: "enum", description: d, values: ["left", "right"], default: "left" },
        photo: { type: "asset", description: d, assetType: "image", default: null },
      }),
    );
    expect(Object.keys(def.props)).toHaveLength(8);
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.props)).toBe(true);
    expect(Object.isFrozen(def.props.count)).toBe(true);
  });

  it.each<[string, unknown, RegExp]>([
    [
      "default above max",
      { type: "number", description: d, default: 11, max: 10 },
      /props\.p\.default: default 11 is above max 10/,
    ],
    [
      "default below min",
      { type: "number", description: d, default: -1, min: 0 },
      /props\.p\.default: .*below min 0/,
    ],
    [
      "non-integer default",
      { type: "number", description: d, default: 1.5, integer: true },
      /props\.p\.default: .*not an integer/,
    ],
    [
      "min above max",
      { type: "number", description: d, default: 1, min: 5, max: 2 },
      /props\.p\.min: /,
    ],
    [
      "enum default missing",
      { type: "enum", description: d, values: ["a"], default: "b" },
      /props\.p\.default: .*not one of/,
    ],
    [
      "enum duplicates",
      { type: "enum", description: d, values: ["a", "a"], default: "a" },
      /props\.p\.values: .*unique/,
    ],
    ["empty enum", { type: "enum", description: d, values: [], default: "a" }, /props\.p\.values/],
    [
      "string default too long",
      { type: "string", description: d, default: "abcdef", maxLength: 3 },
      /props\.p\.default: .*maxLength 3/,
    ],
    [
      "maxLength too large",
      { type: "string", description: d, default: "", maxLength: 10001 },
      /props\.p\.maxLength/,
    ],
    [
      "point out of range",
      { type: "point", description: d, default: [70000, 0] },
      /props\.p\.default\.0/,
    ],
    [
      "unknown color role",
      { type: "color", description: d, default: { role: "primary" } },
      /props\.p\.default/,
    ],
    [
      "asset default not null",
      { type: "asset", description: d, assetType: "image", default: "x" },
      /props\.p\.default/,
    ],
    ["missing description", { type: "boolean", default: true }, /props\.p\.description/],
    ["unknown type", { type: "vector", description: d, default: 1 }, /props\.p/],
    ["unknown field", { type: "boolean", description: d, default: true, min: 1 }, /props\.p/],
  ])("rejects %s with the path", (_name, descriptor, message) => {
    expect(() => defineComponent(base({ p: descriptor as PropDescriptor }))).toThrow(message);
  });

  it("rejects bad prop names", () => {
    const ok = { type: "boolean", description: d, default: true };
    for (const name of ["Title", "1a", "a-b", "a_b", "", "a".repeat(65)])
      expect(() => defineComponent(base({ [name]: ok }))).toThrow(/name must be camelCase/);
  });

  it("rejects more than 64 props", () => {
    const props = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [
        `p${i}`,
        { type: "boolean", description: d, default: true },
      ]),
    );
    expect(() => defineComponent(base(props))).toThrow(/props: at most 64 props/);
  });

  it("rejects a bad id, version, title or description", () => {
    expect(() => defineComponent({ ...base({}), id: "Bad Id" })).toThrow(/id:/);
    expect(() => defineComponent({ ...base({}), version: "1.0" })).toThrow(/version:/);
    expect(() => defineComponent({ ...base({}), title: "" })).toThrow(/title:/);
    expect(() => defineComponent({ ...base({}), description: "" })).toThrow(/description:/);
  });
});
