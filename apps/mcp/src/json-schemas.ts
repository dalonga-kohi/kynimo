import { LayerSchema, OpSchema, ProjectSchema } from "@kynimo/scene";
import { z } from "zod";
import type { LAYER_TYPES } from "./schemas.js";
import { ToolError } from "./service.js";

type JsonSchema = Record<string, unknown>;

/** Input-side JSON Schema with `$ref` reuse: what an agent writes, not what the store returns. */
const toJson = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { reused: "ref", io: "input" }) as JsonSchema;

const once = <T>(make: () => T): (() => T) => {
  let value: T | undefined;
  return () => {
    value ??= make();
    return value;
  };
};

/** A whole project document (`kynimo://schema/scene`). */
export const sceneJsonSchema = once(() => toJson(ProjectSchema));

/** One scene operation, the item type of `apply_ops.ops` (`kynimo://schema/ops`). */
export const opJsonSchema = once(() => toJson(OpSchema));

/** Schemas for `get_layer_schema` and `kynimo://schema/layer/{type}`: a layer type without its id. */
const layerSchemaCache = new Map<string, JsonSchema>();
export function layerJsonSchema(type: (typeof LAYER_TYPES)[number]): JsonSchema {
  let schema = layerSchemaCache.get(type);
  if (!schema) {
    const option = LayerSchema.options.find((o) => o.shape.type.value === type);
    if (!option) throw new ToolError("invalid", `unknown layer type '${type}'`);
    // Every option is a plain object schema; the cast only picks one `omit` signature from the union.
    schema = toJson((option as unknown as z.ZodObject<z.ZodRawShape>).omit({ id: true }));
    layerSchemaCache.set(type, schema);
  }
  return schema;
}
