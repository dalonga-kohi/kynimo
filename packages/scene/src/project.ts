import { z } from "zod";
import { AssetSchema } from "./asset.js";
import { type Behavior, isVectorTransformProperty } from "./behavior.js";
import { CompositionSchema, isValidFrameRate } from "./composition.js";
import { BUNDLED_FONT_FAMILIES, isBundledFontFamily } from "./fonts.js";
import { CompositionIdSchema, ID_PATTERN } from "./ids.js";
import type { Keyframe } from "./keyframes.js";
import type { Layer } from "./layer.js";
import { SPRING_DAMPING, SPRING_RESPONSE } from "./limits.js";
import { NameSchema, SemverSchema } from "./primitives.js";
import type { ShapeItem } from "./shape.js";
import { type FrameRate, springSettleFrames } from "./spring.js";
import { TRANSFORM_PROPERTIES } from "./transform.js";
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

/** Layers that put pixels in the frame and so carry a blend mode, a track matte and masks. */
function isDrawn(layer: Layer): layer is Exclude<Layer, { type: "audio" | "null" | "camera" }> {
  return layer.type !== "audio" && layer.type !== "null" && layer.type !== "camera";
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
  let settleCache: Map<string, number> | undefined;
  const settleFrames = (s: { damping: number; response: number }) => {
    settleCache ??= new Map();
    const key = `${s.damping}/${s.response}`;
    let frames = settleCache.get(key);
    if (frames === undefined) {
      frames = springSettleFrames(s, fps);
      settleCache.set(key, frames);
    }
    return frames;
  };

  type Entry = { node: object; key: string | number; parent: Entry | undefined };
  const root: Entry = { node: layer, key: "", parent: undefined };
  const stack: Entry[] = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
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
        if (next.frame < settle) {
          const path: Path = [];
          for (let entry = item; entry.parent !== undefined; entry = entry.parent)
            path.push(entry.key);
          issue(
            [...base, ...path.reverse(), "keyframes", i + 1, "frame"],
            `keyframe at frame ${next.frame} follows a spring that settles at frame ${settle}; move it to frame ${settle} or later, or change the previous keyframe's interpolation to bezier`,
          );
        }
      });
      continue; // keyframe values hold no further tracks
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (typeof child !== "object" || child === null) continue;
      if (item === root && FREE_FORM_LAYER_KEYS.has(key)) continue;
      stack.push({ node: child, key: Array.isArray(node) ? Number(key) : key, parent: item });
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
 * Cycles in a per-layer link (parent, track matte), linear time. Each layer links to at most one
 * other, so walk each unvisited chain once: reaching a layer that is on the current walk closes a
 * cycle. Reported once, on its first member in layer order, with the loop starting there.
 */
function checkChainCycles(
  layers: readonly Layer[],
  next: (layer: Layer) => string | null,
  report: (layerIndex: number, loop: string[]) => void,
): void {
  if (!layers.some((layer) => next(layer) !== null)) return;
  const byId = new Map(layers.map((l) => [l.id as string, l]));
  const indexOf = new Map(layers.map((l, i) => [l.id as string, i]));
  const state = new Map<string, 1 | 2>(); // 1 = on the current walk, 2 = finished
  for (const start of layers) {
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
        report(indexOf.get(first) ?? 0, [...cycle.slice(at), ...cycle.slice(0, at), first]);
        break;
      }
      state.set(current, 1);
      walk.push(current);
      const layer = byId.get(current);
      current = layer === undefined ? null : next(layer);
    }
    for (const id of walk) state.set(id, 2);
  }
}

/** `a.position`-style name of a (layer, property) node in a link cycle. */
const linkNode = (layer: string, property: string) => `${layer}.${property}`;

/**
 * Behavior rules a field-level schema cannot express (ADR-0039): unique ids, value kinds that match
 * the property, one link / inertia / loop per direction per property, and link sources. Every
 * message names the layer and behavior and says how to fix it.
 */
function checkBehaviors(
  layer: Exclude<Layer, { type: "audio" }>,
  layerById: ReadonlyMap<string, Layer>,
  compOf: ReadonlyMap<string, string>,
  compId: string,
  at: (...rest: (string | number)[]) => Path,
  issue: Issue,
): void {
  const seen = new Set<string>();
  const perProperty = new Map<
    string,
    { link: number; inertia: number; loopIn: number; loopOut: number }
  >();
  const kindOf = (property: string) =>
    isVectorTransformProperty(property) ? "[x, y]" : "a number";
  const matches = (value: unknown, property: string) =>
    Array.isArray(value) === isVectorTransformProperty(property);
  const who = (b: Behavior) => `behavior '${b.id}' of layer '${layer.id}'`;

  layer.behaviors.forEach((b, bi) => {
    if (seen.has(b.id))
      issue(
        at("behaviors", bi, "id"),
        `duplicate behavior id '${b.id}' in layer '${layer.id}'; behavior ids are unique within a layer, rename one`,
      );
    seen.add(b.id);

    // Values that add to the property have the property's kind.
    const wrongKind = (path: Path, got: unknown, field: string) =>
      issue(
        at("behaviors", bi, ...path),
        `${who(b)} drives ${b.property}, so ${field} must be ${kindOf(b.property)}, not ${Array.isArray(got) ? "[x, y]" : "a number"}`,
      );
    if (b.type === "wiggle" || b.type === "oscillate") {
      const track = b.amplitude;
      if ("value" in track) {
        if (!matches(track.value, b.property))
          wrongKind(["amplitude", "value"], track.value, "amplitude");
      } else
        track.keyframes.forEach((kf, ki) => {
          if (!matches(kf.value, b.property))
            wrongKind(["amplitude", "keyframes", ki, "value"], kf.value, "amplitude");
        });
    }
    if (b.type === "link" && !matches(b.offset, b.property))
      wrongKind(["offset"], b.offset, "offset");
    if (b.type === "wiggle" && b.linked && !isVectorTransformProperty(b.property))
      issue(
        at("behaviors", bi, "linked"),
        `${who(b)} drives ${b.property}, which is a single number; 'linked' applies to anchorPoint, position and scale only, set it to false`,
      );

    const counts = perProperty.get(b.property) ?? { link: 0, inertia: 0, loopIn: 0, loopOut: 0 };
    perProperty.set(b.property, counts);
    const again = (what: string) =>
      issue(
        at("behaviors", bi, "type"),
        `${who(b)} is a second ${what} on ${b.property}; a property takes at most one, remove or change one`,
      );
    if (b.type === "link" && counts.link++ > 0) again("link");
    if (b.type === "inertia" && counts.inertia++ > 0) again("inertia");
    if (b.type === "loop") {
      if (b.direction === "in" ? counts.loopIn++ > 0 : counts.loopOut++ > 0)
        again(`loop ${b.direction}`);
    }

    if (b.type !== "link") return;
    const sourcePath = (...rest: string[]) => at("behaviors", bi, "source", ...rest);
    const source = layerById.get(b.source.layer);
    if (source === undefined) {
      const elsewhere = compOf.get(b.source.layer);
      issue(
        sourcePath("layer"),
        elsewhere === undefined
          ? `layer '${layer.id}' has a link behavior '${b.id}' whose source layer '${b.source.layer}' does not exist (was it removed?); remove the behavior or point source.layer at an existing layer of composition '${compId}'`
          : `layer '${layer.id}' has a link behavior '${b.id}' whose source layer '${b.source.layer}' is in composition '${elsewhere}', not '${compId}'; a link source must be a layer of the same composition`,
      );
    } else if (source.type === "audio")
      issue(
        sourcePath("layer"),
        `${who(b)} links to '${source.id}', an audio layer, which has no transform; link to a layer that has one`,
      );
    if (isVectorTransformProperty(b.source.property) !== isVectorTransformProperty(b.property))
      issue(
        sourcePath("property"),
        `${who(b)} drives ${b.property} (${kindOf(b.property)}) from ${b.source.property} (${kindOf(b.source.property)}); link properties of the same kind`,
      );
    if (b.source.layer === layer.id && b.source.property === b.property)
      issue(
        sourcePath("property"),
        `${who(b)} reads its own ${b.property}; link to another property or another layer`,
      );
  });

  // A link replaces the property's value, so a loop or inertia on the same property would be hidden.
  layer.behaviors.forEach((b, bi) => {
    if ((b.type !== "loop" && b.type !== "inertia") || !perProperty.get(b.property)?.link) return;
    issue(
      at("behaviors", bi, "property"),
      `${who(b)} (${b.type}) is on ${b.property}, which also has a link; the link would hide the ${b.type}, so remove one of them or move this ${b.type} to another property`,
    );
  });
}

/**
 * Link cycles over (layer, property) nodes, linear time, iterative. Every link counts, enabled or
 * not and whatever its delay. A cycle is reported once, on the outgoing link of its first member
 * (layer order, then property order), with the loop listed.
 */
function checkLinkCycles(
  layers: readonly Layer[],
  at: (layerIndex: number, ...rest: (string | number)[]) => Path,
  issue: Issue,
): void {
  if (
    !layers.some((layer) => hasTransform(layer) && layer.behaviors.some((b) => b.type === "link"))
  )
    return;
  type Edge = { to: string; path: Path };
  const rank = new Map<string, number>(); // layer order, then property order
  const edges = new Map<string, Edge[]>();
  const ids = new Set(layers.map((l) => l.id as string));
  layers.forEach((layer, li) => {
    if (!hasTransform(layer)) return;
    for (const property of TRANSFORM_PROPERTIES) rank.set(linkNode(layer.id, property), rank.size);
    layer.behaviors.forEach((b, bi) => {
      // A self-read is reported by checkBehaviors, a missing source by the source check.
      if (b.type !== "link" || !ids.has(b.source.layer)) return;
      if (b.source.layer === layer.id && b.source.property === b.property) return;
      const from = linkNode(layer.id, b.property);
      const list = edges.get(from) ?? [];
      list.push({
        to: linkNode(b.source.layer, b.source.property),
        path: at(li, "behaviors", bi, "source"),
      });
      edges.set(from, list);
    });
  });

  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = finished
  for (const root of rank.keys()) {
    if (state.has(root) || !edges.has(root)) continue;
    const path: string[] = [root];
    const cursor: number[] = [0];
    state.set(root, 1);
    while (path.length > 0) {
      const node = path[path.length - 1] as string;
      const index = cursor[cursor.length - 1] as number;
      const out = edges.get(node) ?? [];
      if (index >= out.length) {
        state.set(node, 2);
        path.pop();
        cursor.pop();
        continue;
      }
      cursor[cursor.length - 1] = index + 1;
      const edge = out[index] as Edge;
      const seen = state.get(edge.to);
      if (seen === 1) {
        const start = path.indexOf(edge.to);
        const loop = path.slice(start);
        // The edge leaving loop[k] is the one the walk took from path[start + k].
        let first = 0;
        loop.forEach((n, k) => {
          if ((rank.get(n) ?? 0) < (rank.get(loop[first] as string) ?? 0)) first = k;
        });
        const leave = (k: number) => {
          const from = path[start + k] as string;
          const taken = (cursor[start + k] as number) - 1;
          return (edges.get(from) as Edge[])[taken] as Edge;
        };
        const rotated = [...loop.slice(first), ...loop.slice(0, first)];
        const shown = rotated.slice(0, 6).join(" -> ");
        issue(
          leave(first).path,
          `link cycle (${loop.length} ${loop.length === 1 ? "property" : "properties"}): ${rotated.length > 6 ? `${shown} -> ... -> ` : `${shown} -> `}${rotated[0]}; remove the link from one of these, even a delayed or disabled link counts`,
        );
      } else if (seen === undefined) {
        state.set(edge.to, 1);
        path.push(edge.to);
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

  const compOf = new Map<string, string>(); // layer id -> composition id (first one wins)
  for (const comp of project.compositions)
    for (const l of comp.layers) if (!compOf.has(l.id)) compOf.set(l.id, comp.id);

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
        else if (parent.type === "camera")
          issue(
            at("parent"),
            "cameras cannot be parents; parent the layer to a null and the camera to the same null instead",
          );
      }

      if (layer.type === "adjustment" && layer.threeD)
        issue(at("threeD"), "adjustment layers cannot be 3D; set threeD to false");

      if (hasTransform(layer) && layer.behaviors.length > 0)
        checkBehaviors(layer, layerById, compOf, comp.id, at, issue);

      if (isDrawn(layer)) {
        if (layer.type === "adjustment" && layer.motionBlur !== null)
          issue(at("motionBlur"), "adjustment layers have no motion blur; set motionBlur to null");
        if (layer.type === "adjustment" && layer.transition !== null)
          issue(at("transition"), "adjustment layers have no transition; set transition to null");
        const seenEffects = new Set<string>();
        layer.effects.forEach((effect, ei) => {
          if (seenEffects.has(effect.id))
            issue(
              at("effects", ei, "id"),
              `duplicate effect id '${effect.id}'; rename one in layer '${layer.id}'`,
            );
          seenEffects.add(effect.id);
        });
        const seenMasks = new Set<string>();
        layer.masks.forEach((mask, mi) => {
          if (seenMasks.has(mask.id))
            issue(
              at("masks", mi, "id"),
              `duplicate mask id '${mask.id}' in layer '${layer.id}'; mask ids are unique within a layer, rename one`,
            );
          seenMasks.add(mask.id);
        });
        if (layer.matte !== null) {
          const source = layerById.get(layer.matte.layerId);
          const why =
            layer.matte.layerId === layer.id
              ? "a layer cannot be its own track matte"
              : source === undefined
                ? `'${layer.matte.layerId}' is not a layer in composition '${comp.id}'`
                : !isDrawn(source) || source.type === "adjustment"
                  ? `'${layer.matte.layerId}' is ${source.type === "adjustment" ? "an adjustment" : `${/^[aeiou]/.test(source.type) ? "an" : "a"} ${source.type}`} layer, which draws no pixels to use as a matte`
                  : null;
          if (why !== null)
            issue(
              at("matte", "layerId"),
              `${why}; set matte to null or to a shape, text, image, solid, precomp or component layer of this composition`,
            );
        }
      }

      switch (layer.type) {
        case "image":
        case "video":
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
              `font family '${family}' is neither bundled (${BUNDLED_FONT_FAMILIES.join(", ")}) nor a font asset of this project (${uploaded.length > 0 ? uploaded.join(", ") : "none"}).${near === undefined ? "" : ` Did you mean '${near}'?`} Use one of those or add a font asset`,
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

    checkChainCycles(
      comp.layers,
      (layer) => (hasTransform(layer) ? layer.parent : null),
      (li, ids) =>
        issue(
          ["compositions", ci, "layers", li, "parent"],
          `parenting cycle: ${ids.join(" -> ")}; set parent to null on one of these layers`,
        ),
    );
    checkChainCycles(
      comp.layers,
      // A self-reference is reported above, not again as a one-layer cycle.
      (layer) =>
        isDrawn(layer) && layer.matte !== null && layer.matte.layerId !== layer.id
          ? layer.matte.layerId
          : null,
      (li, ids) =>
        issue(
          ["compositions", ci, "layers", li, "matte", "layerId"],
          `track matte cycle: ${ids.join(" -> ")}; set matte to null on one of these layers`,
        ),
    );
    checkLinkCycles(
      comp.layers,
      (li, ...rest) => ["compositions", ci, "layers", li, ...rest],
      issue,
    );
  });

  checkPrecompCycles(project, issue);
}

export const ProjectSchema = ProjectShape.superRefine(checkIntegrity);
export type { Project };
