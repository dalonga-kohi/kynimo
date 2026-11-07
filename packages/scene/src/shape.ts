import { z } from "zod";
import { ShapeItemIdSchema } from "./ids.js";
import type { Keyframe } from "./keyframes.js";
import { MAX_GRADIENT_STOPS } from "./limits.js";
import {
  ColorSchema,
  NameSchema,
  NonNegativeSchema,
  NumberSchema,
  PositiveSchema,
  UnitIntervalSchema,
  Vec2Schema,
} from "./primitives.js";
import { animatable, TransformSchema } from "./transform.js";

const GradientStopsSchema = z
  .array(z.strictObject({ offset: UnitIntervalSchema, color: ColorSchema }))
  .min(2)
  .max(MAX_GRADIENT_STOPS)
  .refine(
    (stops) => stops.every((stop, i) => i === 0 || stop.offset >= (stops[i - 1]?.offset ?? 0)),
    {
      message: "gradient stops must be in non-decreasing offset order",
    },
  );

const sameLengthCheck =
  (what: string) =>
  (keyframes: Keyframe<readonly unknown[]>[], ctx: z.RefinementCtx): void => {
    const count = keyframes[0]?.value.length ?? 0;
    keyframes.forEach((kf, i) => {
      if (kf.value.length !== count)
        ctx.addIssue({
          code: "custom",
          path: [i, "value"],
          message: `every keyframe must have the same number of ${what} (${count} in the first keyframe, ${kf.value.length} here)`,
        });
    });
  };

export const PaintSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("solid"), color: animatable(ColorSchema) }),
  z.strictObject({
    type: z.literal("linear-gradient"),
    start: animatable(Vec2Schema),
    end: animatable(Vec2Schema),
    stops: animatable(GradientStopsSchema, sameLengthCheck("gradient stops")),
  }),
  z.strictObject({
    type: z.literal("radial-gradient"),
    center: animatable(Vec2Schema),
    radius: animatable(PositiveSchema),
    stops: animatable(GradientStopsSchema, sameLengthCheck("gradient stops")),
  }),
]);
export type Paint = z.infer<typeof PaintSchema>;

/** Tangents are offsets relative to the vertex. */
export const BezierPathSchema = z.strictObject({
  closed: z.boolean(),
  vertices: z
    .array(z.strictObject({ point: Vec2Schema, inTangent: Vec2Schema, outTangent: Vec2Schema }))
    .min(2)
    .max(1000),
});
export type BezierPath = z.infer<typeof BezierPathSchema>;

/** Morphing needs the same topology on every keyframe. Different vertex counts are `v1.x`. */
const pathMorphCheck = (keyframes: Keyframe<BezierPath>[], ctx: z.RefinementCtx): void => {
  const first = keyframes[0]?.value;
  if (first === undefined) return;
  keyframes.forEach((kf, i) => {
    if (kf.value.vertices.length !== first.vertices.length || kf.value.closed !== first.closed)
      ctx.addIssue({
        code: "custom",
        path: [i, "value"],
        message: `path morphs need the same vertex count and closed flag on every keyframe (${first.vertices.length} vertices, closed=${first.closed} in the first keyframe); morphing between different vertex counts is not supported yet`,
      });
  });
};

const item = <T extends string>(type: T) => ({
  type: z.literal(type),
  id: ShapeItemIdSchema,
  name: NameSchema,
});

const RectSchema = z.strictObject({
  ...item("rect"),
  position: animatable(Vec2Schema),
  size: animatable(Vec2Schema),
  cornerRadius: animatable(NonNegativeSchema),
});

const EllipseSchema = z.strictObject({
  ...item("ellipse"),
  position: animatable(Vec2Schema),
  size: animatable(Vec2Schema),
});

const PolygonSchema = z.strictObject({
  ...item("polygon"),
  position: animatable(Vec2Schema),
  points: z.number().int().min(3).max(100),
  radius: animatable(PositiveSchema),
  rotation: animatable(NumberSchema),
});

const StarSchema = z.strictObject({
  ...item("star"),
  position: animatable(Vec2Schema),
  points: z.number().int().min(3).max(100),
  outerRadius: animatable(PositiveSchema),
  innerRadius: animatable(PositiveSchema),
  rotation: animatable(NumberSchema),
});

const PathSchema = z.strictObject({
  ...item("path"),
  path: animatable(BezierPathSchema, pathMorphCheck),
});

const FillSchema = z.strictObject({
  ...item("fill"),
  paint: PaintSchema,
  opacity: animatable(UnitIntervalSchema),
  rule: z.enum(["nonzero", "evenodd"]),
});

const StrokeSchema = z.strictObject({
  ...item("stroke"),
  paint: PaintSchema,
  opacity: animatable(UnitIntervalSchema),
  width: animatable(NonNegativeSchema),
  cap: z.enum(["butt", "round", "square"]),
  join: z.enum(["miter", "round", "bevel"]),
  miterLimit: z.number().min(1),
  /** Alternating dash and gap lengths; empty means solid. */
  dashes: z.array(NonNegativeSchema).max(16),
  dashOffset: animatable(NumberSchema),
});

const GroupBaseSchema = z.strictObject({ ...item("group"), transform: TransformSchema });

type LeafShapeItem =
  | z.infer<typeof RectSchema>
  | z.infer<typeof EllipseSchema>
  | z.infer<typeof PolygonSchema>
  | z.infer<typeof StarSchema>
  | z.infer<typeof PathSchema>
  | z.infer<typeof FillSchema>
  | z.infer<typeof StrokeSchema>;

export type GroupShapeItem = z.infer<typeof GroupBaseSchema> & { items: ShapeItem[] };
export type ShapeItem = LeafShapeItem | GroupShapeItem;

/** Groups may nest this deep. Deeper input is a validation error, never a stack overflow. */
export const MAX_GROUP_DEPTH = 32;
export const MAX_SHAPE_ITEMS = 500;

const leafItems = [
  RectSchema,
  EllipseSchema,
  PolygonSchema,
  StarSchema,
  PathSchema,
  FillSchema,
  StrokeSchema,
] as const;

/** Recursive through `z.lazy`; the type is written out by hand because Zod cannot infer a self-reference. */
const ShapeItemUncheckedSchema: z.ZodType<ShapeItem> = z.lazy(
  () =>
    z.discriminatedUnion("type", [...leafItems, GroupSchema]) as unknown as z.ZodType<ShapeItem>,
);

const GroupSchema = z.strictObject({
  ...GroupBaseSchema.shape,
  get items(): z.ZodArray<z.ZodType<ShapeItem>> {
    return z.array(ShapeItemUncheckedSchema).max(MAX_SHAPE_ITEMS);
  },
});

/**
 * Iterative, so hostile nesting can never overflow the stack. It runs before the recursive
 * schema, so a too-deep group yields one clear, pathed issue.
 */
const checkGroupDepth = (value: unknown, ctx: z.RefinementCtx): void => {
  const stack: { value: unknown; depth: number; path: (string | number)[] }[] = [
    { value, depth: 1, path: [] },
  ];
  while (stack.length > 0) {
    const node = stack.pop();
    const group = node?.value as { type?: unknown; items?: unknown } | null | undefined;
    if (node === undefined || typeof group !== "object" || group === null || group.type !== "group")
      continue;
    if (node.depth > MAX_GROUP_DEPTH) {
      ctx.addIssue({
        code: "custom",
        path: node.path,
        message: `group nesting exceeds ${MAX_GROUP_DEPTH} levels; flatten this group into its parent`,
        continue: false, // abort: later checks must not walk the unbounded input
      });
      return;
    }
    if (Array.isArray(group.items))
      group.items.forEach((child, i) => {
        stack.push({ value: child, depth: node.depth + 1, path: [...node.path, "items", i] });
      });
  }
};

/**
 * Items are listed top-first, like layers. Fills and strokes paint the geometry listed above them, with After Effects semantics (ADR-0017).
 * The input side is `unknown` because the depth check runs first, so use `io: "output"` when exporting JSON Schema.
 */
export const ShapeItemSchema: z.ZodType<ShapeItem> = z
  .unknown()
  .superRefine(checkGroupDepth)
  .pipe(ShapeItemUncheckedSchema);
