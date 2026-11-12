import { describe, expect, it } from "vitest";
import { MAX_PROPS_PER_COMPONENT } from "../props.js";
import { ComponentDefinitionInputSchema, ComponentDefinitionSummarySchema } from "./definition.js";

const input = {
  id: "custom-meter",
  version: "1.0.0",
  title: "Meter",
  description: "An animated meter",
  source: "export function evaluate(props, ctx) {}",
};
const descriptor = { type: "number", default: 0, description: "Progress", animatable: true };

describe("project component definitions", () => {
  it("accepts a project-local id and exposes a source-free summary", () => {
    const { source: _source, ...metadata } = ComponentDefinitionInputSchema.parse({
      ...input,
      props: { progress: descriptor },
    });
    const summary = { ...metadata, kind: "component", hash: "a".repeat(64) };
    expect(ComponentDefinitionSummarySchema.parse(summary)).toEqual(summary);
    expect(
      ComponentDefinitionSummarySchema.safeParse({ ...summary, source: input.source }).success,
    ).toBe(false);
  });

  it("rejects reserved names and excessive prop counts before parsing descriptors", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(
        ComponentDefinitionInputSchema.safeParse({ ...input, props: { [key]: descriptor } })
          .success,
      ).toBe(false);
    }
    expect(
      ComponentDefinitionInputSchema.safeParse({
        ...input,
        props: Object.fromEntries(
          Array.from({ length: MAX_PROPS_PER_COMPONENT + 1 }, (_, i) => [`p${i}`, descriptor]),
        ),
      }).success,
    ).toBe(false);
  });
});
