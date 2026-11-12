import {
  type CustomShader,
  type FrameRate,
  MAX_SHADER_VALUE,
  type ShaderDefinition,
  type ShaderUniformValue,
} from "@kynimo/scene";
import { sampleTrack } from "./track.js";

export type ShaderDefinitions = ReadonlyMap<string, ShaderDefinition>;
export const shaderDefinitionKey = (id: string, version: string) => `${id}@${version}`;

export function indexShaderDefinitions(
  definitions: readonly ShaderDefinition[],
): ShaderDefinitions {
  return new Map(definitions.map((def) => [shaderDefinitionKey(def.id, def.version), def]));
}

export interface ResolvedShader {
  type: "custom-shader";
  definition: ShaderDefinition;
  frame: number;
  fps: number;
  seed: number;
  /** Values in ascending GLSL uniform name order. */
  uniforms: number[][];
}

export type ResolveShader = (
  instance: CustomShader,
  kind: ShaderDefinition["kind"],
) => ResolvedShader;

const vector = (value: ShaderUniformValue): readonly number[] =>
  typeof value === "number" ? [value] : value;

function checkWidth(value: ShaderUniformValue, sample: ShaderUniformValue, name: string): void {
  if (vector(value).length !== vector(sample).length)
    throw new RangeError(`shader uniform '${name}' must match the type in the definition`);
}

export function shaderDefinition(
  instance: CustomShader,
  kind: ShaderDefinition["kind"],
  definitions?: ShaderDefinitions,
): ShaderDefinition {
  const key = shaderDefinitionKey(instance.shaderId, instance.shaderVersion);
  const def = definitions?.get(key);
  if (def === undefined) throw new RangeError(`missing shader definition '${key}'`);
  if (def.kind !== kind) throw new RangeError(`shader '${key}' is defined as a ${def.kind}`);
  for (const name of Object.keys(instance.uniforms))
    if (!Object.hasOwn(def.uniforms, name))
      throw new RangeError(`shader '${key}' has no uniform '${name}'`);
  return def;
}

/** Checks every authored value, including the keyframes outside the current render range. */
export function validateShader(
  instance: CustomShader,
  kind: ShaderDefinition["kind"],
  definitions: ShaderDefinitions,
): void {
  const def = shaderDefinition(instance, kind, definitions);
  for (const [name, { default: fallback }] of Object.entries(def.uniforms)) {
    const track = instance.uniforms[name];
    if (track === undefined) continue;
    if ("value" in track) checkWidth(track.value, fallback, name);
    else for (const keyframe of track.keyframes) checkWidth(keyframe.value, fallback, name);
  }
}

export function resolveShader(
  instance: CustomShader,
  kind: ShaderDefinition["kind"],
  definitions: ShaderDefinitions | undefined,
  frame: number,
  fps: FrameRate,
  seed: number,
): ResolvedShader {
  const definition = shaderDefinition(instance, kind, definitions);
  const uniforms = Object.entries(definition.uniforms)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, { default: fallback }]) => {
      const track = instance.uniforms[name];
      if (track === undefined) return [...vector(fallback)];
      return sampleTrack(track, frame, fps, (from, to, progress) => {
        checkWidth(from, fallback, name);
        checkWidth(to, fallback, name);
        const a = vector(from);
        const b = vector(to);
        return a.map((value, i) =>
          Math.max(
            -MAX_SHADER_VALUE,
            Math.min(MAX_SHADER_VALUE, value + ((b[i] ?? value) - value) * progress),
          ),
        );
      });
    });
  return { type: "custom-shader", definition, frame, fps: fps.num / fps.den, seed, uniforms };
}
