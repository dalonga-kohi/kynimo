import {
  ColorSchema,
  FontWeightSchema,
  ID_PATTERN,
  isBundledFontFamily,
  SemverSchema,
  SPRING_DAMPING,
  SPRING_RESPONSE,
} from "@kynimo/scene";
import { z } from "zod";
import { contrastRatio } from "./color.js";

/** Bumped when the pack format changes shape; packs are data and migrate like documents. */
export const PACK_FORMAT_VERSION = 1;

/** Sizes, distances and spacing are in pixels at this composition height and scale with it. */
export const REFERENCE_HEIGHT = 1080;

/**
 * Token names are the same in every pack. Presets, components and scripts refer to tokens by
 * name, so a document restyles by switching packs. A pack changes values, never names.
 */
export const COLOR_ROLES = [
  "background",
  "surface",
  "text",
  "textMuted",
  "accent",
  "accentAlt",
] as const;
export const TYPE_ROLES = ["display", "headline", "title", "body", "caption", "label"] as const;
export const DURATION_TOKENS = ["instant", "fast", "base", "slow", "slower"] as const;
export const EASING_TOKENS = ["enter", "exit", "move", "emphasis"] as const;
export const SPRING_TOKENS = ["gentle", "snappy", "bouncy"] as const;
export const STAGGER_TOKENS = ["tight", "base", "loose"] as const;
export const DISTANCE_TOKENS = ["small", "base", "large"] as const;
export const SPACING_TOKENS = ["xs", "s", "m", "l", "xl"] as const;

export type ColorRole = (typeof COLOR_ROLES)[number];
export type TypeRole = (typeof TYPE_ROLES)[number];
export type DurationToken = (typeof DURATION_TOKENS)[number];
export type EasingToken = (typeof EASING_TOKENS)[number];
export type SpringToken = (typeof SPRING_TOKENS)[number];
export type StaggerToken = (typeof STAGGER_TOKENS)[number];
export type DistanceToken = (typeof DISTANCE_TOKENS)[number];
export type SpacingToken = (typeof SPACING_TOKENS)[number];

const tokens = <K extends string, V extends z.ZodType>(names: readonly K[], value: V) =>
  z.strictObject(Object.fromEntries(names.map((n) => [n, value])) as Record<K, V>);

const Milliseconds = z.number().int().min(0).max(10_000);

/** An easing token: any keyframe interpolation except a spring (springs have their own tokens). */
export const EasingSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("linear") }),
  z.strictObject({ type: z.literal("hold") }),
  z.strictObject({
    type: z.literal("bezier"),
    x1: z.number().min(0).max(1),
    y1: z.number().min(-5).max(5),
    x2: z.number().min(0).max(1),
    y2: z.number().min(-5).max(5),
  }),
]);
export type Easing = z.infer<typeof EasingSchema>;

export const SpringSchema = z.strictObject({
  damping: z.number().min(SPRING_DAMPING.min).max(SPRING_DAMPING.max),
  response: z.number().min(SPRING_RESPONSE.min).max(SPRING_RESPONSE.max),
});

export const TypeStyleSchema = z.strictObject({
  /** A bundled family (ADR-0019): packs can't depend on fonts a document might not have. */
  family: z.string().refine(isBundledFontFamily, "must be a bundled font family"),
  weight: FontWeightSchema,
  /** Pixels at {@link REFERENCE_HEIGHT}. */
  size: z.number().positive().max(1000),
  /** Thousandths of an em, as on text layers. */
  tracking: z.number().min(-200).max(1000),
  /** Multiple of the font size, as on text layers. */
  leading: z.number().min(0.5).max(3),
  case: z.enum(["none", "upper"]),
});
export type TypeStyle = z.infer<typeof TypeStyleSchema>;

const Severity = z.enum(["error", "warning", "info"]);
const SourceId = z.string().regex(ID_PATTERN);
const rule = <S extends z.ZodRawShape>(shape: S) =>
  z.strictObject({
    severity: Severity,
    /** Where the threshold comes from; every id must be in the pack's `sources`. */
    sources: z.array(SourceId).min(1).max(8),
    ...shape,
  });

/**
 * Thresholds for the quality rules. The rule code lives in the rules engine (M5); a pack only
 * sets how strict each rule is. Every pack sets every rule, so no rule silently doesn't apply.
 */
export const RulesSchema = z.strictObject({
  /** Text stays readable for at least `minHoldMs`, and long enough to read at `wordsPerSecond`. */
  "readable-hold": rule({
    wordsPerSecond: z.number().positive().max(10),
    minHoldMs: Milliseconds,
  }),
  /** At most `max` unrelated elements start moving within the same `windowMs`. */
  "concurrent-motion": rule({
    max: z.number().int().min(1).max(50),
    windowMs: Milliseconds,
  }),
  /** WCAG contrast of text against what is behind it; `minRatioLarge` for text at or over `largeSize`. */
  "text-contrast": rule({
    minRatio: z.number().min(1).max(21),
    minRatioLarge: z.number().min(1).max(21),
    largeSize: z.number().positive(),
  }),
  /** Text stays inside the central `text` fraction of the frame, everything important inside `action`. */
  "safe-area": rule({
    text: z.number().min(0.5).max(1),
    action: z.number().min(0.5).max(1),
  }),
  /** No text smaller than `minSize` pixels at {@link REFERENCE_HEIGHT}. */
  "min-text-size": rule({ minSize: z.number().positive() }),
  /** Easings and springs come from the pack's tokens, not ad-hoc values. */
  "token-easing": rule({}),
  /** Colors come from the pack's roles, plus colors sampled from the user's own media. */
  "token-color": rule({}),
  /** Entrances last between `minMs` and `maxMs`. */
  "entrance-duration": rule({ minMs: Milliseconds, maxMs: Milliseconds }),
  /** No more than `maxPerSecond` large luminance flashes. */
  "flash-rate": rule({ maxPerSecond: z.number().positive().max(60) }),
  /** At most `max` font families and `maxWeights` weights in one video. */
  "font-variety": rule({
    max: z.number().int().min(1).max(10),
    maxWeights: z.number().int().min(1).max(9),
  }),
});
export type Rules = z.infer<typeof RulesSchema>;
export type RuleId = keyof Rules;

const PackShape = z.strictObject({
  formatVersion: z.literal(PACK_FORMAT_VERSION),
  id: z.string().regex(ID_PATTERN),
  version: SemverSchema,
  name: z.string().min(1).max(60),
  /** Words for the agent choosing and using the pack. Guidance only: what is enforced is in `rules`. */
  personality: z.strictObject({
    summary: z.string().min(1).max(400),
    useFor: z.array(z.string().min(1).max(120)).min(1).max(8),
    do: z.array(z.string().min(1).max(200)).min(1).max(10),
    avoid: z.array(z.string().min(1).max(200)).min(1).max(10),
  }),
  color: tokens(COLOR_ROLES, ColorSchema),
  type: tokens(TYPE_ROLES, TypeStyleSchema),
  layout: z.strictObject({
    /** Outer margin as a fraction of the composition's shorter side. */
    margin: z.number().min(0).max(0.25),
    columns: z.number().int().min(1).max(24),
    /** Pixels at {@link REFERENCE_HEIGHT}. */
    gutter: z.number().min(0).max(200),
    spacing: tokens(SPACING_TOKENS, z.number().min(0).max(500)),
    cornerRadius: z.number().min(0).max(200),
  }),
  motion: z.strictObject({
    durations: tokens(DURATION_TOKENS, Milliseconds),
    easings: tokens(EASING_TOKENS, EasingSchema),
    springs: tokens(SPRING_TOKENS, SpringSchema),
    /** Delay between consecutive items of a stagger, in milliseconds. */
    stagger: tokens(STAGGER_TOKENS, Milliseconds),
    /** How far things travel when they slide in or out; pixels at {@link REFERENCE_HEIGHT}. */
    distance: tokens(DISTANCE_TOKENS, z.number().min(0).max(1080)),
    /** The scale an element grows from when it enters (1 = no scaling). */
    enterScale: z.number().min(0).max(2),
  }),
  rules: RulesSchema,
  sources: z
    .array(
      z.strictObject({
        id: SourceId,
        title: z.string().min(1).max(200),
        url: z.url().optional(),
      }),
    )
    .min(1)
    .max(40),
});

const ascending = (
  values: Record<string, number>,
  names: readonly string[],
  path: string[],
  ctx: z.RefinementCtx,
) => {
  for (let i = 1; i < names.length; i++) {
    const prev = names[i - 1] as string;
    const name = names[i] as string;
    if ((values[name] as number) <= (values[prev] as number)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, name],
        message: `must be greater than ${prev}`,
      });
    }
  }
};

/**
 * A guideline pack. Beyond its shape, a pack must pass its own rules: its text colors meet its
 * contrast thresholds, its type sizes its minimum size, its base duration its entrance range.
 * A pack that fails its own checks would make every video built with it fail them too.
 */
export const GuidelinePackSchema = PackShape.superRefine((pack, ctx) => {
  ascending(pack.motion.durations, DURATION_TOKENS, ["motion", "durations"], ctx);
  ascending(pack.motion.stagger, STAGGER_TOKENS, ["motion", "stagger"], ctx);
  ascending(pack.motion.distance, DISTANCE_TOKENS, ["motion", "distance"], ctx);
  ascending(pack.layout.spacing, SPACING_TOKENS, ["layout", "spacing"], ctx);

  const sourceIds = new Set<string>();
  pack.sources.forEach((s, i) => {
    if (sourceIds.has(s.id)) {
      ctx.addIssue({ code: "custom", path: ["sources", i, "id"], message: "duplicate source id" });
    }
    sourceIds.add(s.id);
  });
  for (const [id, r] of Object.entries(pack.rules)) {
    r.sources.forEach((s, i) => {
      if (!sourceIds.has(s)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", id, "sources", i],
          message: `unknown source '${s}'`,
        });
      }
    });
  }

  const contrast = pack.rules["text-contrast"];
  if (contrast.minRatioLarge > contrast.minRatio) {
    ctx.addIssue({
      code: "custom",
      path: ["rules", "text-contrast", "minRatioLarge"],
      message: "must not exceed minRatio",
    });
  }
  // Body text colors must clear the normal threshold on both backgrounds; accents are for large
  // text and graphics, so they must clear the large-text threshold on the background.
  const pairs: [ColorRole, ColorRole, number][] = [
    ["text", "background", contrast.minRatio],
    ["text", "surface", contrast.minRatio],
    ["textMuted", "background", contrast.minRatio],
    ["textMuted", "surface", contrast.minRatio],
    ["accent", "background", contrast.minRatioLarge],
    ["accentAlt", "background", contrast.minRatioLarge],
  ];
  for (const [fg, bg, min] of pairs) {
    const ratio = contrastRatio(pack.color[fg], pack.color[bg]);
    if (ratio < min) {
      ctx.addIssue({
        code: "custom",
        path: ["color", fg],
        message: `contrast on ${bg} is ${ratio.toFixed(2)}, below this pack's ${min}`,
      });
    }
  }

  const minSize = pack.rules["min-text-size"].minSize;
  for (const role of TYPE_ROLES) {
    if (pack.type[role].size < minSize) {
      ctx.addIssue({
        code: "custom",
        path: ["type", role, "size"],
        message: `below this pack's min-text-size of ${minSize}`,
      });
    }
  }
  const weights = new Set(TYPE_ROLES.map((r) => pack.type[r].weight));
  const families = new Set(TYPE_ROLES.map((r) => pack.type[r].family));
  const variety = pack.rules["font-variety"];
  if (weights.size > variety.maxWeights || families.size > variety.max) {
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: `uses ${families.size} families and ${weights.size} weights, over this pack's font-variety limits`,
    });
  }

  const entrance = pack.rules["entrance-duration"];
  if (entrance.minMs > entrance.maxMs) {
    ctx.addIssue({
      code: "custom",
      path: ["rules", "entrance-duration", "minMs"],
      message: "must not exceed maxMs",
    });
  }
  const base = pack.motion.durations.base;
  if (base < entrance.minMs || base > entrance.maxMs) {
    ctx.addIssue({
      code: "custom",
      path: ["motion", "durations", "base"],
      message: "must lie inside this pack's entrance-duration range",
    });
  }
  const safe = pack.rules["safe-area"];
  if (safe.text > safe.action) {
    ctx.addIssue({
      code: "custom",
      path: ["rules", "safe-area", "text"],
      message: "must not exceed action",
    });
  }
});

export type GuidelinePack = z.infer<typeof GuidelinePackSchema>;
