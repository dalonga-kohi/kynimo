import { DefinitionHashSchema, ID_PATTERN, NameSchema, SemverSchema } from "@kynimo/scene";
import { z } from "zod";
import { MAX_PROPS_PER_COMPONENT, PROP_NAME_PATTERN, PropDescriptorSchema } from "../props.js";
import { COMPONENT_PROGRAM_LIMITS } from "./runtime.js";

export const MAX_PROJECT_COMPONENT_DEFINITIONS = 64;

export const ProjectComponentIdSchema = z
  .string()
  .regex(ID_PATTERN)
  .regex(/^custom-[a-z0-9]/, "project component ids must start with custom-");

const propName = z
  .string()
  .regex(PROP_NAME_PATTERN)
  .refine((name) => name !== "constructor" && name !== "prototype", "reserved prop name");

const props = z.preprocess(
  (value, ctx) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const keys = Object.keys(value);
    if (keys.length > MAX_PROPS_PER_COMPONENT) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${MAX_PROPS_PER_COMPONENT} component props`,
      });
    } else if (keys.includes("__proto__")) {
      // Zod deliberately discards this key while parsing records. Reject it before the record parser.
      ctx.addIssue({ code: "custom", path: ["__proto__"], message: "reserved prop name" });
    }
    return value;
  },
  z.record(propName, PropDescriptorSchema),
);

const source = z.string().min(1).max(COMPONENT_PROGRAM_LIMITS.sourceBytes);

export const ComponentDefinitionInputSchema = z.strictObject({
  id: ProjectComponentIdSchema,
  version: SemverSchema.max(64).regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    "version segments must not have leading zeroes",
  ),
  title: NameSchema,
  description: z.string().min(1).max(1000),
  props,
  source,
});
export type ComponentDefinitionInput = z.infer<typeof ComponentDefinitionInputSchema>;

export const ComponentProjectDefinitionSchema = ComponentDefinitionInputSchema.extend({
  hash: DefinitionHashSchema,
  program: source,
});
export type ComponentProjectDefinition = z.infer<typeof ComponentProjectDefinitionSchema>;

export const ComponentDefinitionSummarySchema = ComponentProjectDefinitionSchema.omit({
  source: true,
  program: true,
}).extend({ kind: z.literal("component") });
export type ComponentDefinitionSummary = z.infer<typeof ComponentDefinitionSummarySchema>;
