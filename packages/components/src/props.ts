import { COLOR_ROLES } from "@kynimo/guidelines";
import { ColorSchema } from "@kynimo/scene";
import { z } from "zod";

/** Each axis of a point prop lies within this many units of the origin. */
export const MAX_POINT = 65536;
/** Number props, their bounds and their keyframe values lie within this many units of zero. */
export const MAX_NUMBER = 1e9;
export const MAX_PROPS_PER_COMPONENT = 64;
export const MAX_STRING_LENGTH = 10_000;
export const MAX_ENUM_VALUES = 32;

/** Prop names are camelCase identifiers, so they read the same in JSON, TypeScript and tool output. */
export const PROP_NAME_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;

const description = z.string().min(1).max(200);
const finite = z.number().min(-MAX_NUMBER).max(MAX_NUMBER);
const axis = z.number().min(-MAX_POINT).max(MAX_POINT);

export const ColorValueSchema = z.union([
  ColorSchema,
  z.strictObject({ role: z.enum(COLOR_ROLES) }),
]);
/** A literal color, or a color role of the document's style pack. */
export type ColorValue = z.infer<typeof ColorValueSchema>;

const numberDescriptor = z
  .strictObject({
    type: z.literal("number"),
    description,
    default: finite,
    min: finite.optional(),
    max: finite.optional(),
    integer: z.boolean().optional(),
    animatable: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    const bad = (message: string, path: string[] = ["default"]) =>
      ctx.addIssue({ code: "custom", path, message });
    if (d.min !== undefined && d.max !== undefined && d.min > d.max)
      bad(`min ${d.min} is above max ${d.max}`, ["min"]);
    if (d.integer === true && !Number.isInteger(d.default))
      bad(`default ${d.default} is not an integer`);
    if (d.min !== undefined && d.default < d.min) bad(`default ${d.default} is below min ${d.min}`);
    if (d.max !== undefined && d.default > d.max) bad(`default ${d.default} is above max ${d.max}`);
  });

const pointDescriptor = z.strictObject({
  type: z.literal("point"),
  description,
  default: z.tuple([axis, axis]),
  animatable: z.boolean().optional(),
});

const colorDescriptor = z.strictObject({
  type: z.literal("color"),
  description,
  default: ColorValueSchema,
  animatable: z.boolean().optional(),
});

const stringDescriptor = z
  .strictObject({
    type: z.literal("string"),
    description,
    default: z.string(),
    maxLength: z.number().int().min(1).max(MAX_STRING_LENGTH),
  })
  .superRefine((d, ctx) => {
    if (d.default.length > d.maxLength)
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: `default is ${d.default.length} characters, over maxLength ${d.maxLength}`,
      });
  });

const booleanDescriptor = z.strictObject({
  type: z.literal("boolean"),
  description,
  default: z.boolean(),
});

const enumDescriptor = z
  .strictObject({
    type: z.literal("enum"),
    description,
    values: z.array(z.string().min(1).max(64)).min(1).max(MAX_ENUM_VALUES),
    default: z.string(),
  })
  .superRefine((d, ctx) => {
    if (new Set(d.values).size !== d.values.length)
      ctx.addIssue({ code: "custom", path: ["values"], message: "values must be unique" });
    if (!d.values.includes(d.default))
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: `default '${d.default}' is not one of the values: ${d.values.join(", ")}`,
      });
  });

const assetDescriptor = z.strictObject({
  type: z.literal("asset"),
  description,
  assetType: z.enum(["image", "video"]),
  default: z.null(),
});

/** Describes one prop of a component. Plain JSON data, so it can be listed to agents and stored as is. */
export const PropDescriptorSchema = z.discriminatedUnion("type", [
  numberDescriptor,
  pointDescriptor,
  colorDescriptor,
  stringDescriptor,
  booleanDescriptor,
  enumDescriptor,
  assetDescriptor,
]);
export type PropDescriptor = z.infer<typeof PropDescriptorSchema>;
export type PropType = PropDescriptor["type"];
