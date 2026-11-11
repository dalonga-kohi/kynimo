import { describe, expect, it } from "vitest";
import { defineComponent } from "./define.js";
import { BUILT_IN_COMPONENTS, builtInRegistry, createComponentRegistry } from "./registry.js";

const make = (id: string, version: string) =>
  defineComponent({
    id,
    version,
    title: id,
    description: "x",
    props: {},
    evaluate: () => ({ width: 1, height: 1, layers: [] }),
  });

describe("component registry", () => {
  it("gets by id and version", () => {
    const a = make("a", "1.0.0");
    const registry = createComponentRegistry([a]);
    expect(registry.get("a", "1.0.0")).toBe(a);
    expect(registry.get("a", "1.0.1")).toBeUndefined();
    expect(registry.get("b", "1.0.0")).toBeUndefined();
  });

  it("lists by id, then by version numerically", () => {
    const registry = createComponentRegistry([
      make("b", "1.0.0"),
      make("a", "1.10.0"),
      make("a", "1.2.0"),
      make("a", "0.9.9"),
    ]);
    expect(registry.list().map((d) => `${d.id}@${d.version}`)).toEqual([
      "a@0.9.9",
      "a@1.2.0",
      "a@1.10.0",
      "b@1.0.0",
    ]);
  });

  it("rejects a duplicate id and version", () => {
    expect(() => createComponentRegistry([make("a", "1.0.0"), make("a", "1.0.0")])).toThrow(
      /duplicate component 'a@1.0.0'/,
    );
  });

  it("starts with no built-in components", () => {
    expect(BUILT_IN_COMPONENTS).toEqual([]);
    expect(builtInRegistry.list()).toEqual([]);
  });
});
