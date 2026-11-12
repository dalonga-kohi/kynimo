import { stripTypeScriptTypes } from "node:module";
import {
  builtInRegistry,
  COMPONENT_PROGRAM_LIMITS,
  type ComponentDefinitionInput,
  type ComponentDefinitionSummary,
  type ComponentProjectDefinition,
  ComponentProjectDefinitionSchema,
  ComponentPropError,
  compileComponentProgram,
  MAX_PROJECT_COMPONENT_DEFINITIONS,
  resolveProps,
} from "@kynimo/components";
import { IntentError, resolveStyle } from "@kynimo/intent";
import {
  ComponentLayerSchema,
  type Op,
  type OpError,
  type Project,
  withLayerDefaults,
} from "@kynimo/scene";
import type { z } from "zod";
import { fingerprint } from "./hash.js";
import type { AddComponentRequest, ListComponentsOutput } from "./schemas.js";

export function componentCatalog(): z.infer<typeof ListComponentsOutput> {
  return {
    components: builtInRegistry.list().map(({ id, version, title, description, props }) => ({
      id,
      version,
      title,
      description,
      props,
    })),
  };
}

const ComponentLayerInput = ComponentLayerSchema.omit({ id: true });

export function addComponentExpansion(
  doc: Project,
  input: z.infer<typeof AddComponentRequest>,
  definitions: readonly ComponentDefinitionSummary[] = [],
): { ops: Op[]; resolved: object } {
  const versions = [...builtInRegistry.list(), ...definitions].filter(
    (def) => def.id === input.component_id,
  );
  const latest = versions.at(-1);
  if (latest === undefined)
    throw new IntentError(
      ["component_id"],
      `unknown component '${input.component_id}'; see list_components and list_definitions`,
    );
  const version = input.component_version ?? latest.version;
  const definition = versions.find((candidate) => candidate.version === version);
  if (definition === undefined) {
    const preview = version.length > 64 ? `${version.slice(0, 61)}...` : version;
    throw new IntentError(
      ["component_version"],
      `component '${input.component_id}' has no version '${preview}'; available: ${versions.map((def) => def.version).join(", ")}`,
    );
  }

  const compositionId = input.composition ?? doc.mainCompositionId;
  const composition = doc.compositions.find((comp) => comp.id === compositionId);
  if (composition === undefined)
    throw new IntentError(["composition"], `unknown composition '${compositionId}'; see get_scene`);

  const inFrame = input.in_frame ?? 0;
  const outFrame = input.out_frame ?? composition.durationFrames;
  if (inFrame >= composition.durationFrames)
    throw new IntentError(
      ["in_frame"],
      `must be before the end of the composition (frame ${composition.durationFrames})`,
    );
  if (outFrame <= inFrame || outFrame > composition.durationFrames)
    throw new IntentError(
      ["out_frame"],
      `must be after in_frame (${inFrame}) and at most ${composition.durationFrames}`,
    );

  const layer = ComponentLayerInput.parse(
    withLayerDefaults(
      {
        type: "component",
        componentId: definition.id,
        componentVersion: definition.version,
        props: input.props ?? {},
        name: input.name ?? definition.title,
        inFrame,
        outFrame,
        startFrame: inFrame,
        // The component already lays out its subtree in composition coordinates.
        transform: { position: { value: [0, 0] } },
      },
      composition,
    ),
  );

  const { pack } = resolveStyle(doc);
  try {
    // This checks every keyframe value. The scene keeps the original props and style roles.
    resolveProps(definition.props, layer.props, {
      who: `component '${definition.id}@${definition.version}'`,
      assets: doc.assets,
      pack,
      frame: 0,
      fps: composition.fps,
    });
  } catch (error) {
    if (error instanceof ComponentPropError)
      throw new IntentError(["props", ...error.path], error.message);
    throw error;
  }

  return {
    ops: [
      {
        op: "addLayer",
        composition: composition.id,
        layer,
        ...(input.layer_id === undefined ? {} : { id: input.layer_id }),
        ...(input.index === undefined ? {} : { index: input.index }),
      },
    ],
    resolved: {
      component_id: definition.id,
      component_version: definition.version,
      composition: composition.id,
      in_frame: inFrame,
      out_frame: outFrame,
      index: input.index ?? 0,
    },
  };
}

export const projectComponentId = (id: string) => id.startsWith("custom-");

export const componentKey = (id: string, version: string) => `${id}@${version}`;

export function componentHash({
  id: _id,
  version: _version,
  ...content
}: Omit<ComponentProjectDefinition, "hash">) {
  return fingerprint(content);
}

export function componentSummary({
  source: _source,
  program: _program,
  ...content
}: ComponentProjectDefinition): ComponentDefinitionSummary {
  return { ...content, kind: "component" };
}

const storedComponents = ComponentProjectDefinitionSchema.array().max(
  MAX_PROJECT_COMPONENT_DEFINITIONS,
);

export function verifiedComponents(
  records: ComponentProjectDefinition[],
): ComponentProjectDefinition[] {
  return storedComponents.parse(records).map((definition) => {
    const { hash, ...input } = definition;
    if (componentHash(input) !== hash)
      throw new Error("stored component definition failed its content hash");
    return definition;
  });
}

export function compileComponentSource(input: ComponentDefinitionInput): string {
  const sourceBytes = COMPONENT_PROGRAM_LIMITS.sourceBytes;
  if (Buffer.byteLength(input.source, "utf8") > sourceBytes)
    throw new RangeError(`component source exceeds ${sourceBytes} UTF-8 bytes`);
  const program = stripTypeScriptTypes(input.source, { mode: "strip" });
  compileComponentProgram(program, input.props);
  return program;
}

/** Compare stable versions numerically, including arbitrarily large digits permitted by the scene. */
export function compareComponentVersions(
  left: ComponentProjectDefinition,
  right: ComponentProjectDefinition,
) {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  const a = left.version.split(".");
  const b = right.version.split(".");
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? "0";
    const y = b[i] ?? "0";
    if (x.length !== y.length) return x.length - y.length;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function* componentBindings(doc: Project) {
  for (const [c, composition] of doc.compositions.entries())
    for (const [l, layer] of composition.layers.entries())
      if (layer.type === "component" && projectComponentId(layer.componentId))
        yield { layer, composition, path: ["compositions", c, "layers", l] };
}

export async function componentBindingError(
  doc: Project,
  load: () => Promise<ComponentProjectDefinition[]>,
): Promise<OpError | undefined> {
  let index: Map<string, ComponentProjectDefinition> | undefined;
  for (const { layer, composition, path } of componentBindings(doc)) {
    index ??= new Map(
      verifiedComponents(await load()).map((definition) => [
        componentKey(definition.id, definition.version),
        definition,
      ]),
    );
    const pin = componentKey(layer.componentId, layer.componentVersion);
    const definition = index.get(pin);
    if (definition === undefined)
      return {
        path: [...path, "componentVersion"],
        message: `unknown project component '${pin}'; see list_definitions`,
      };
    try {
      const { pack } = resolveStyle(doc);
      resolveProps(definition.props, layer.props, {
        who: `component '${pin}' on layer '${layer.id}'`,
        assets: doc.assets,
        pack,
        frame: 0,
        fps: composition.fps,
      });
    } catch (error) {
      if (error instanceof ComponentPropError)
        return { path: [...path, "props", ...error.path], message: error.message };
      if (error instanceof IntentError) return { path: ["style"], message: error.message };
      throw error;
    }
  }
  return undefined;
}
