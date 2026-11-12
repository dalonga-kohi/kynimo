import { builtInRegistry, ComponentPropError, resolveProps } from "@kynimo/components";
import { IntentError, resolveStyle } from "@kynimo/intent";
import { ComponentLayerSchema, type Op, type Project, withLayerDefaults } from "@kynimo/scene";
import type { z } from "zod";
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
): { ops: Op[]; resolved: object } {
  const versions = builtInRegistry.list().filter((def) => def.id === input.component_id);
  const latest = versions.at(-1);
  if (latest === undefined)
    throw new IntentError(
      ["component_id"],
      `unknown built-in component '${input.component_id}'; see list_components`,
    );
  const version = input.component_version ?? latest.version;
  const definition = builtInRegistry.get(input.component_id, version);
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
