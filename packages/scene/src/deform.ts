import { z } from "zod";
import { DeformPinIdSchema } from "./ids.js";
import { Vec2Schema } from "./primitives.js";
import { animatable } from "./transform.js";

export const MAX_DEFORM_PINS = 32;
export const DEFORM_DENSITY = { min: 4, max: 64, default: 24 } as const;
export const DEFORM_ITERATIONS = { min: 1, max: 30, default: 10 } as const;

const DEFORMABLE_TYPES: ReadonlySet<unknown> = new Set([
  "shape",
  "text",
  "image",
  "video",
  "solid",
  "generator",
  "precomp",
  "component",
]);

/** The layer kinds with a source that can be deformed before placement. */
export const isDeformableLayerType = (type: unknown): boolean => DEFORMABLE_TYPES.has(type);

export const DeformPinSchema = z.strictObject({
  id: DeformPinIdSchema,
  /** Bind point in layer units. The renderer snaps it to a mesh vertex. */
  rest: Vec2Schema,
  /** The pin's position in layer units, sampled at the center frame. */
  position: animatable(Vec2Schema),
});
export type DeformPin = z.infer<typeof DeformPinSchema>;

export const DeformSchema = z.strictObject({
  pins: z
    .array(DeformPinSchema)
    .max(MAX_DEFORM_PINS)
    .superRefine((pins, ctx) => {
      const ids = new Set<string>();
      for (const [i, { id }] of pins.entries()) {
        if (ids.has(id))
          ctx.addIssue({
            code: "custom",
            path: [i, "id"],
            message: `duplicate deform pin id '${id}'; choose a unique id within this layer`,
          });
        ids.add(id);
      }
    }),
  density: z
    .number()
    .int()
    .min(DEFORM_DENSITY.min)
    .max(DEFORM_DENSITY.max)
    .default(DEFORM_DENSITY.default),
  iterations: z
    .number()
    .int()
    .min(DEFORM_ITERATIONS.min)
    .max(DEFORM_ITERATIONS.max)
    .default(DEFORM_ITERATIONS.default),
});
export type Deform = z.infer<typeof DeformSchema>;
