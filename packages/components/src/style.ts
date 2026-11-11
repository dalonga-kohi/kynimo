import {
  COLOR_ROLES,
  type ColorRole,
  type DistanceToken,
  type DurationToken,
  durationFrames,
  type EasingToken,
  type GuidelinePack,
  interpolationFor,
  type SpacingToken,
  type SpringToken,
  type StaggerToken,
  scaleFor,
  staggerFrames,
  type TypeRole,
  type TypeStyle,
} from "@kynimo/guidelines";
import type { Color, FrameRate, Interpolation } from "@kynimo/scene";

/**
 * The document's style pack as a component sees it: tokens by name, with pixel values already
 * scaled to the containing composition (ADR-0037), so a component never touches pack internals.
 */
export interface ComponentStyle {
  /** The pack the document pins (Keynote when it pins none). Read-only: it is shared. */
  readonly pack: GuidelinePack;
  /** Factor from the pack's reference pixels to the containing composition's pixels (`scaleFor`). */
  readonly scale: number;
  /** The role's color as `#rrggbb`. */
  color(role: ColorRole): Color;
  /** The role's type style with `size` multiplied by `scale`; tracking, leading and case are unitless. */
  type(role: TypeRole): TypeStyle;
  /** A duration token in whole frames at the containing composition's frame rate. */
  frames(token: DurationToken): number;
  /** A stagger token in whole frames at the containing composition's frame rate. */
  stagger(token: StaggerToken): number;
  /** The keyframe interpolation an easing or spring token stands for. */
  easing(token: EasingToken | SpringToken): Interpolation;
  /** A spacing token in composition pixels. */
  spacing(token: SpacingToken): number;
  /** A motion distance token in composition pixels. */
  distance(token: DistanceToken): number;
}

export function createComponentStyle(
  pack: GuidelinePack,
  size: { width: number; height: number },
  fps: FrameRate,
): ComponentStyle {
  const scale = scaleFor(size);
  return {
    pack,
    scale,
    color: (role) => {
      if (!(COLOR_ROLES as readonly string[]).includes(role))
        throw new RangeError(`unknown color role '${role}'; use one of: ${COLOR_ROLES.join(", ")}`);
      return pack.color[role];
    },
    type: (role) => {
      const style = pack.type[role];
      if (style === undefined) throw new RangeError(`unknown type role '${role}'`);
      return { ...style, size: style.size * scale };
    },
    frames: (token) => durationFrames(pack, token, fps),
    stagger: (token) => staggerFrames(pack, token, fps),
    easing: (token) => interpolationFor(pack, token),
    spacing: (token) => pack.layout.spacing[token] * scale,
    distance: (token) => pack.motion.distance[token] * scale,
  };
}
