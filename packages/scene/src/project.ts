import { z } from "zod";
import { AssetSchema } from "./asset.js";
import { CompositionSchema } from "./composition.js";
import { CompositionIdSchema, ID_PATTERN } from "./ids.js";
import type { Layer } from "./layer.js";
import { NameSchema, SemverSchema } from "./primitives.js";
import type { ShapeItem } from "./shape.js";
import { SCENE_FORMAT_VERSION } from "./version.js";

/**
 * The guideline pack this document is pinned to. Token values resolve against this
 * exact version, so publishing a new pack version never changes an existing document.
 */
export const StyleRefSchema = z.strictObject({
  packId: z.string().regex(ID_PATTERN),
  version: SemverSchema,
});
export type StyleRef = z.infer<typeof StyleRefSchema>;

const ProjectShape = z.strictObject({
  formatVersion: z.literal(SCENE_FORMAT_VERSION),
  name: NameSchema,
  /** The composition that is exported; scenes are compositions placed in it as precomp layers. */
  mainCompositionId: CompositionIdSchema,
  style: StyleRefSchema.nullable(),
  assets: z.array(AssetSchema).max(1000),
  compositions: z.array(CompositionSchema).min(1).max(200),
});

type Project = z.infer<typeof ProjectShape>;

type Path = (string | number)[];

/** Yields every shape item id with its path relative to the layer, e.g. ["contents", 1, "items", 0, "id"]. */
function* shapeItemIds(
  items: readonly ShapeItem[],
  base: Path,
): Generator<{ id: string; path: Path }> {
  for (const [i, it] of items.entries()) {
    yield { id: it.id, path: [...base, i, "id"] };
    if (it.type === "group") yield* shapeItemIds(it.items, [...base, i, "items"]);
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

  const seenAssets = new Set<string>();
  project.assets.forEach((asset, i) => {
    if (seenAssets.has(asset.id))
      issue(
        ["assets", i, "id"],
        `duplicate asset id '${asset.id}'; asset ids must be unique, rename one`,
      );
    seenAssets.add(asset.id);
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
  const seenMarkerIds = new Set<string>();

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
          for (const { id: itemId, path } of shapeItemIds(layer.contents, ["contents"])) {
            if (seenItems.has(itemId))
              issue(
                at(...path),
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

    // Marker ids are unique across the project.
    const checkMarkers = (markers: readonly { id: string }[], path: Path) =>
      markers.forEach((m, mi) => {
        if (seenMarkerIds.has(m.id))
          issue(
            [...path, mi, "id"],
            `duplicate marker id '${m.id}'; marker ids are unique across the whole project, rename one`,
          );
        seenMarkerIds.add(m.id);
      });
    checkMarkers(comp.markers, ["compositions", ci, "markers"]);
    for (const [li, layer] of comp.layers.entries())
      checkMarkers(layer.markers, ["compositions", ci, "layers", li, "markers"]);

    // Parent cycles, linear time. Each layer has at most one parent, so walk each unvisited chain once:
    // reaching a layer that is on the current walk closes a cycle. Reported once, on its first member in layer order.
    const indexOf = new Map(comp.layers.map((l, i) => [l.id as string, i]));
    const state = new Map<string, 1 | 2>(); // 1 = on the current walk, 2 = finished
    for (const start of comp.layers) {
      if (state.has(start.id)) continue;
      const walk: string[] = [];
      let current: string | null = start.id;
      while (current !== null) {
        const seen = state.get(current);
        if (seen === 2) break;
        if (seen === 1) {
          const cycle = walk.slice(walk.indexOf(current));
          const first = cycle.reduce((a, b) =>
            (indexOf.get(b) ?? 0) < (indexOf.get(a) ?? 0) ? b : a,
          );
          const at = cycle.indexOf(first);
          const ordered = [...cycle.slice(at), ...cycle.slice(0, at)];
          issue(
            ["compositions", ci, "layers", indexOf.get(first) ?? 0, "parent"],
            `parenting cycle: ${[...ordered, first].join(" -> ")}; set parent to null on one of these layers`,
          );
          break;
        }
        state.set(current, 1);
        walk.push(current);
        const layer = layerById.get(current);
        current = layer !== undefined && hasTransform(layer) ? layer.parent : null;
      }
      for (const id of walk) state.set(id, 2);
    }
  });
}

export const ProjectSchema = ProjectShape.superRefine(checkIntegrity);
export type { Project };
