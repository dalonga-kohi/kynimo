import type { ColorRole, DurationToken, SpacingToken, TypeRole } from "@kynimo/guidelines";
import {
  ColorSchema,
  CompositionIdSchema,
  type Layer,
  MAX_COMPOSITION_SIZE,
  withLayerDefaults,
} from "@kynimo/scene";
import { position, solidLayer, textLayer } from "../built-in/kit.js";
import type {
  ComponentDefinition,
  ComponentEvalContext,
  ComponentOutput,
  ResolvedProps,
} from "../define.js";

export const COMPONENT_PROGRAM_LIMITS = Object.freeze({
  sourceBytes: 8192,
  syntaxNodes: 1024,
  depth: 24,
  iterations: 32,
  work: 8192,
  layers: 32,
  resultNodes: 12_288,
  resultStringUnits: 65_536,
  stringLength: 10_000,
});

type Scalar = string | number | boolean | null;
export type Value = Scalar | readonly Value[] | { readonly [key: string]: Value };
export interface State {
  readonly props: ResolvedProps;
  readonly ctx: ComponentEvalContext;
  readonly slots: Value[];
  readonly layers: unknown[];
  readonly generated: WeakMap<object, number>;
}

export type Expression = (state: State) => Value;
export type Statement = (state: State) => void;

export function fail(message: string): never {
  throw new RangeError(message);
}

export function number(value: Value | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("expected a finite number");
  return value;
}

export function string(value: Value | undefined): string {
  if (typeof value !== "string") fail("expected a string");
  if (value.length > COMPONENT_PROGRAM_LIMITS.stringLength) fail("component string limit exceeded");
  return value;
}

function token(value: Value | undefined): string {
  const name = string(value);
  if (Object.hasOwn(Object.prototype, name) || name === "prototype") fail("invalid style token");
  return name;
}

export function read(value: unknown, key: string): Value {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, key))
    fail(`cannot read field '${key}'`);
  return (value as Record<string, Value>)[key] as Value;
}

type NativeCall = (state: State, values: Value[]) => unknown;
type Intrinsic = readonly [arity: number, call: NativeCall];
const outputId = CompositionIdSchema.parse("component");
const builtOutputs = new WeakSet<ComponentOutput>();

export function hasGeneratedLayers(output: ComponentOutput): boolean {
  return builtOutputs.has(output);
}

function color(value: Value | undefined): `#${string}` {
  const fill = string(value);
  if (!ColorSchema.safeParse(fill).success) fail("expected a lowercase hex color");
  return fill as `#${string}`;
}

function size(value: Value | undefined) {
  const pixels = number(value);
  if (!Number.isInteger(pixels) || pixels < 1 || pixels > MAX_COMPOSITION_SIZE)
    fail(`expected a whole dimension from 1 to ${MAX_COMPOSITION_SIZE}`);
  return pixels;
}

function coordinate(value: Value | undefined) {
  const pixels = number(value);
  if (!Number.isFinite(pixels * 1000)) fail("position exceeds the numeric range");
  return pixels;
}

function generated(state: State, value: object, dynamicChars: number) {
  // The solid and text builders have a fixed shape and neither embeds caller-owned objects.
  // Reserve a conservative upper bound for their static fields and charge dynamic text exactly.
  state.generated.set(value, 512 + dynamicChars);
  return value;
}

const numeric = (fn: (x: number) => number): Intrinsic => [1, (_, [x]) => number(fn(number(x)))];
const pair = (fn: (x: number, y: number) => number): Intrinsic => [
  2,
  (_, [x, y]) => number(fn(number(x), number(y))),
];

export const CALLS = new Map<string, Intrinsic>([
  ["Math.abs", numeric(Math.abs)],
  ["Math.ceil", numeric(Math.ceil)],
  ["Math.floor", numeric(Math.floor)],
  ["Math.round", numeric(Math.round)],
  ["Math.sqrt", numeric(Math.sqrt)],
  ["Math.sin", numeric(Math.sin)],
  ["Math.cos", numeric(Math.cos)],
  ["Math.min", pair(Math.min)],
  ["Math.max", pair(Math.max)],
  ["ctx.random", [0, ({ ctx }) => ctx.random()]],
  ["ctx.style.color", [1, ({ ctx }, [role]) => ctx.style.color(token(role) as ColorRole)]],
  ["ctx.style.type", [1, ({ ctx }, [role]) => ctx.style.type(token(role) as TypeRole)]],
  [
    "ctx.style.spacing",
    [1, ({ ctx }, [name]) => number(ctx.style.spacing(token(name) as SpacingToken))],
  ],
  [
    "ctx.style.frames",
    [1, ({ ctx }, [name]) => number(ctx.style.frames(token(name) as DurationToken))],
  ],
  ["ctx.assetSize", [1, ({ ctx }, [id]) => ctx.assetSize(string(id))]],
  [
    "solid",
    [
      6,
      (state, [id, x, y, width, height, fillValue]) => {
        const layerId = string(id);
        const fill = color(fillValue);
        return generated(
          state,
          solidLayer({
            id: layerId,
            span: state.ctx.durationFrames,
            transform: { position: position(coordinate(x), coordinate(y)) },
            width: size(width),
            height: size(height),
            color: fill,
          }),
          layerId.length * 2 + fill.length,
        );
      },
    ],
  ],
  [
    "text",
    [
      6,
      (state, [id, x, y, content, fontSize, fillValue]) => {
        const { ctx } = state;
        const style = ctx.style.type("title");
        const layerId = string(id);
        const text = string(content);
        const fill = color(fillValue);
        const pixels = number(fontSize);
        if (pixels <= 0) fail("expected a positive font size");
        return generated(
          state,
          textLayer({
            id: layerId,
            span: ctx.durationFrames,
            transform: { position: position(coordinate(x), coordinate(y)) },
            content: text,
            font: { family: style.family, weight: style.weight, size: pixels },
            box: { mode: "point" },
            tracking: 0,
            leading: 1.2,
            textCase: "none",
            fill,
            align: "left",
          }),
          layerId.length * 2 + text.length + fill.length + style.family.length,
        );
      },
    ],
  ],
  [
    "layer",
    [
      1,
      ({ ctx }, [input]) =>
        withLayerDefaults(input, {
          id: outputId,
          name: "Component",
          width: ctx.width,
          height: ctx.height,
          fps: ctx.fps,
          durationFrames: ctx.durationFrames,
          background: null,
          layers: [],
          markers: [],
        }),
    ],
  ],
]);

/** Charge aliases at every occurrence before the scene schema copies the resulting tree. */
function checkOutput({ layers, generated }: State): void {
  let nodes = COMPONENT_PROGRAM_LIMITS.resultNodes;
  let chars = COMPONENT_PROGRAM_LIMITS.resultStringUnits;
  const walk = (value: unknown, depth: number) => {
    if (--nodes < 0 || depth > COMPONENT_PROGRAM_LIMITS.depth)
      fail("component result limit exceeded");
    if (typeof value === "string") chars -= string(value).length;
    if (typeof value === "number") number(value);
    if (value !== null && typeof value === "object") {
      const allowance = generated.get(value);
      if (allowance !== undefined) {
        nodes -= 128;
        chars -= allowance;
        if (nodes < 0 || depth + 4 > COMPONENT_PROGRAM_LIMITS.depth)
          fail("component result limit exceeded");
        if (chars < 0) fail("component result string budget exceeded");
        return;
      }
      for (const key of Object.keys(value)) {
        chars -= key.length;
        if (chars < 0) fail("component result string budget exceeded");
        walk((value as Record<string, unknown>)[key], depth + 1);
      }
    }
    if (chars < 0) fail("component result string budget exceeded");
  };
  walk(layers, 0);
}

export function compileEvaluation(
  statements: readonly Statement[],
  fields: readonly (readonly ["width" | "height" | "background", Expression])[],
): ComponentDefinition["evaluate"] {
  return (props, ctx) => {
    const state: State = { props, ctx, slots: [], layers: [], generated: new WeakMap() };
    for (const statement of statements) statement(state);
    checkOutput(state);
    for (const layer of state.layers as (Layer | null)[]) {
      if (typeof layer !== "object" || layer === null || state.generated.has(layer)) continue;
      if (
        layer?.type === "component" &&
        typeof layer.componentId === "string" &&
        layer.componentId.startsWith("custom-")
      )
        fail("project component instances must be pinned in the scene");
      if (layer?.type === "generator" && layer.generator?.type === "custom-shader")
        fail("project shader instances must be pinned in the scene");
      if (
        "effects" in layer &&
        Array.isArray(layer.effects) &&
        layer.effects.some((effect) => effect?.type === "custom-shader")
      )
        fail("project shader effects must be pinned in the scene");
    }
    const result: Partial<Record<"width" | "height" | "background", Value>> = {};
    for (const [name, expression] of fields) result[name] = expression(state);
    const fill = result.background ?? null;
    const output: ComponentOutput = {
      width: number(result.width),
      height: number(result.height),
      background: fill === null ? null : (string(fill) as `#${string}`),
      // The component host validates general output against the project schema before evaluation.
      layers: state.layers as ReturnType<ComponentDefinition["evaluate"]>["layers"],
    };
    if (
      state.layers.every(
        (layer) => typeof layer === "object" && layer !== null && state.generated.has(layer),
      )
    )
      builtOutputs.add(output);
    return output;
  };
}
