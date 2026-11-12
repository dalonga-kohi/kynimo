import type { ResolvedTransition } from "@kynimo/engine";

/**
 * The CPU-side values of a built-in shader transition (ADR-0045 policy: trig and corner extents in
 * float64 on the CPU, the per-pixel part in the shader). Each entry becomes the uniform `u_<name>`
 * of the GPU program; the reference compositor reads the same record and rounds every number with
 * `Math.fround` first, as the GPU receives them. Coordinates are composition pixels, y down.
 */
export type TransitionUniforms = Readonly<Record<string, readonly number[]>>;

const RADIANS = Math.PI / 180;

/** Unit vector of an angle in degrees, clockwise on screen, 0 pointing toward +x. */
const direction = (degrees: number): [number, number] => [
  Math.cos(degrees * RADIANS),
  Math.sin(degrees * RADIANS),
];

/** The range of `dot(corner, d)` over the four frame corners: `[min, length]`. */
function extent([dx, dy]: readonly [number, number], width: number, height: number) {
  const dots = [0, width * dx, height * dy, width * dx + height * dy];
  const min = Math.min(...dots);
  return [min, Math.max(...dots) - min] as const;
}

/** Distance of `(x, y)` from the origin in the iris shape's metric. */
function irisDistance(shape: "circle" | "diamond" | "square", x: number, y: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  return shape === "circle" ? Math.hypot(ax, ay) : shape === "diamond" ? ax + ay : Math.max(ax, ay);
}

const SHAPE_IDS = { circle: 0, diamond: 1, square: 2 } as const;

/** The uniforms of `transition` for a `width × height` composition (progress in `(0, 1)`). */
export function transitionUniforms(
  transition: ResolvedTransition,
  width: number,
  height: number,
): TransitionUniforms {
  const p = [transition.progress];
  const size = [width, height];
  switch (transition.kind) {
    case "dissolve":
      return { p };
    case "noise-dissolve":
      return { p, scale: [transition.scale], feather: [transition.feather] };
    case "wipe": {
      const d = direction(transition.angle);
      const [min, length] = extent(d, width, height);
      return { p, dir: d, range: [min, length], feather: [Math.max(transition.feather, 1)] };
    }
    case "clock": {
      const a = transition.startAngle * RADIANS;
      return {
        p,
        center: transition.center,
        dir0: [Math.sin(a), -Math.cos(a)],
        turn: [transition.clockwise ? 1 : -1],
        feather: [transition.feather],
      };
    }
    case "iris": {
      const [cx, cy] = transition.center;
      const rMax = Math.max(
        ...[0, width].flatMap((x) =>
          [0, height].map((y) => irisDistance(transition.shape, x - cx, y - cy)),
        ),
      );
      return {
        p,
        center: transition.center,
        feather: [Math.max(transition.feather, 1)],
        rmax: [rMax],
        shape: [SHAPE_IDS[transition.shape]],
      };
    }
    case "blinds": {
      const d = direction(transition.angle);
      const [min, length] = extent(d, width, height);
      const period = length / transition.count;
      return {
        p,
        dir: d,
        smin: [min],
        period: [period],
        feather: [Math.max(transition.feather * period, 1)],
      };
    }
    case "pixelate":
      return {
        p,
        cell: [1 + (transition.cell - 1) * (1 - Math.abs(2 * transition.progress - 1))],
        mix: [Math.min(1, Math.max(0, (transition.progress - 0.4) / 0.2))],
        size,
      };
    case "push": {
      const d = direction(transition.angle);
      const [min, length] = extent(d, width, height);
      return { p, dir: d, range: [min, length], size };
    }
    case "zoom":
      return {
        p,
        center: transition.center,
        scale: [
          1 + transition.strength * transition.progress,
          1 + transition.strength * (1 - transition.progress),
        ],
        size,
      };
    case "glitch":
      return {
        p,
        bands: [transition.bands],
        step: [Math.floor(transition.progress * 16)],
        amp: [transition.amount * 0.1 * width * (1 - Math.abs(2 * transition.progress - 1))],
        size,
      };
  }
}
