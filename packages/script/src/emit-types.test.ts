import { describe, expect, it } from "vitest";
import { emitTypes } from "./emit-types.js";

const emit = (properties: Record<string, unknown>, defs: Record<string, unknown> = {}) =>
  emitTypes(
    { type: "object", properties, $defs: defs },
    {
      roots: Object.keys(properties).map((k) => ({
        name: k.charAt(0).toUpperCase() + k.slice(1),
        property: k,
      })),
    },
  );

describe("emitTypes", () => {
  it("emits primitives, enums, consts and unions", () => {
    const out = emit({
      s: { type: "string" },
      n: { type: "integer", minimum: 1 },
      b: { type: "boolean" },
      nil: { type: "null" },
      e: { enum: ["a", "b"] },
      c: { type: "string", const: "x" },
      u: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
      o: {
        oneOf: [
          { type: "string", const: "p" },
          { type: "string", const: "q" },
        ],
      },
    });
    expect(out).toContain("type S = string;");
    expect(out).toContain("type N = number;");
    expect(out).toContain("type B = boolean;");
    expect(out).toContain("type Nil = null;");
    expect(out).toContain('type E = "a" | "b";');
    expect(out).toContain('type C = "x";');
    expect(out).toContain("type U = string | number | null;");
    expect(out).toContain('type O = "p" | "q";');
  });

  it("emits objects with required and optional properties, quoting odd keys", () => {
    const out = emit({
      o: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" }, "x-y": { type: "boolean" } },
        required: ["a"],
        additionalProperties: false,
      },
    });
    expect(out).toContain('type O = { a: string; b?: number; "x-y"?: boolean };');
  });

  it("emits open objects, records and empty schemas", () => {
    const out = emit({
      rec: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
      typed: { type: "object", additionalProperties: { type: "number" } },
      any: {},
      bare: { type: "object" },
    });
    expect(out).toContain("type Rec = { [key: string]: unknown };");
    expect(out).toContain("type Typed = { [key: string]: number };");
    expect(out).toContain("type Any = unknown;");
    expect(out).toContain("type Bare = { [key: string]: unknown };");
  });

  it("emits arrays, tuples and parenthesises unions in arrays", () => {
    const out = emit({
      a: { type: "array", items: { type: "string" } },
      u: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
      t: {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
        minItems: 2,
        maxItems: 2,
      },
      objs: {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: { k: { type: "string" } },
              required: ["k"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
      },
    });
    expect(out).toContain("type A = string[];");
    expect(out).toContain("type U = (string | number)[];");
    expect(out).toContain("type T = [number, string];");
    expect(out).toContain("type Objs = ({ k: string } | null)[];");
  });

  it("names $defs after the property that reaches them and shares them", () => {
    const out = emit(
      {
        layer: {
          type: "object",
          properties: { parent: { $ref: "#/$defs/p" }, other: { $ref: "#/$defs/p" } },
          required: ["parent"],
          additionalProperties: false,
        },
      },
      {
        p: {
          type: "object",
          properties: {
            id: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["id", "tags"],
          additionalProperties: false,
        },
      },
    );
    expect(out).toContain("type Layer = { parent: Parent; other?: Parent };");
    expect(out).toContain("type Parent = { id: string; tags: string[] };");
  });

  it("names a root that is a $ref after the root, and writes recursive defs by name", () => {
    const out = emit(
      { tree: { $ref: "#/$defs/t" } },
      {
        t: {
          type: "object",
          properties: { children: { type: "array", items: { $ref: "#/$defs/t" } } },
          required: ["children"],
          additionalProperties: false,
        },
      },
    );
    expect(out).toBe("type Tree = { children: Tree[] };\n");
  });

  it("writes short plain defs in place, follows alias defs and merges equal types", () => {
    const out = emit(
      {
        thing: {
          type: "object",
          properties: {
            a: { $ref: "#/$defs/alias" },
            b: { $ref: "#/$defs/num" },
            c: { $ref: "#/$defs/box1" },
            d: { $ref: "#/$defs/box2" },
          },
          required: ["a", "b", "c", "d"],
          additionalProperties: false,
        },
      },
      {
        alias: { $ref: "#/$defs/num" },
        num: { type: "number" },
        box1: {
          type: "object",
          properties: {
            v: { type: "string" },
            w: { type: "string" },
            x: { type: "string" },
            y: { type: "string" },
            z: { type: "string" },
          },
          required: ["v", "w", "x", "y", "z"],
          additionalProperties: false,
        },
        box2: {
          type: "object",
          properties: {
            v: { type: "string" },
            w: { type: "string" },
            x: { type: "string" },
            y: { type: "string" },
            z: { type: "string" },
          },
          required: ["v", "w", "x", "y", "z"],
          additionalProperties: false,
        },
      },
    );
    expect(out).toContain("a: number; b: number; c: ");
    // box1 and box2 are the same type, so one name stands for both.
    expect(out.match(/^type /gm)).toHaveLength(2);
    expect(out).toMatch(/c: (\w+); d: \1/);
  });

  it("avoids reserved names and keeps documentation as JSDoc", () => {
    const out = emitTypes(
      {
        type: "object",
        properties: {
          root: {
            type: "object",
            description: "A root.",
            properties: { layer: { $ref: "#/$defs/x", description: "The layer." } },
            required: ["layer"],
            additionalProperties: false,
          },
        },
        $defs: {
          x: {
            type: "object",
            description: "An x.",
            properties: { n: { type: "number" } },
            additionalProperties: false,
          },
        },
      },
      { roots: [{ name: "Root", property: "root" }], reserved: ["Layer"] },
    );
    expect(out).toContain("/** A root. */\ntype Root = {");
    expect(out).toContain("/** The layer. */\n  layer: Layer2;");
    expect(out).toContain("/** An x. */\ntype Layer2 = ");
  });

  it("falls back to unknown for what it does not model, and rejects a missing root", () => {
    expect(emit({ w: { type: "string", format: "date" }, x: { not: {} } })).toContain(
      "type X = never;",
    );
    expect(emit({ y: { weird: true } })).toContain("type Y = unknown;");
    expect(() =>
      emitTypes({ properties: {} }, { roots: [{ name: "A", property: "missing" }] }),
    ).toThrow(/no property 'missing'/);
  });

  it("is deterministic", () => {
    const props = { a: { anyOf: [{ type: "string" }, { type: "number" }] } };
    expect(emit(props)).toBe(emit(props));
  });
});
