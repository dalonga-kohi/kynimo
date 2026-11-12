import { evaluateFrame } from "@kynimo/engine";
import {
  CompositionIdSchema,
  ProjectSchema,
  SCENE_FORMAT_VERSION,
  withLayerDefaults,
} from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { defineComponent } from "../define.js";
import { createComponentHost } from "../host.js";
import { createComponentRegistry } from "../registry.js";
import { compileComponentProgram } from "./compile.js";

const props = {
  progress: { type: "number", description: "Movement", animatable: true, default: 0 },
} as const;

const program = (body: string) => `export function evaluate(props, ctx) {
  const layers = [];
  ${body}
  return { width: ctx.width, height: ctx.height, layers };
}`;

function render(source: string) {
  const definition = defineComponent({
    id: "custom-bars",
    version: "1.0.0",
    title: "Bars",
    description: "Animated bars",
    props,
    evaluate: compileComponentProgram(source, props),
  });
  const comp = {
    id: CompositionIdSchema.parse("main"),
    name: "Main",
    width: 640,
    height: 360,
    fps: { num: 60, den: 1 },
    durationFrames: 60,
    background: null,
    layers: [],
    markers: [],
  };
  const instance = withLayerDefaults(
    {
      id: "instance",
      name: "Instance",
      type: "component",
      componentId: definition.id,
      componentVersion: definition.version,
      props: {
        progress: {
          keyframes: [
            { frame: 0, value: 0, interpolation: { type: "linear" } },
            { frame: 30, value: 30, interpolation: { type: "linear" } },
          ],
        },
      },
    },
    comp,
  );
  const doc = ProjectSchema.parse({
    formatVersion: SCENE_FORMAT_VERSION,
    name: "Project",
    style: null,
    mainCompositionId: "main",
    compositions: [{ ...comp, layers: [instance] }],
    assets: [],
  });
  const components = createComponentHost(doc, createComponentRegistry([definition]));
  return (frame: number) => evaluateFrame(doc, frame, "main", { components });
}

describe("bounded custom component source", () => {
  it("draws a seeded subtree from sampled props and is independent of frame order", () => {
    const frame = render(
      program(`
      const fill = ctx.style.color("accent");
      for (let i = 0; i < 3; i++) {
        const height = 1 + Math.floor(ctx.random() * 20) + props.progress;
        layers.push(solid(\`bar-\${i}\`, i * 16, 20, 10, height, fill));
      }
    `),
    );
    const first = frame(0);
    const later = frame(30);
    const root = first.layers[0];
    expect(root?.type === "component" && root.composition?.layers.map(({ id }) => id)).toEqual([
      "bar-0",
      "bar-1",
      "bar-2",
    ]);
    expect(later).not.toEqual(first);
    expect(frame(0)).toEqual(first);
  });

  it.each([
    ["const value = Date.now();", "intrinsic"],
    ["const value = props.missing;", "unknown prop"],
    ["const value = ctx.style.pack;", "context field"],
    ["const value = ({ a: 1 }).constructor;", "field name"],
    ["const value = ({ __proto__: null });", "field name"],
    ["const value = Math.random();", "intrinsic"],
    ["const value = props[ctx.frame];", "named field"],
    ["const value = new Function('return 1');", "unsupported expression"],
    ["const value = import('node:fs');", "unsupported expression"],
    ["while (true) {}", "unsupported statement"],
    ["for (let i = 0; i < ctx.width; i++) {}", "with N from"],
    [
      "for (let i = 0; i < 32; i++) for (let j = 0; j < 32; j++) for (let k = 0; k < 32; k++) { const x = 1; }",
      "work exceeds",
    ],
  ])("rejects %s", (body, error) => {
    expect(() => compileComponentProgram(program(body), props)).toThrow(error);
  });

  it("bounds source, layers and expanded output independently", () => {
    expect(() => compileComponentProgram(program(`/* ${"🟣".repeat(3000)} */`), props)).toThrow(
      "UTF-8 bytes",
    );
    const tooMany = render(
      program(`
      for (let i = 0; i < 17; i++) {
        layers.push(solid("one-" + i, i, 1, 10, 10, "#ffffff"));
        layers.push(solid("two-" + i, i, 2, 10, 10, "#ffffff"));
      }
    `),
    );
    expect(() => tooMany(0)).toThrow("exceeds 32 layers");

    const variables = Array.from({ length: 16 }, (_, i) =>
      i === 0 ? "const a0 = {};" : `const a${i} = [a${i - 1}, a${i - 1}];`,
    );
    const aliases = render(program(`${variables.join("\n")} layers.push(a15);`));
    expect(() => aliases(0)).toThrow("component result limit exceeded");
  });

  it("rejects nonfinite arithmetic and validates emitted layers with the component host", () => {
    const nonfinite = render(program("layers.push(solid('a', 1 / 0, 0, 1, 1, '#ff0000'));"));
    expect(() => nonfinite(0)).toThrow("finite number");
    const invalid = render(program("layers.push(layer({ id: 'a', name: 'A', type: 'solid' }));"));
    expect(() => invalid(0)).toThrow("invalid subtree");
  });

  it("validates generated-layer constraints before taking the fixed-shape fast path", () => {
    const solid = "layers.push(solid('a', 0, 0, 1, 1, '#ff0000'));";
    expect(() => render(program(solid + solid))(0)).toThrow("duplicate layer id");
    expect(() => render(program(solid.replace("#ff0000", "bad")))(0)).toThrow("hex color");
    expect(() => render(program(solid.replace("1, 1", "99999, 1")))(0)).toThrow("whole dimension");
    expect(() => render(program(solid.replace("0, 0", "1e308, 0")))(0)).toThrow("numeric range");
  });

  it("requires custom definition pins to live in the scene graph", () => {
    const hiddenPin = render(
      program(`layers.push(layer({
      id: "nested", name: "Nested", type: "component", componentId: "custom-other",
      componentVersion: "1.0.0", props: {},
    }));`),
    );
    expect(() => hiddenPin(0)).toThrow("must be pinned in the scene");
  });
});
