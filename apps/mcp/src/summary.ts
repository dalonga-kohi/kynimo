import type { Composition, Layer, Project } from "@kynimo/scene";

/** One keyframed property, in composition frames. */
export interface AnimatedProperty {
  /** Dot path inside the layer, e.g. "transform.position" or "font.size". */
  property: string;
  keyframes: number;
  first_frame: number;
  last_frame: number;
}

export interface LayerSummary {
  id: string;
  name: string;
  type: Layer["type"];
  /** Top-first: 0 is drawn on top. */
  index: number;
  parent: string | null;
  in_frame: number;
  out_frame: number;
  start_frame: number;
  hidden: boolean;
  animated: AnimatedProperty[];
}

export interface CompositionSummary {
  id: string;
  name: string;
  main: boolean;
  width: number;
  height: number;
  fps: { num: number; den: number };
  duration_frames: number;
  markers: number;
  layers: LayerSummary[];
}

/** Layer fields holding free-form data, not tracks. */
const FREE_FORM = new Set(["props"]);

/** Finds keyframe tracks structurally, so properties added later show up without changes here. */
function animatedProperties(layer: Layer): AnimatedProperty[] {
  const out: AnimatedProperty[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, [...path, String(i)]);
      });
      return;
    }
    const kfs = (value as { keyframes?: unknown }).keyframes;
    if (Array.isArray(kfs)) {
      const frames = kfs
        .map((k) => (k as { frame?: unknown }).frame)
        .filter((f): f is number => typeof f === "number");
      if (frames.length > 0)
        out.push({
          property: path.join("."),
          keyframes: frames.length,
          first_frame: layer.startFrame + Math.min(...frames),
          last_frame: layer.startFrame + Math.max(...frames),
        });
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (path.length === 0 && FREE_FORM.has(k)) continue;
      walk(v, [...path, k]);
    }
  };
  walk(layer, []);
  return out;
}

export const summarizeLayer = (layer: Layer, index: number): LayerSummary => ({
  id: layer.id,
  name: layer.name,
  type: layer.type,
  index,
  parent: "parent" in layer ? layer.parent : null,
  in_frame: layer.inFrame,
  out_frame: layer.outFrame,
  start_frame: layer.startFrame,
  hidden: layer.hidden,
  animated: animatedProperties(layer),
});

export const summarizeComposition = (doc: Project, c: Composition): CompositionSummary => ({
  id: c.id,
  name: c.name,
  main: c.id === doc.mainCompositionId,
  width: c.width,
  height: c.height,
  fps: c.fps,
  duration_frames: c.durationFrames,
  markers: c.markers.length,
  layers: c.layers.map(summarizeLayer),
});
