import { z } from "zod";
import { AssetSchema } from "./asset.js";
import { CompositionSchema } from "./composition.js";
import { CompositionIdSchema, ID_PATTERN } from "./ids.js";
import type { Layer } from "./layer.js";
import { NameSchema } from "./primitives.js";
import type { ShapeItem } from "./shape.js";
import { SCENE_FORMAT_VERSION } from "./version.js";

/**
 * The guideline pack this document is pinned to. Token values resolve against this
 * exact version, so publishing a new pack version never changes an existing document.
 */
export const StyleRefSchema = z.strictObject({
  packId: z.string().regex(ID_PATTERN),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "must be a semantic version like 1.0.0"),
});
export type StyleRef = z.infer<typeof StyleRefSchema>;

const ProjectShape = z.strictObject({
  formatVersion: z.literal(SCENE_FORMAT_VERSION),
  name: NameSchema,
  /** The composition that is exported; scenes are compositions placed in it as precomp layers. */
  mainCompositionId: CompositionIdSchema,
  style: StyleRefSchema.nullable(),
  assets: z.array(AssetSchema),
  compositions: z.array(CompositionSchema).min(1),
});

type Project = z.infer<typeof ProjectShape>;

function* shapeItemIds(items: readonly ShapeItem[]): Generator<string> {
  for (const it of items) {
    yield it.id;
    if (it.type === "group") yield* shapeItemIds(it.items);
  }
}

function hasTransform(layer: Layer): layer is Exclude<Layer, { type: "audio" }> {
  return layer.type !== "audio";
}

/**
 * Cross-reference checks that a field-level schema cannot express. Every message
 * names the location and the change that fixes it, so an agent can act on it.
 */
function checkIntegrity(project: Project, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });

  const assetsById = new Map(project.assets.map((a) => [a.id as string, a]));
  const compositionIds = new Set<string>();

  project.assets.forEach((asset, i) => {
    if (project.assets.findIndex((a) => a.id === asset.id) !== i)
      issue(
        ["assets", i, "id"],
        `duplicate asset id '${asset.id}'; asset ids must be unique, rename one`,
      );
  });

  project.compositions.forEach((comp, i) => {
    if (compositionIds.has(comp.id))
      issue(
        ["compositions", i, "id"],
        `duplicate composition id '${comp.id}'; composition ids must be unique, rename one`,
      );
    compositionIds.add(comp.id);
  });

  if (!compositionIds.has(project.mainCompositionId))
    issue(
      ["mainCompositionId"],
      `main composition '${project.mainCompositionId}' does not exist; set it to one of: ${[...compositionIds].join(", ")}`,
    );

  const seenLayerIds = new Set<string>();

  project.compositions.forEach((comp, ci) => {
    const layerById = new Map(comp.layers.map((l) => [l.id as string, l]));

    comp.layers.forEach((layer, li) => {
      const at = (...rest: (string | number)[]) => ["compositions", ci, "layers", li, ...rest];

      if (seenLayerIds.has(layer.id))
        issue(
          at("id"),
          `duplicate layer id '${layer.id}'; layer ids are unique across the whole project, rename one`,
        );
      seenLayerIds.add(layer.id);

      if (layer.inFrame >= layer.outFrame)
        issue(
          at("outFrame"),
          `outFrame (${layer.outFrame}) must be greater than inFrame (${layer.inFrame})`,
        );

      if (hasTransform(layer) && layer.parent !== null) {
        const parent = layerById.get(layer.parent);
        if (parent === undefined)
          issue(
            at("parent"),
            `parent '${layer.parent}' is not a layer in composition '${comp.id}'; set parent to null or an existing layer id`,
          );
        else if (parent.type === "audio")
          issue(
            at("parent"),
            `parent '${layer.parent}' is an audio layer; audio layers cannot be parents`,
          );
      }

      switch (layer.type) {
        case "image":
        case "audio": {
          const asset = assetsById.get(layer.assetId);
          if (asset === undefined)
            issue(
              at("assetId"),
              `asset '${layer.assetId}' does not exist; add the asset or use an existing asset id`,
            );
          else if (asset.type !== layer.type)
            issue(
              at("assetId"),
              `asset '${layer.assetId}' is ${asset.type}, but this is a ${layer.type} layer; use a ${layer.type} asset`,
            );
          break;
        }
        case "precomp":
          if (!compositionIds.has(layer.compositionId))
            issue(
              at("compositionId"),
              `composition '${layer.compositionId}' does not exist; use an existing composition id`,
            );
          break;
        case "shape": {
          const seenItems = new Set<string>();
          for (const itemId of shapeItemIds(layer.contents)) {
            if (seenItems.has(itemId))
              issue(
                at("contents"),
                `duplicate shape item id '${itemId}' in layer '${layer.id}'; item ids are unique within a layer, rename one`,
              );
            seenItems.add(itemId);
          }
          break;
        }
        default:
          break;
      }
    });

    // Parent cycles: report each cycle once, on its first member in layer order.
    const reported = new Set<string>();
    comp.layers.forEach((layer, li) => {
      if (!hasTransform(layer) || reported.has(layer.id)) return;
      const chain: string[] = [layer.id];
      let current: Layer | undefined = layer;
      while (current !== undefined && hasTransform(current) && current.parent !== null) {
        const next: Layer | undefined = layerById.get(current.parent);
        if (next === undefined) break;
        if (next.id === layer.id) {
          for (const id of chain) reported.add(id);
          issue(
            ["compositions", ci, "layers", li, "parent"],
            `parenting cycle: ${[...chain, layer.id].join(" -> ")}; set parent to null on one of these layers`,
          );
          break;
        }
        if (chain.includes(next.id)) break; // cycle not involving this layer; reported from its own member
        chain.push(next.id);
        current = next;
      }
    });
  });
}

export const ProjectSchema = ProjectShape.superRefine(checkIntegrity);
export type { Project };
