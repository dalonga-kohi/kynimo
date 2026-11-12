import { sampleNonNegative } from "@kynimo/engine";
import type { FrameRate, Layer, Project } from "@kynimo/scene";

/** Stored audio assets are 48 kHz stereo (ADR-0032); the mix has the same shape. */
export const AUDIO_RATE = 48_000;
export const AUDIO_CHANNELS = 2;

/**
 * First sample of composition frame `frame` at `fps`: floor(frame * 48000 * den / num), exact for
 * negative frames too.
 */
export function frameSample(frame: number, fps: FrameRate): number {
  const n = frame * AUDIO_RATE * fps.den;
  if (!Number.isSafeInteger(n))
    throw new RangeError(`frame ${frame} is too large to place its audio samples exactly`);
  const rest = ((n % fps.num) + fps.num) % fps.num;
  return (n - rest) / fps.num;
}

export interface AudioPlan {
  layers: { id: string; assetId: string }[];
  /** Audio layers inside precomps reachable from the composition; v1 does not mix them. */
  nested: { id: string; compositionId: string }[];
}

type AudioLayer = Extract<Layer, { type: "audio" }>;

function compositionOf(doc: Project, compositionId: string) {
  const comp = doc.compositions.find((c) => c.id === compositionId);
  if (comp === undefined) throw new RangeError(`unknown composition '${compositionId}'`);
  return comp;
}

/** The evaluator's rule: solo is per composition and covers audio; hidden mutes. */
function activeAt(layers: readonly Layer[]): (l: Layer, frame: number) => boolean {
  const anySolo = layers.some((l) => l.solo);
  return (l, frame) =>
    !l.hidden && (!anySolo || l.solo) && l.inFrame <= frame && frame < l.outFrame;
}

function activeLayers(doc: Project, compositionId: string, from: number, to: number) {
  const comp = compositionOf(doc, compositionId);
  const active = activeAt(comp.layers);
  const out: AudioLayer[] = [];
  for (const l of comp.layers) {
    if (l.type !== "audio") continue;
    // Active at some frame in [from, to] exactly when the in/out range meets it.
    if (active(l, Math.max(from, l.inFrame)) && Math.max(from, l.inFrame) <= to) out.push(l);
  }
  return { comp, active, layers: out };
}

/** Audio layers of `compositionId` that are active at some frame in [from, to] (to included). */
export function planAudio(
  doc: Project,
  compositionId: string,
  from: number,
  to: number,
): AudioPlan {
  const { comp, layers } = activeLayers(doc, compositionId, from, to);
  const nested: AudioPlan["nested"] = [];
  const seen = new Set<string>([comp.id]);
  const todo = [comp];
  for (let c = todo.pop(); c !== undefined; c = todo.pop()) {
    for (const l of c.layers) {
      if (l.type !== "precomp" || seen.has(l.compositionId)) continue;
      seen.add(l.compositionId);
      const inner = compositionOf(doc, l.compositionId);
      todo.push(inner);
      for (const a of inner.layers)
        if (a.type === "audio") nested.push({ id: a.id, compositionId: inner.id });
    }
  }
  return { layers: layers.map((l) => ({ id: l.id, assetId: l.assetId })), nested };
}

export interface MixResult {
  samples: Float32Array;
  /** Output values that were clamped to [-1, 1]. */
  clipped: number;
  /** Layers that played in at least one frame. */
  mixed: string[];
}

/**
 * Mixes the plan's layers into interleaved stereo f32 covering frames [from, to]. Each layer
 * is placed at its `startFrame`, gated by its in/out frames, and scaled by its volume, which ramps
 * linearly across a frame toward the next frame's value while the layer stays active.
 */
export function mixAudio(
  doc: Project,
  compositionId: string,
  from: number,
  to: number,
  pcm: ReadonlyMap<string, Float32Array>,
): MixResult {
  const { comp, active, layers } = activeLayers(doc, compositionId, from, to);
  const fps = comp.fps;
  for (const l of layers)
    if (!pcm.has(l.assetId)) throw new Error(`no decoded audio for asset '${l.assetId}'`);
  const base = frameSample(from, fps);
  const out = new Float32Array(AUDIO_CHANNELS * (frameSample(to + 1, fps) - base));
  const mixed = new Set<string>();
  const starts = new Map(layers.map((l) => [l.id, frameSample(l.startFrame, fps)]));

  for (let f = from; f <= to; f++) {
    const s0 = frameSample(f, fps);
    const s1 = frameSample(f + 1, fps);
    const span = s1 - s0;
    for (const l of layers) {
      if (!active(l, f)) continue;
      mixed.add(l.id);
      const v0 = sampleNonNegative(l.volume, f - l.startFrame, fps);
      const v1 = active(l, f + 1) ? sampleNonNegative(l.volume, f + 1 - l.startFrame, fps) : v0;
      const src = pcm.get(l.assetId) as Float32Array;
      const length = src.length / AUDIO_CHANNELS;
      const origin = starts.get(l.id) as number;
      // Only the part of the frame that falls inside the source has anything to add.
      const first = Math.max(s0, origin);
      const last = Math.min(s1, origin + length);
      for (let c = first; c < last; c++) {
        const g = v0 + ((v1 - v0) * (c - s0)) / span;
        const i = (c - origin) * AUDIO_CHANNELS;
        const o = (c - base) * AUDIO_CHANNELS;
        out[o] = (out[o] as number) + (src[i] as number) * g;
        out[o + 1] = (out[o + 1] as number) + (src[i + 1] as number) * g;
      }
    }
  }

  let clipped = 0;
  for (let i = 0; i < out.length; i++) {
    const v = out[i] as number;
    if (v > 1 || v < -1) {
      clipped++;
      out[i] = v > 1 ? 1 : -1;
    }
  }
  return { samples: out, clipped, mixed: layers.filter((l) => mixed.has(l.id)).map((l) => l.id) };
}
