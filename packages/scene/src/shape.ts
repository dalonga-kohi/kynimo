import { z } from "zod";
import { ShapeItemIdSchema } from "./ids.js";
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
  .refine(
    (stops) => stops.every((stop, i) => i === 0 || stop.offset >= (stops[i - 1]?.offset ?? 0)),
    {
      message: "gradient stops must be in non-decreasing offset order",
    },
  );

export const PaintSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("solid"), color: animatable(ColorSchema) }),
  z.strictObject({
    type: z.literal("linear-gradient"),
    start: animatable(Vec2Schema),
    end: animatable(Vec2Schema),
    stops: animatable(GradientStopsSchema),
  }),
  z.strictObject({
    type: z.literal("radial-gradient"),
    center: animatable(Vec2Schema),
    radius: animatable(PositiveSchema),
    stops: animatable(GradientStopsSchema),
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

const PathSchema = z.strictObject({ ...item("path"), path: animatable(BezierPathSchema) });

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

/**
 * Items are listed top-first, like layers. How fills and strokes bind to geometry is defined with the renderer (M2).
 * Recursion is unrolled to a fixed depth instead of using a lazy self-reference, so parsing
 * hostile input cannot exhaust the stack. The recursive type is written out by hand for the same reason.
 */
const shapeItemAtDepth = (depth: number): z.ZodType<ShapeItem> => {
  if (depth === 0) return z.discriminatedUnion("type", [...leafItems]);
  const group = z.strictObject({
    ...GroupBaseSchema.shape,
    items: z.array(shapeItemAtDepth(depth - 1)).max(MAX_SHAPE_ITEMS),
  });
  return z.discriminatedUnion("type", [...leafItems, group]) as unknown as z.ZodType<ShapeItem>;
};
export const ShapeItemSchema: z.ZodType<ShapeItem> = shapeItemAtDepth(MAX_GROUP_DEPTH);
