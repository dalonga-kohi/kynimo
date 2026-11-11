import {
  COLOR_ROLES,
  DISTANCE_TOKENS,
  DURATION_TOKENS,
  EASING_TOKENS,
  SPACING_TOKENS,
  SPRING_TOKENS,
  STAGGER_TOKENS,
  TYPE_ROLES,
} from "@kynimo/guidelines";
import {
  AnimateInputSchema,
  ApplyPresetInputSchema,
  RetimeInputSchema,
  StaggerInputSchema,
} from "@kynimo/intent";
import { LayerSelectorSchema, OpSchema } from "@kynimo/scene";
import { z } from "zod";
import { emitTypes } from "./emit-types.js";

/** Largest generated `Op` type, in characters, before it falls back to loose per-op types. */
export const MAX_OP_TYPES_CHARS = 40_000;

const union = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(" | ");
const record = (names: readonly string[], value: string): string =>
  `{ ${names.map((n) => `${n}: ${value};`).join(" ")} }`;

/** The `Op` name of every op literal, found in the schema (setTransformTrack is a nested union). */
export function opNames(): string[] {
  const names: string[] = [];
  const visit = (schema: unknown): void => {
    const s = schema as {
      def?: { options?: unknown[] };
      shape?: { op?: { value?: string } };
    };
    if (s.shape?.op?.value !== undefined) {
      if (!names.includes(s.shape.op.value)) names.push(s.shape.op.value);
    } else if (s.def?.options !== undefined) {
      for (const o of s.def.options) visit(o);
    }
  };
  visit(OpSchema);
  return names;
}

const generated = (): z.ZodType =>
  z.strictObject({
    Op: OpSchema,
    LayerSelector: LayerSelectorSchema,
    AnimateInput: AnimateInputSchema,
    ApplyPresetInput: ApplyPresetInputSchema,
    StaggerInput: StaggerInputSchema,
    RetimeInput: RetimeInputSchema,
  });

const OP_DOC = "/** One scene operation: the item type of `apply_ops.ops`. */\n";

const RESERVED = [
  "Kynimo",
  "Composition",
  "Layer",
  "Layers",
  "Tokens",
  "AssetInfo",
  "LayerType",
  "LayerProps",
  "BehaviorArg",
  "WithLayers",
  "TransformProperty",
  "AddLayerOp",
  "Easing",
];

/** The generated, input-side types. `fallbackOps` writes each op loosely instead of in full. */
function generatedTypes(fallbackOps: boolean): string {
  const json = z.toJSONSchema(generated(), { reused: "ref", io: "input" }) as Record<
    string,
    unknown
  >;
  const roots = [
    { name: "Op", property: "Op", doc: OP_DOC.slice(4, -4) },
    {
      name: "LayerSelector",
      property: "LayerSelector",
      doc: "An id, or a pattern for exactly one layer (`*` matches any run of characters in `name`).",
    },
    { name: "AnimateInput", property: "AnimateInput" },
    { name: "ApplyPresetInput", property: "ApplyPresetInput" },
    { name: "StaggerInput", property: "StaggerInput" },
    { name: "RetimeInput", property: "RetimeInput" },
  ];
  const text = emitTypes(json, { roots, reserved: RESERVED });
  if (!fallbackOps) return text;
  // Replace the full Op type by loose ones; drop what only it referenced.
  const loose = emitTypes(
    {
      ...json,
      properties: { ...(json.properties as object), Op: {} },
    },
    { roots, reserved: RESERVED },
  );
  const looseOp = `/** One scene operation. Fields of each op: kynimo://schema/ops. */\ntype Op =\n${opNames()
    .map((n) => `  | { op: "${n}"; [field: string]: unknown }`)
    .join("\n")};`;
  return loose.replace(`${OP_DOC}type Op = unknown;`, looseOp);
}

const HAND_WRITTEN = `
/** A layer in the project, or one this script added. Methods only record operations. */
interface Layer {
  readonly id: string;
  /** Updated by \`update({ name })\`. */
  readonly name: string;
  readonly type: LayerType;
  /** Id of its composition. */
  readonly composition: string;
  /** Parent layer id (as of the start of the run, or as added). */
  readonly parentId: string | null;
  readonly inFrame: number;
  readonly outFrame: number;
  readonly startFrame: number;
  /** Each transform property's constant value at the start of the run, else \`null\` (keyframed). */
  readonly transform: { readonly [property in TransformProperty]?: unknown };
  /** Transform properties that had keyframes at the start of the run. */
  readonly animated: readonly TransformProperty[];
  /** The string of a text layer. */
  readonly text: string | undefined;
  /** Sets a transform property to a constant. */
  set(property: TransformProperty, value: unknown): void;
  /** Replaces a transform property's track with keyframes. */
  keyframes(property: TransformProperty, keyframes: readonly unknown[]): void;
  /** Changes name, inFrame, outFrame, startFrame, hidden or solo. */
  update(patch: Extract<Op, { op: "updateLayer" }>["set"]): void;
  /** Sets (or with \`null\` clears) the parent. */
  parent(layer: Layer | LayerSelector | null): void;
  /** Removes the layer. Using the handle afterwards throws. */
  remove(): void;
  /** Adds a behavior (wiggle, oscillate, loop, inertia, link); name defaults to its type, enabled to true. */
  behavior(behavior: BehaviorArg, options?: { id?: string; index?: number }): void;
  /** Moves a transform property over a window; same as the \`animate\` tool for this layer. */
  animate(input: Omit<AnimateInput, "layers">): void;
  /** Applies an enter or exit preset (see kynimo://presets) to this layer. */
  preset(
    id: string,
    params?: ApplyPresetInput["params"],
    stagger?: ApplyPresetInput["stagger"],
  ): void;
}

interface Composition {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly fps: { readonly num: number; readonly den: number };
  readonly durationFrames: number;
  /** Shorter side / 1080: multiply token pixel values by it. */
  readonly scale: number;
  /** Top-first. The layers at the start of the run plus the ones this script added or removed. */
  readonly layers: readonly Layer[];
  /** Milliseconds as frames at this frame rate (whole milliseconds, rounded like the duration tokens). */
  frames(milliseconds: number): number;
  /** The one layer matching the selector in this composition; throws on none or several. */
  layer(selector: LayerSelector | Layer): Layer;
  /** Every layer matching the selector in this composition. */
  find(selector: LayerSelector | Layer): Layer[];
  /** Adds a layer of the given type. The id is \`options.id\` or \`layer-<n>\`. \`index\` 0 (default) is the top. */
  add<T extends LayerType>(
    type: T,
    props: LayerProps<T>,
    options?: { id?: string; index?: number },
  ): Layer;
}

/** The resolved style pack: the pinned one, or Keynote's when the project pins none. */
interface Tokens {
  readonly pack: { readonly id: string; readonly version: string; readonly pinned: boolean };
  readonly colors: Readonly<${record(COLOR_ROLES, "string")}>;
  readonly type: Readonly<Record<${union(TYPE_ROLES)}, {
    family: string; weight: number; size: number; tracking: number; leading: number;
    textCase: "none" | "upper" | "lower";
  }>>;
  readonly layout: {
    readonly margin: number;
    readonly columns: number;
    readonly gutter: number;
    readonly spacing: Readonly<Record<${union(SPACING_TOKENS)}, number>>;
    readonly cornerRadius: number;
  };
  readonly motion: {
    /** Milliseconds. */
    readonly durations: Readonly<Record<${union(DURATION_TOKENS)}, number>>;
    readonly easings: Readonly<Record<${union(EASING_TOKENS)}, Easing>>;
    readonly springs: Readonly<Record<${union(SPRING_TOKENS)}, { damping: number; response: number }>>;
    /** Milliseconds between items. */
    readonly stagger: Readonly<Record<${union(STAGGER_TOKENS)}, number>>;
    /** Pixels at 1080 high; multiply by \`Composition.scale\`. */
    readonly distance: Readonly<Record<${union(DISTANCE_TOKENS)}, number>>;
    readonly enterScale: number;
  };
}

type Easing =
  | { type: "linear" }
  | { type: "hold" }
  | { type: "bezier"; x1: number; y1: number; x2: number; y2: number };

interface AssetInfo {
  readonly id: string;
  readonly type: string;
  readonly name: string;
}

type TransformProperty = "anchorPoint" | "position" | "scale" | "rotation" | "skew" | "opacity";
type AddLayerOp = Extract<Op, { op: "addLayer" }>;
type LayerType = AddLayerOp["layer"]["type"];
/** The fields of a layer of that type, without \`type\` (the id is \`options.id\`). */
type LayerProps<T extends LayerType> = Omit<Extract<AddLayerOp["layer"], { type: T }>, "type">;
type BehaviorArg = Extract<Op, { op: "addBehavior" }>["behavior"] extends infer B
  ? B extends unknown
    ? Omit<B, "name" | "enabled"> & { name?: string; enabled?: boolean }
    : never
  : never;

/** A layer handle, a selector, or a list of them. */
type Layers = Layer | LayerSelector | readonly (Layer | LayerSelector)[];
type WithLayers<T extends { layers: unknown }> = Omit<T, "layers"> & { layers: Layers };

interface Kynimo {
  /** Seeded from the run's \`seed\`: the same script, seed and document always give the same numbers. In [0, 1). */
  random(): number;
  readonly tokens: Tokens;
  /** The project's assets; ids go in layer fields such as \`assetId\`. */
  readonly assets: readonly AssetInfo[];
  /** A composition by id; the main one by default. */
  composition(id?: string): Composition;
  /** The one layer matching the selector anywhere in the project; throws on none or several. */
  layer(selector: LayerSelector | Layer): Layer;
  /** Records any scene operation as is. Not reflected in \`layers\`; prefer the methods above. */
  op(op: Op): void;
  /** Same as the \`animate\` tool. */
  animate(input: WithLayers<AnimateInput>): void;
  /** Same as the \`apply_preset\` tool. */
  preset(input: WithLayers<ApplyPresetInput>): void;
  /** Same as the \`stagger\` tool. */
  stagger(input: WithLayers<StaggerInput>): void;
  /** Same as the \`retime\` tool. */
  retime(input: WithLayers<RetimeInput>): void;
}

/** The scene SDK. A script runs once and records operations; it has no clock, network or files. */
declare const kynimo: Kynimo;
`;

export interface DeclarationSizes {
  full: number;
  loose: number;
  used: "full" | "loose";
}

const build = (fallbackOps: boolean): string =>
  `// Kynimo script SDK (ADR-0036). Generated from the scene schemas; a script is TypeScript with\n// types erased, run once. Shape layer contents items are typed unknown here (a recursive\n// schema); see kynimo://schema/layer/shape for them.\n\n${generatedTypes(fallbackOps)}${HAND_WRITTEN}`;

let memo: { text: string; sizes: DeclarationSizes } | undefined;

function declarations(): { text: string; sizes: DeclarationSizes } {
  if (memo === undefined) {
    const full = build(false);
    const loose = build(true);
    const used = full.length > MAX_OP_TYPES_CHARS ? "loose" : "full";
    memo = {
      text: used === "full" ? full : loose,
      sizes: { full: full.length, loose: loose.length, used },
    };
  }
  return memo;
}

/** The text of `kynimo://sdk`: TypeScript declarations of the global \`kynimo\`. Memoized. */
export function sdkDeclarations(): string {
  return declarations().text;
}

/** Sizes of the declarations written in full and with loose `Op` types, and which one is served. */
export function sdkDeclarationSizes(): DeclarationSizes {
  return declarations().sizes;
}
