import type {
  Animatable,
  Behavior,
  FrameRate,
  InertiaBehavior,
  Layer,
  LinkBehavior,
  LoopBehavior,
  OscillateBehavior,
  Transform,
  TransformProperty,
  Vec2,
  WiggleBehavior,
} from "@kynimo/scene";
import { isVectorTransformProperty } from "@kynimo/scene";
import { type Affine, transformMatrix } from "./affine.js";
import {
  evaluateGroup,
  type PropertyTrack,
  trackGroups,
  waveform,
  wiggleOffset,
} from "./behavior.js";
import { clampUnit } from "./mix.js";
import { clampSkew, samplePoint, sampleUnit } from "./properties.js";
import type { Point, ResolvedTransform } from "./resolved.js";
import { sampleNumber, samplePosition, sampleVector } from "./track.js";

type VisualLayer = Exclude<Layer, { type: "audio" }>;
type Components = readonly number[];

/**
 * Resolves layer properties with behaviors (ADR-0039), one composition evaluation at a time.
 * `property(layer, name, frame)` is the property's value at composition `frame`, parent-relative,
 * with behaviors and domain clamps applied. Results are memoized per (layer, property, frame), so
 * each resolves once per evaluation however many links read it.
 */
export interface BehaviorResolver {
  property(layer: VisualLayer, property: TransformProperty, frame: number): Components;
  /** The layer's whole transform at composition `frame`, behaviors applied, and its local matrix. */
  transform(layer: VisualLayer, frame: number): { transform: ResolvedTransform; matrix: Affine };
}

/** Samples a property without behaviors, exactly as `resolveTransform` does. */
function sampleBase(
  t: Transform,
  property: TransformProperty,
  frame: number,
  fps: FrameRate,
): Components {
  switch (property) {
    case "anchorPoint":
      return samplePoint(t.anchorPoint, frame, fps);
    case "position":
      return samplePosition(t.position, frame, fps);
    case "scale":
      return samplePoint(t.scale, frame, fps);
    case "positionZ":
      return [sampleNumber(t.positionZ, frame, fps)];
    case "rotation":
      return [sampleNumber(t.rotation, frame, fps)];
    case "rotationX":
      return [sampleNumber(t.rotationX, frame, fps)];
    case "rotationY":
      return [sampleNumber(t.rotationY, frame, fps)];
    case "skew":
      return [clampSkew(sampleNumber(t.skew, frame, fps))];
    case "opacity":
      return [sampleUnit(t.opacity, frame, fps)];
  }
}

const clampProperty = (property: TransformProperty, value: Components): Components => {
  if (property === "skew") return [clampSkew(value[0] as number)];
  if (property === "opacity") return [clampUnit(value[0] as number)];
  return value;
};

/** An animatable amount (`amplitude`) at `frame`, as components of the property's kind. */
function sampleAmount(
  track: Animatable<number | Vec2>,
  vector: boolean,
  frame: number,
  fps: FrameRate,
  what: string,
): Components {
  const first = "value" in track ? track.value : track.keyframes[0]?.value;
  if (Array.isArray(first) !== vector)
    throw new RangeError(
      `${what} must be ${vector ? "an [x, y] pair" : "a number"} for this property`,
    );
  return vector
    ? sampleVector(track as Animatable<Vec2>, frame, fps)
    : [sampleNumber(track as Animatable<number>, frame, fps)];
}

/** Refuses a behavior result that is not a finite number, naming what to lower. */
function assertFinite(
  value: Components,
  layer: VisualLayer,
  behaviorId: string,
  property: TransformProperty,
  lower: string,
): void {
  if (value.every(Number.isFinite)) return;
  throw new RangeError(
    `behavior '${behaviorId}' on layer '${layer.id}' makes '${property}' not finite (overflow); lower its ${lower}`,
  );
}

const keyOf = (layerId: string, property: string, frame: number) =>
  `${layerId}\u0000${property}\u0000${frame}`;

/** What a property resolution needs to know about a layer, independent of the frame. */
interface Plan {
  enabled: readonly Behavior[];
  link: LinkBehavior | undefined;
  /** layer\0property, the node's name in cycle detection. */
  pair: string;
}

interface Pending {
  layer: VisualLayer;
  property: TransformProperty;
  frame: number;
  key: string;
}

export function createBehaviorResolver(
  byId: ReadonlyMap<string, Layer>,
  fps: FrameRate,
  /** Called before each value a link asks for and the memo does not hold; may throw to stop. */
  onLinkStep: (layerId: string, property: string) => void,
): BehaviorResolver {
  const memo = new Map<string, Components>();

  /** Each layer's enabled behaviors per property and its link, found once per evaluation. */
  const plans = new Map<VisualLayer, Map<TransformProperty, Plan>>();
  const planFor = (layer: VisualLayer, property: TransformProperty): Plan => {
    let byProperty = plans.get(layer);
    if (byProperty === undefined) {
      byProperty = new Map();
      plans.set(layer, byProperty);
    }
    let plan = byProperty.get(property);
    if (plan === undefined) {
      const enabled = layer.behaviors.filter((b) => b.enabled && b.property === property);
      plan = {
        enabled,
        link: enabled.find((b): b is LinkBehavior => b.type === "link"),
        pair: `${layer.id}\u0000${property}`,
      };
      byProperty.set(property, plan);
    }
    return plan;
  };

  /** Steps 1 to 5 for one property, given the link source's value when it has a link. */
  const compute = (
    layer: VisualLayer,
    property: TransformProperty,
    frame: number,
    enabled: readonly Behavior[],
    link: LinkBehavior | undefined,
    source: Components | undefined,
  ): Components => {
    const layerFrame = frame - layer.startFrame;
    const vector = isVectorTransformProperty(property);
    const track = layer.transform[property] as PropertyTrack;
    let value: Components;
    if (link !== undefined && source !== undefined) {
      const offset: Components = typeof link.offset === "number" ? [link.offset] : link.offset;
      if (source.length !== offset.length)
        throw new RangeError(
          `link '${link.id}' on layer '${layer.id}' reads ${source.length === 1 ? "a number" : "an [x, y] pair"} from '${link.source.layer}.${link.source.property}', but '${property}' is ${vector ? "an [x, y] pair" : "a number"}`,
        );
      value = source.map((x, i) => x * link.multiply + (offset[i] as number));
      assertFinite(value, layer, link.id, property, "multiply or offset");
    } else {
      const loops = enabled.filter((b): b is LoopBehavior => b.type === "loop");
      const inertias = enabled.filter((b): b is InertiaBehavior => b.type === "inertia");
      value = trackGroups(track, vector).flatMap((g) =>
        evaluateGroup(g, loops, inertias, layerFrame, fps),
      );
      if (inertias.length > 0)
        assertFinite(value, layer, inertias.map((i) => i.id).join(", "), property, "amplitude");
    }
    const t = (layerFrame * fps.den) / fps.num;
    for (const b of enabled) {
      if (b.type === "oscillate") value = oscillate(b, value, vector, layerFrame, t);
      else if (b.type === "wiggle") value = wiggle(b, value, vector, layerFrame, t);
      else continue;
      assertFinite(value, layer, b.id, property, "amplitude");
    }
    return clampProperty(property, value);
  };

  const oscillate = (
    b: OscillateBehavior,
    value: Components,
    vector: boolean,
    layerFrame: number,
    t: number,
  ): Components => {
    const frequency = sampleNumber(b.frequency, layerFrame, fps);
    const amplitude = sampleAmount(b.amplitude, vector, layerFrame, fps, `amplitude of '${b.id}'`);
    const wave = waveform(b.waveform, frequency, b.phase, t);
    return value.map((x, i) => x + wave * (amplitude[i] as number));
  };

  const wiggle = (
    b: WiggleBehavior,
    value: Components,
    vector: boolean,
    layerFrame: number,
    t: number,
  ): Components => {
    const frequency = sampleNumber(b.frequency, layerFrame, fps);
    const amplitude = sampleAmount(b.amplitude, vector, layerFrame, fps, `amplitude of '${b.id}'`);
    const offset = wiggleOffset(b, amplitude, t, frequency);
    return value.map((x, i) => x + (offset[i] as number));
  };

  /**
   * Resolves with an explicit stack: a link needs its source resolved first, and chains can be as
   * long as the composition has layers. `onStack` holds (layer, property) pairs in progress, so a
   * cycle the schema should have refused throws instead of looping, whatever the delays.
   */
  const property = (layer: VisualLayer, prop: TransformProperty, frame: number): Components => {
    const rootKey = keyOf(layer.id, prop, frame);
    const hit = memo.get(rootKey);
    if (hit !== undefined) return hit;

    const stack: Pending[] = [{ layer, property: prop, frame, key: rootKey }];
    const onStack = new Set<string>([planFor(layer, prop).pair]);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as Pending;
      const { enabled, link, pair: ownPair } = planFor(top.layer, top.property);
      if (enabled.length === 0) {
        memo.set(
          top.key,
          sampleBase(top.layer.transform, top.property, top.frame - top.layer.startFrame, fps),
        );
      } else {
        let source: Components | undefined;
        if (link !== undefined) {
          const sourceLayer = byId.get(link.source.layer);
          if (sourceLayer === undefined || sourceLayer.type === "audio")
            throw new RangeError(
              `link '${link.id}' on layer '${top.layer.id}' needs a visual layer of the same composition as its source, but '${link.source.layer}' is not one`,
            );
          const sourceFrame = top.frame - link.delay;
          const sourceKey = keyOf(sourceLayer.id, link.source.property, sourceFrame);
          source = memo.get(sourceKey);
          if (source === undefined) {
            const pair = planFor(sourceLayer, link.source.property).pair;
            if (onStack.has(pair))
              throw new RangeError(
                `links form a cycle through layer '${sourceLayer.id}' property '${link.source.property}'`,
              );
            onLinkStep(sourceLayer.id, link.source.property);
            onStack.add(pair);
            stack.push({
              layer: sourceLayer,
              property: link.source.property,
              frame: sourceFrame,
              key: sourceKey,
            });
            continue;
          }
        }
        memo.set(top.key, compute(top.layer, top.property, top.frame, enabled, link, source));
      }
      stack.pop();
      onStack.delete(ownPair);
    }
    return memo.get(rootKey) as Components;
  };

  const point = (v: Components): Point => [v[0] as number, v[1] as number];

  return {
    property,
    transform(layer, frame) {
      const transform: ResolvedTransform = {
        anchorPoint: point(property(layer, "anchorPoint", frame)),
        position: point(property(layer, "position", frame)),
        positionZ: (property(layer, "positionZ", frame) as Components)[0] as number,
        scale: point(property(layer, "scale", frame)),
        rotation: (property(layer, "rotation", frame) as Components)[0] as number,
        rotationX: (property(layer, "rotationX", frame) as Components)[0] as number,
        rotationY: (property(layer, "rotationY", frame) as Components)[0] as number,
        skew: (property(layer, "skew", frame) as Components)[0] as number,
        opacity: (property(layer, "opacity", frame) as Components)[0] as number,
      };
      return { transform, matrix: transformMatrix(transform) };
    },
  };
}
