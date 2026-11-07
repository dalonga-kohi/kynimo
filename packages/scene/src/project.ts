import { z } from "zod";
import { AssetSchema } from "./asset.js";
import { CompositionSchema, isValidFrameRate } from "./composition.js";
import { BUNDLED_FONT_FAMILIES, isBundledFontFamily } from "./fonts.js";
import { CompositionIdSchema, ID_PATTERN } from "./ids.js";
import type { Keyframe } from "./keyframes.js";
import type { Layer } from "./layer.js";
import { SPRING_DAMPING, SPRING_RESPONSE } from "./limits.js";
import { NameSchema, SemverSchema } from "./primitives.js";
import type { ShapeItem } from "./shape.js";
import { type FrameRate, springSettleFrames } from "./spring.js";
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

/** The bundled family `family` names, ignoring case, if any. */
const bundledFamilyLike = (family: string) =>
  BUNDLED_FONT_FAMILIES.find((f) => f.toLowerCase() === family.toLowerCase());

type Issue = (path: Path, message: string) => void;

/** Layer fields that hold free-form data rather than schema-defined tracks; the structural walk skips them. */
const FREE_FORM_LAYER_KEYS: ReadonlySet<string> = new Set(["props"]);

const inRange = (n: number, r: { min: number; max: number }) => n >= r.min && n <= r.max;

/**
 * Spring rule: a spring segment lasts `springSettleFrames` frames, so the next keyframe must sit at or
 * after that frame. Tracks are found structurally (any object with a `keyframes` array), so properties
 * added later are checked automatically; free-form fields are skipped and every element is guarded.
 * Springs whose parameters are out of range are left to their own range issue.
 */
function checkSprings(layer: Layer, fps: FrameRate, base: Path, issue: Issue): void {
  const settleCache = new Map<string, number>();
  const settleFrames = (s: { damping: number; response: number }) => {
    const key = `${s.damping}/${s.response}`;
    let frames = settleCache.get(key);
    if (frames === undefined) {
      frames = springSettleFrames(s, fps);
      settleCache.set(key, frames);
    }
    return frames;
  };

  const stack: { node: unknown; path: Path }[] = [{ node: layer, path: base }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined || typeof item.node !== "object" || item.node === null) continue;
    const node = item.node as Record<string, unknown>;
    if (Array.isArray(node.keyframes)) {
      const keyframes = node.keyframes as unknown[];
      keyframes.forEach((raw, i) => {
        const kf = raw as Partial<Keyframe<unknown>> | null;
        const next = keyframes[i + 1] as Partial<Keyframe<unknown>> | null | undefined;
        const spring = kf?.interpolation;
        if (
          spring?.type !== "spring" ||
          typeof kf?.frame !== "number" ||
          typeof next?.frame !== "number" ||
          !inRange(spring.damping, SPRING_DAMPING) ||
          !inRange(spring.response, SPRING_RESPONSE)
        )
          return;
        const settle = kf.frame + settleFrames(spring);
        if (next.frame < settle)
          issue(
            [...item.path, "keyframes", i + 1, "frame"],
            `keyframe at frame ${next.frame} follows a spring that settles at frame ${settle}; move it to frame ${settle} or later, or change the previous keyframe's interpolation to bezier`,
          );
      });
      continue; // keyframe values hold no further tracks
    }
    for (const [key, child] of Object.entries(node)) {
      if (item.path.length === base.length && FREE_FORM_LAYER_KEYS.has(key)) continue;
      stack.push({ node: child, path: [...item.path, Array.isArray(node) ? Number(key) : key] });
    }
  }
}

/** Precomps may not reference themselves, directly or through other compositions. Iterative, linear time. */
function checkPrecompCycles(project: Project, issue: Issue): void {
  type Edge = { target: string; path: Path };
  const edges = new Map<string, Edge[]>();
  const known = new Set(project.compositions.map((c) => c.id as string));
  project.compositions.forEach((comp, ci) => {
    const list: Edge[] = [];
    comp.layers.forEach((layer, li) => {
      if (layer.type === "precomp" && known.has(layer.compositionId))
        list.push({
          target: layer.compositionId,
          path: ["compositions", ci, "layers", li, "compositionId"],
        });
    });
    edges.set(comp.id, list);
  });

  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = finished
  const position = new Map<string, number>(); // index of each on-path composition, for O(1) cycle lookup
  for (const root of known) {
    if (state.has(root)) continue;
    const path: string[] = [root];
    const cursor: number[] = [0];
    state.set(root, 1);
    position.set(root, 0);
    while (path.length > 0) {
      const node = path[path.length - 1] as string;
      const index = cursor[cursor.length - 1] as number;
      const out = edges.get(node) ?? [];
      if (index >= out.length) {
        state.set(node, 2);
        position.delete(node);
        path.pop();
        cursor.pop();
        continue;
      }
      cursor[cursor.length - 1] = index + 1;
      const edge = out[index] as Edge;
      const seen = state.get(edge.target);
      if (seen === 1) {
        const start = position.get(edge.target) ?? 0;
        const size = path.length - start;
        // Bounded message: listing the whole loop for every closing layer would grow faster than the input.
        const ids = path.slice(start, start + 6).join(" -> ");
        const shown = size > 6 ? `${ids} -> ... -> ${edge.target}` : `${ids} -> ${edge.target}`;
        issue(
          edge.path,
          `precomp cycle (${size} ${size === 1 ? "composition" : "compositions"}): ${shown}; point this layer at a different composition or delete it`,
        );
      } else if (seen === undefined) {
        state.set(edge.target, 1);
        position.set(edge.target, path.length);
        path.push(edge.target);
        cursor.push(0);
      }
    }
  }
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

  // Font assets: a family is either bundled or uploaded, and each weight comes from one file.
  const fontFamilies = new Set<string>();
  project.assets.forEach((asset, i) => {
    if (asset.type !== "font") return;
    fontFamilies.add(asset.family);
    const bundled = bundledFamilyLike(asset.family);
    if (bundled !== undefined) {
      issue(
        ["assets", i, "family"],
        `'${asset.family}' is the bundled font family '${bundled}' (names are compared ignoring case); give the uploaded font another family name`,
      );
      return;
    }
    const clash = project.assets.findIndex(
      (other, j) =>
        j < i &&
        other.type === "font" &&
        other.family === asset.family &&
        other.weight.min <= asset.weight.max &&
        asset.weight.min <= other.weight.max,
    );
    if (clash !== -1)
      issue(
        ["assets", i, "weight"],
        `font asset '${asset.id}' covers weights that font asset '${project.assets[clash]?.id}' of family '${asset.family}' already covers; make the weight ranges disjoint`,
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
  const seenMarkerIds = new Set<string>();

  project.compositions.forEach((comp, ci) => {
    const layerById = new Map(comp.layers.map((l) => [l.id as string, l]));

    comp.layers.forEach((layer, li) => {
      const at = (...rest: (string | number)[]) => ["compositions", ci, "layers", li, ...rest];

      if (isValidFrameRate(comp.fps)) checkSprings(layer, comp.fps, at(), issue);

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
        case "text": {
          const family = layer.font.family;
          if (!isBundledFontFamily(family) && !fontFamilies.has(family)) {
            const uploaded = [...fontFamilies].sort();
            const near = [...BUNDLED_FONT_FAMILIES, ...uploaded].find(
              (f) => f.toLowerCase() === family.toLowerCase(),
            );
            issue(
              at("font", "family"),
              `font family '${family}' is neither bundled (${BUNDLED_FONT_FAMILIES.join(", ")}) nor a font asset of this project (${uploaded.length > 0 ? uploaded.join(", ") : "none"})${near === undefined ? "" : `; did you mean '${near}'?`} Use one of those or add a font asset`,
            );
          }
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

  checkPrecompCycles(project, issue);
}

export const ProjectSchema = ProjectShape.superRefine(checkIntegrity);
export type { Project };
