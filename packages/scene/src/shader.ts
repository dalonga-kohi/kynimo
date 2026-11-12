import { z } from "zod";
import { animatable } from "./keyframes.js";
import { NameSchema, SemverSchema } from "./primitives.js";

export const MAX_SHADER_SOURCE = 4096;
export const MAX_SHADER_UNIFORMS = 8;
export const MAX_SHADER_VALUE = 1_000_000;
export const MAX_PROJECT_DEFINITIONS = 64;

export const ShaderIdSchema = z.string().regex(/^custom-[a-z0-9][a-z0-9_-]{0,56}$/);
export const ShaderUniformNameSchema = z.string().regex(/^u_[a-z][a-zA-Z0-9_]{0,30}$/);
export const DefinitionHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ShaderKindSchema = z.enum(["generator", "effect"]);

const scalar = z.number().min(-MAX_SHADER_VALUE).max(MAX_SHADER_VALUE);
const vector = z.array(scalar);
const UniformValueSchema = z.union([scalar, vector.min(2).max(4)]);
export type ShaderUniformValue = z.infer<typeof UniformValueSchema>;

export const ShaderUniformSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("float"), default: scalar }),
  z.strictObject({ type: z.literal("vec2"), default: vector.length(2) }),
  z.strictObject({ type: z.literal("vec3"), default: vector.length(3) }),
  z.strictObject({ type: z.literal("vec4"), default: vector.length(4) }),
]);
export type ShaderUniform = z.infer<typeof ShaderUniformSchema>;

const boundedUniforms = <T extends z.ZodType>(value: T) =>
  z
    .record(ShaderUniformNameSchema, value)
    .refine((uniforms) => Object.keys(uniforms).length <= MAX_SHADER_UNIFORMS, {
      message: `at most ${MAX_SHADER_UNIFORMS} shader uniforms`,
    });

export const ShaderDefinitionMetadataSchema = z.strictObject({
  id: ShaderIdSchema,
  version: SemverSchema.max(64),
  title: NameSchema,
  kind: ShaderKindSchema,
  uniforms: boundedUniforms(ShaderUniformSchema),
});

export const ShaderDefinitionInputSchema = ShaderDefinitionMetadataSchema.extend({
  source: z.string().min(1).max(MAX_SHADER_SOURCE),
});
export type ShaderDefinitionInput = z.infer<typeof ShaderDefinitionInputSchema>;

export const ShaderDefinitionSchema = ShaderDefinitionInputSchema.extend({
  hash: DefinitionHashSchema,
});
export type ShaderDefinition = z.infer<typeof ShaderDefinitionSchema>;
export const ShaderDefinitionSummarySchema = ShaderDefinitionSchema.omit({ source: true });
export type ShaderDefinitionSummary = z.infer<typeof ShaderDefinitionSummarySchema>;

export const CustomShaderSchema = z.strictObject({
  type: z.literal("custom-shader"),
  shaderId: ShaderIdSchema,
  shaderVersion: SemverSchema.max(64),
  uniforms: boundedUniforms(animatable(UniformValueSchema)),
});
export type CustomShader = z.infer<typeof CustomShaderSchema>;
