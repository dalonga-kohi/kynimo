import type { ComponentContext } from "@kynimo/engine";
import { type Color, ID_PATTERN, type Layer, NameSchema, SemverSchema } from "@kynimo/scene";
import {
  MAX_PROPS_PER_COMPONENT,
  PROP_NAME_PATTERN,
  type PropDescriptor,
  PropDescriptorSchema,
} from "./props.js";
import type { ComponentStyle } from "./style.js";

/** Resolved prop values: sampled at the frame, roles resolved, defaults filled in. */
export type ResolvedProps = Readonly<
  Record<string, number | [number, number] | string | boolean | null>
>;

/** What a component draws: a subtree sized and timed like the instance, validated by the host. */
export interface ComponentOutput {
  width: number;
  height: number;
  layers: Layer[];
  background?: Color | null;
}

export interface ComponentEvalContext extends ComponentContext {
  /** A fresh seeded PRNG per evaluate call (mulberry32(ctx.seed)): unit floats in [0, 1). */
  random(): number;
  style: ComponentStyle;
}

export interface ComponentDefinition {
  id: string;
  /** Semantic version. A document pins it, so a published version never changes (like pack versions). */
  version: string;
  title: string;
  description: string;
  props: Readonly<Record<string, PropDescriptor>>;
  /** Pure and deterministic in `props` and `ctx`: no clock, randomness (use `ctx.random`) or I/O. */
  evaluate(props: ResolvedProps, ctx: ComponentEvalContext): ComponentOutput;
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/**
 * Validates a definition (id, version, texts and every prop descriptor) and returns it frozen.
 * Throws an Error whose message names the failing path, so authoring mistakes surface at load.
 */
export function defineComponent(def: ComponentDefinition): ComponentDefinition {
  const fail = (path: string, problem: string): never => {
    throw new Error(`component '${String(def.id)}': ${path}: ${problem}`);
  };
  if (typeof def.id !== "string" || !ID_PATTERN.test(def.id))
    fail(
      "id",
      "must be 1-64 characters: lowercase letters, digits, '-' or '_', starting with a letter or digit",
    );
  if (!SemverSchema.safeParse(def.version).success)
    fail("version", "must be a semantic version like 1.0.0");
  if (!NameSchema.safeParse(def.title).success) fail("title", "must be 1-200 characters");
  if (
    typeof def.description !== "string" ||
    def.description.length < 1 ||
    def.description.length > 1000
  )
    fail("description", "must be 1-1000 characters");
  if (typeof def.evaluate !== "function") fail("evaluate", "must be a function");
  const names = Object.keys(def.props);
  if (names.length > MAX_PROPS_PER_COMPONENT)
    fail("props", `at most ${MAX_PROPS_PER_COMPONENT} props (got ${names.length})`);
  const props: Record<string, PropDescriptor> = {};
  for (const name of names) {
    if (!PROP_NAME_PATTERN.test(name))
      fail(
        `props.${name}`,
        "name must be camelCase: a lowercase letter, then letters and digits, up to 64 characters",
      );
    const parsed = PropDescriptorSchema.safeParse(def.props[name]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const sub = issue?.path.map((p) => `.${String(p)}`).join("") ?? "";
      fail(`props.${name}${sub}`, issue?.message ?? "invalid descriptor");
    } else props[name] = parsed.data;
  }
  return Object.freeze({ ...def, props: deepFreeze(props) });
}
