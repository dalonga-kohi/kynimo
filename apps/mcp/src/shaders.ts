import { indexShaderDefinitions, validateShader } from "@kynimo/engine";
import {
  type CustomShader,
  MAX_PROJECT_DEFINITIONS,
  type OpError,
  type Project,
  type ShaderDefinition,
  type ShaderDefinitionInput,
  ShaderDefinitionSchema,
  type ShaderDefinitionSummary,
} from "@kynimo/scene";
import { fingerprint } from "./hash.js";

export function shaderHash({ id: _id, version: _version, ...content }: ShaderDefinitionInput) {
  return fingerprint(content);
}

export function shaderSummary({
  source: _source,
  ...summary
}: ShaderDefinition): ShaderDefinitionSummary {
  return summary;
}

const storedShaders = ShaderDefinitionSchema.array().max(MAX_PROJECT_DEFINITIONS);

export function verifiedShaders(records: ShaderDefinition[]): ShaderDefinition[] {
  return storedShaders.parse(records).map((definition) => {
    const { hash, ...content } = definition;
    if (shaderHash(content) !== hash)
      throw new Error("stored shader definition failed its content hash");
    return definition;
  });
}

export function* shaderBindings(doc: Project): Generator<{
  instance: CustomShader;
  kind: ShaderDefinition["kind"];
  path: OpError["path"];
}> {
  for (const [c, composition] of doc.compositions.entries()) {
    for (const [l, layer] of composition.layers.entries()) {
      const path = ["compositions", c, "layers", l];
      if (layer.type === "generator" && layer.generator.type === "custom-shader")
        yield { instance: layer.generator, kind: "generator", path: [...path, "generator"] };
      if (layer.type === "audio" || layer.type === "null") continue;
      for (const [e, effect] of layer.effects.entries())
        if (effect.type === "custom-shader")
          yield { instance: effect, kind: "effect", path: [...path, "effects", e] };
    }
  }
}

export async function shaderBindingError(
  doc: Project,
  load: () => Promise<ShaderDefinition[]>,
): Promise<OpError | undefined> {
  let index: ReturnType<typeof indexShaderDefinitions> | undefined;
  for (const { instance, kind, path } of shaderBindings(doc)) {
    index ??= indexShaderDefinitions(verifiedShaders(await load()));
    try {
      validateShader(instance, kind, index);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return { path, message: error.message };
    }
  }
  return undefined;
}
