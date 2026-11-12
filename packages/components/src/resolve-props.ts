import { type Rgba, sampleColor, sampleNumber, sampleVector } from "@kynimo/engine";
import type { GuidelinePack } from "@kynimo/guidelines";
import {
  type Animatable,
  type Asset,
  AssetIdSchema,
  animatable,
  type Color,
  ColorSchema,
  type FrameRate,
  type Json,
  type Vec2,
} from "@kynimo/scene";
import { z } from "zod";
import type { ResolvedProps } from "./define.js";
import { MAX_NUMBER, MAX_POINT, type PropDescriptor } from "./props.js";

/** Where a resolution happens and what it needs: the instance, the document's assets and pack, and the frame. */
export interface ResolveEnv {
  /** `component 'badge@1.0.0' on layer 'cmp'`: prefixes every error. */
  who: string;
  assets: readonly Asset[];
  pack: GuidelinePack;
  /** Layer-local frame. */
  frame: number;
  fps: FrameRate;
}

export class ComponentPropError extends RangeError {
  constructor(
    readonly path: (string | number)[],
    message: string,
  ) {
    super(message);
  }
}

const MAX_ECHO = 60;

/** A value as it appears in an error message: JSON, cut to {@link MAX_ECHO} characters. */
function echo(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = "[unprintable]";
  }
  return text.length > MAX_ECHO ? `${text.slice(0, MAX_ECHO - 3)}...` : text;
}

/** A prop name for an error message: the raw text, cut to {@link MAX_ECHO} characters. */
const echoKey = (key: string): string =>
  key.length > MAX_ECHO ? `${key.slice(0, MAX_ECHO - 3)}...` : key;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type NumberDescriptor = Extract<PropDescriptor, { type: "number" }>;

function numberProblem(d: NumberDescriptor): string {
  const kind = d.integer === true ? "an integer" : "a number";
  if (d.min !== undefined && d.max !== undefined) return `${kind} from ${d.min} to ${d.max}`;
  if (d.min !== undefined) return `${kind} of at least ${d.min}`;
  if (d.max !== undefined) return `${kind} of at most ${d.max}`;
  return `${kind} from -${MAX_NUMBER} to ${MAX_NUMBER}`;
}

const numberOk = (d: NumberDescriptor, v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  Math.abs(v) <= MAX_NUMBER &&
  (d.integer !== true || Number.isInteger(v)) &&
  (d.min === undefined || v >= d.min) &&
  (d.max === undefined || v <= d.max);

const pointOk = (v: unknown): v is Vec2 =>
  Array.isArray(v) &&
  v.length === 2 &&
  v.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= MAX_POINT);

const POINT_PROBLEM = `[x, y], each a number from -${MAX_POINT} to ${MAX_POINT}`;

const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));

/** `#rrggbb` (or `#rrggbbaa` when not opaque) for a sampled color. */
function toHex({ r, g, b, a }: Rgba): Color {
  const byte = (c: number) =>
    Math.round(clamp(c, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a) : ""}`;
}

const formatPath = (path: readonly PropertyKey[]): string =>
  path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("");

/**
 * Checks `given` against the descriptors, fills defaults and samples animated props at the frame.
 * Throws RangeError `component '<id>@<v>' on layer '<id>': props.<name> <problem>` for the first issue.
 */
export function resolveProps(
  descriptors: Readonly<Record<string, PropDescriptor>>,
  given: Readonly<Record<string, Json>>,
  env: ResolveEnv,
): ResolvedProps {
  const fail = (name: string, problem: string, at: readonly PropertyKey[] = []): never => {
    // Report the exact key up to the descriptor name limit. Oversized keys point at props itself.
    const path =
      name.length <= 64
        ? [name, ...at.map((part) => (typeof part === "number" ? part : String(part)))]
        : [];
    throw new ComponentPropError(
      path,
      `${env.who}: props.${echoKey(name)}${formatPath(at)} ${problem}`,
    );
  };

  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(descriptors, key))
      fail(
        key,
        `is not a prop of this component; its props are: ${Object.keys(descriptors).join(", ") || "none"}`,
      );
  }

  /** Parses `{ keyframes }` for an animatable prop; any other shape is the caller's plain value. */
  const keyframes = <T>(name: string, value: unknown, item: z.ZodType<T>): Animatable<T> | null => {
    if (!isObject(value) || !("keyframes" in value)) return null;
    const parsed = animatable(item).safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(name, issue?.message ?? "is invalid", issue?.path);
    }
    if ("value" in parsed.data)
      return fail(name, "takes a plain value or { keyframes }, not { value }");
    return parsed.data;
  };

  const out: Record<string, number | [number, number] | string | boolean | null> = {};
  for (const [name, d] of Object.entries(descriptors)) {
    const value: unknown = Object.hasOwn(given, name) ? given[name] : undefined;
    const has = value !== undefined;
    const notAnimatable = (): never =>
      fail(name, "is not animatable; give a plain value, not { keyframes }");
    const wrongType = (expected: string): never =>
      fail(name, `must be ${expected} (got ${echo(value)})`);

    switch (d.type) {
      case "number": {
        const problem = numberProblem(d);
        if (!has) {
          out[name] = d.default;
          break;
        }
        const track = keyframes(
          name,
          value,
          z.number().refine((n) => numberOk(d, n), `must be ${problem}`),
        );
        if (track !== null) {
          if (d.animatable !== true) notAnimatable();
          const sampled = sampleNumber(track, env.frame, env.fps);
          const lo = Math.max(d.min ?? -MAX_NUMBER, -MAX_NUMBER);
          const hi = Math.min(d.max ?? MAX_NUMBER, MAX_NUMBER);
          const bounded = clamp(sampled, lo, hi);
          // Rounding can step outside a fractional bound, so clamp again.
          out[name] = d.integer === true ? clamp(Math.round(bounded), lo, hi) : bounded;
        } else if (numberOk(d, value)) out[name] = value;
        else wrongType(problem);
        break;
      }
      case "point": {
        if (!has) {
          out[name] = [d.default[0], d.default[1]];
          break;
        }
        const track = keyframes(name, value, z.custom<Vec2>(pointOk, `must be ${POINT_PROBLEM}`));
        if (track !== null) {
          if (d.animatable !== true) notAnimatable();
          const [x, y] = sampleVector(track, env.frame, env.fps);
          out[name] = [clamp(x, -MAX_POINT, MAX_POINT), clamp(y, -MAX_POINT, MAX_POINT)];
        } else if (pointOk(value)) out[name] = [value[0], value[1]];
        else wrongType(POINT_PROBLEM);
        break;
      }
      case "color": {
        const expected = "a lowercase hex color (#rrggbb or #rrggbbaa) or { role }";
        const role = (v: unknown): Color | null =>
          isObject(v) && Object.keys(v).length === 1 && typeof v.role === "string"
            ? roleColor(v.role)
            : null;
        const roleColor = (r: string): Color =>
          Object.hasOwn(env.pack.color, r)
            ? env.pack.color[r as keyof typeof env.pack.color]
            : fail(
                name,
                `has unknown color role '${r.slice(0, 40)}'; use one of: ${Object.keys(env.pack.color).join(", ")}`,
              );
        if (!has) {
          const def = d.default;
          out[name] = typeof def === "string" ? def : roleColor(def.role);
          break;
        }
        const track = keyframes(name, value, ColorSchema);
        if (track !== null) {
          if (d.animatable !== true) notAnimatable();
          out[name] = toHex(sampleColor(track, env.frame, env.fps));
        } else if (ColorSchema.safeParse(value).success) out[name] = value as Color;
        else {
          const resolved = role(value);
          if (resolved === null) wrongType(expected);
          else out[name] = resolved;
        }
        break;
      }
      case "string":
        if (!has) out[name] = d.default;
        else if (typeof value === "string" && value.length <= d.maxLength) out[name] = value;
        else
          wrongType(
            typeof value === "string"
              ? `a string of at most ${d.maxLength} characters (got ${value.length})`
              : `a string of at most ${d.maxLength} characters`,
          );
        break;
      case "boolean":
        if (!has) out[name] = d.default;
        else if (typeof value === "boolean") out[name] = value;
        else wrongType("true or false");
        break;
      case "enum":
        if (!has) out[name] = d.default;
        else if (typeof value === "string" && d.values.includes(value)) out[name] = value;
        else wrongType(`one of: ${d.values.join(", ")}`);
        break;
      case "asset": {
        if (!has || value === null) {
          out[name] = null;
          break;
        }
        if (typeof value !== "string") {
          wrongType(`an ${d.assetType} asset id or null`);
          break;
        }
        const asset = env.assets.find((a) => a.id === value);
        if (asset === undefined)
          fail(
            name,
            `refers to unknown asset '${value.slice(0, 64)}'; add the ${d.assetType} asset first`,
          );
        else if (asset.type !== d.assetType)
          fail(
            name,
            `refers to ${asset.type} asset '${asset.id}', expected an ${d.assetType} asset`,
          );
        else out[name] = AssetIdSchema.parse(asset.id);
        break;
      }
    }
  }
  return out;
}
