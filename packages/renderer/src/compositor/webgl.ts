import type { ResolvedEffect, ResolvedGenerator, Rgba } from "@kynimo/engine";
import type {
  CoverageImage,
  FramePlan,
  PlannedAdjustmentLayer,
  PlannedLayer,
  RasterImage,
} from "../raster.js";
import {
  effectPadding,
  effectSamples,
  gaussianWeights,
  generatorSamples,
  MAX_FRAME_EFFECT_SAMPLES,
} from "./effects.js";
import {
  BLEND_MODE_IDS,
  invert,
  levelOfDetail,
  MATTE_MODES,
  matteChain,
  maxLevel,
  placement,
  precompUses,
} from "./pipeline.js";
import {
  blendShader,
  DOWNSAMPLE,
  type EffectMode,
  effectShader,
  FINAL,
  GAUSSIAN,
  generatorShader,
  type MatteMode,
  PREPARE,
  placeShader,
  VERTEX,
} from "./shaders.js";

/** Thrown when the WebGL2 context cannot run the compositor (missing float render targets, sizes). */
export class CompositorError extends Error {
  override name = "CompositorError";
}

/** A WebGL2 texture of known size, optionally with a framebuffer that renders into it. */
interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer | null;
  width: number;
  height: number;
  /** Set on render targets that live in the pool; they are recycled, not deleted, when freed. */
  poolKey?: string;
  /** Bytes the pooled target's texture holds. */
  bytesHeld?: number;
  /** The frame in which a pooled target was last released. */
  released?: number;
}

const EFFECT_MODES: Readonly<Record<ResolvedEffect["type"], EffectMode | 0>> = {
  "gaussian-blur": 0,
  "drop-shadow": 1,
  glow: 2,
  "brightness-contrast": 3,
  "hue-saturation": 4,
  tint: 5,
  fill: 6,
  vignette: 7,
  grain: 8,
  "chromatic-aberration": 9,
  posterize: 10,
  scanlines: 11,
};

type Program = { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> };

/**
 * The WebGL2 compositor (ADR-0016, ADR-0021): the same pipeline as {@link compositeReference},
 * as GPU passes over premultiplied RGBA16F targets. One per context; `composite` may be called
 * for any number of frames and keeps no state between them. Deterministic on the pinned
 * SwiftShader worker setup; on other GPUs it is visually equivalent (ADR-0016).
 */
export interface Compositor {
  /** Composites a frame plan into premultiplied sRGB RGBA8, rows top to bottom. */
  composite(plan: FramePlan): RasterImage;
  /** The `UNMASKED_RENDERER_WEBGL` string, for workers to check they run on SwiftShader. */
  readonly renderer: string;
  /** Frees the programs. The context itself belongs to the caller. */
  dispose(): void;
}

/** Most bytes of released render targets the compositor keeps for reuse. */
const POOL_IDLE_BYTES = 64 * 1024 * 1024;

export function createCompositor(gl: WebGL2RenderingContext): Compositor {
  if (gl.getExtension("EXT_color_buffer_float") === null)
    throw new CompositorError("the WebGL2 context cannot render to float (RGBA16F) targets");
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(
    debug === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
  );
  const vao = gl.createVertexArray();
  const blendProgram = (mode: number, adjustment: boolean) =>
    program(`blend:${mode}${adjustment ? "a" : ""}`, () => blendShader(mode, adjustment));
  /** Programs by variant key, compiled on first use and kept until `dispose`. */
  const programs = new Map<string, Program>();
  const program = (key: string, fragment: () => string): Program => {
    let p = programs.get(key);
    if (p === undefined) {
      p = build(gl, fragment());
      programs.set(key, p);
    }
    return p;
  };
  const fixed = {
    prepare: () => program("prepare", () => PREPARE),
    gaussian: () => program("gaussian", () => GAUSSIAN),
    downsample: () => program("downsample", () => DOWNSAMPLE),
    final: () => program("final", () => FINAL),
  };

  /**
   * Render targets recycled across passes and frames, by size and format. Every pass draws a
   * full-screen triangle over its whole target and never blends, so a recycled target needs no
   * clearing. A target idle for two frames is deleted, and idle targets never hold more than
   * `POOL_IDLE_BYTES`: past it the least recently released one goes (a frame with many distinct
   * raster sizes would otherwise keep every one of them until the frame ends).
   */
  const idle = new Map<string, Target[]>();
  /** Idle targets in release order, oldest first. */
  const idleOrder = new Set<Target>();
  let idleBytes = 0;
  const pooled = new Set<Target>();
  let frameNumber = 0;
  const takeIdle = (t: Target) => {
    if (idleOrder.delete(t)) idleBytes -= t.bytesHeld ?? 0;
  };
  const deleteTarget = (t: Target) => {
    takeIdle(t);
    pooled.delete(t);
    gl.deleteTexture(t.texture);
    if (t.framebuffer !== null) gl.deleteFramebuffer(t.framebuffer);
  };
  const trimBytes = () => {
    for (const t of idleOrder) {
      if (idleBytes <= POOL_IDLE_BYTES) return;
      const list = idle.get(t.poolKey ?? "");
      if (list !== undefined) {
        list.splice(list.indexOf(t), 1);
        if (list.length === 0) idle.delete(t.poolKey ?? "");
      }
      deleteTarget(t);
    }
  };
  const trimPool = () => {
    for (const [key, list] of idle) {
      const keep = list.filter((t) => {
        const stale = (t.released ?? 0) <= frameNumber - 2;
        if (stale) deleteTarget(t);
        return !stale;
      });
      if (keep.length === 0) idle.delete(key);
      else idle.set(key, keep);
    }
    trimBytes();
  };
  const empty = makeTexture(gl, 1, 1, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null);

  const composite = (plan: FramePlan): RasterImage => {
    frameNumber++;
    const live = new Set<Target>();
    const fits = (width: number, height: number) => {
      if (width > maxSize || height > maxSize)
        throw new CompositorError(
          `a ${width}×${height} image exceeds this GPU's texture size limit of ${maxSize}`,
        );
    };
    const target = (width: number, height: number, bytes = false): Target => {
      fits(width, height);
      const poolKey = `${width}x${height}${bytes ? "b" : "h"}`;
      const reused = idle.get(poolKey)?.pop();
      if (reused !== undefined) {
        takeIdle(reused);
        live.add(reused);
        return reused;
      }
      const texture = bytes
        ? makeTexture(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null)
        : makeTexture(gl, width, height, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null);
      const t: Target = {
        texture,
        framebuffer: null,
        width,
        height,
        poolKey,
        bytesHeld: width * height * (bytes ? 4 : 8),
      };
      live.add(t); // registered before attaching, so a failed attach is still freed
      t.framebuffer = attach(gl, texture); // completeness is checked once per pooled target
      pooled.add(t);
      return t;
    };
    /** Pooled targets go back to the pool; textures made outside `target` are deleted. */
    const free = (t: Target) => {
      if (!live.delete(t)) return;
      if (t.poolKey === undefined) {
        gl.deleteTexture(t.texture);
        return;
      }
      t.released = frameNumber;
      const list = idle.get(t.poolKey);
      if (list === undefined) idle.set(t.poolKey, [t]);
      else list.push(t);
      idleOrder.add(t);
      idleBytes += t.bytesHeld ?? 0;
      trimBytes();
    };
    /** Registers a texture made outside `target`, so the frame frees it on every path. */
    const track = (texture: WebGLTexture, width: number, height: number): Target => {
      const t = { texture, framebuffer: null, width, height };
      live.add(t);
      return t;
    };
    const upload = (raster: RasterImage): Target => {
      fits(raster.width, raster.height);
      const texture = makeTexture(
        gl,
        raster.width,
        raster.height,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        raster.pixels,
      );
      return track(texture, raster.width, raster.height);
    };

    const pass = (
      prog: Program,
      into: Target,
      textures: [string, WebGLTexture][],
      set: (u: (name: string) => WebGLUniformLocation | null) => void,
    ) => {
      gl.useProgram(prog.program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
      gl.viewport(0, 0, into.width, into.height);
      textures.forEach(([name, texture], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(uniform(gl, prog, name), unit);
      });
      set((name) => uniform(gl, prog, name));
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const nested = new Map<FramePlan, Target>();
    const uses = precompUses(plan);
    let remainingEffectSamples = MAX_FRAME_EFFECT_SAMPLES;
    const chargeSamples = (id: string, samples: number, reduce: string) => {
      remainingEffectSamples -= samples;
      if (remainingEffectSamples < 0)
        throw new CompositorError(
          `layer '${id}' exceeds the frame budget of ${MAX_FRAME_EFFECT_SAMPLES} effect samples; reduce the ${reduce}`,
        );
    };
    const chargeEffects = (
      width: number,
      height: number,
      effects: readonly ResolvedEffect[],
      id: string,
    ) =>
      chargeSamples(
        id,
        width * height * effects.reduce((sum, effect) => sum + effectSamples(effect), 0),
        "radius, layer size or number of effects",
      );

    const uploadMask = (mask: CoverageImage | null): Target | null =>
      mask === null
        ? null
        : track(
            makeTexture(
              gl,
              mask.width,
              mask.height,
              gl.R8,
              gl.RED,
              gl.UNSIGNED_BYTE,
              mask.coverage,
            ),
            mask.width,
            mask.height,
          );

    const gaussian = (src: Target, radius: number): Target => {
      if (radius === 0) return src;
      const weights = new Float32Array(gaussianWeights(radius));
      const tmp = target(src.width, src.height);
      const out = target(src.width, src.height);
      const blur = (from: Target, into: Target, x: number, y: number) =>
        pass(fixed.gaussian(), into, [["u_src", from.texture]], (u) => {
          gl.uniform2i(u("u_axis"), x, y);
          gl.uniform1i(u("u_radius"), weights.length - 1);
          gl.uniform1fv(u("u_weights[0]"), weights);
        });
      blur(src, tmp, 1, 0);
      blur(tmp, out, 0, 1);
      free(tmp);
      return out;
    };

    const applyEffect = (
      src: Target,
      effect: ResolvedEffect,
      pad: readonly [number, number],
    ): Target => {
      if (effect.type === "gaussian-blur") return gaussian(src, effect.radius);
      const blurred =
        effect.type === "drop-shadow" || effect.type === "glow"
          ? gaussian(src, effect.radius)
          : src;
      const out = target(src.width, src.height);
      const effectMode = EFFECT_MODES[effect.type] as EffectMode;
      pass(
        program(`effect:${effectMode}`, () => effectShader(effectMode)),
        out,
        [
          ["u_src", src.texture],
          ["u_blur", blurred.texture],
        ],
        (u) => {
          gl.uniform2i(u("u_origin"), pad[0], pad[1]);
          gl.uniform2i(u("u_inner"), src.width - 2 * pad[0], src.height - 2 * pad[1]);
          const params = (x: number, y: number) => gl.uniform2f(u("u_params"), x, y);
          const color = (name: string, { r, g, b, a }: Rgba) => gl.uniform4f(u(name), r, g, b, a);
          const amount = (value: number) => gl.uniform1f(u("u_amount"), value);
          switch (effect.type) {
            case "drop-shadow":
              params(...effect.offset);
              color("u_color", effect.color);
              amount(effect.opacity);
              break;
            case "glow":
              color("u_color", effect.color);
              amount(effect.intensity);
              break;
            case "brightness-contrast":
              params(effect.brightness, effect.contrast);
              break;
            case "hue-saturation":
              params(effect.hue, effect.saturation);
              break;
            case "tint":
              color("u_color", effect.black);
              color("u_white", effect.white);
              amount(effect.amount);
              break;
            case "fill":
              color("u_color", effect.color);
              amount(effect.amount);
              break;
            case "vignette":
              params(effect.radius, effect.feather);
              color("u_color", effect.color);
              amount(effect.amount);
              break;
            case "grain":
              gl.uniform1ui(u("u_seed"), effect.seed);
              gl.uniform1i(u("u_frame"), effect.frame);
              gl.uniform1i(u("u_size"), effect.size);
              gl.uniform1i(u("u_monochrome"), effect.monochrome ? 1 : 0);
              amount(effect.amount);
              break;
            case "chromatic-aberration":
              amount(effect.amount);
              break;
            case "posterize":
              amount(effect.levels);
              break;
            case "scanlines":
              params(effect.spacing, effect.thickness);
              gl.uniform1f(u("u_offset"), effect.offset);
              color("u_color", effect.color);
              amount(effect.amount);
              break;
          }
        },
      );
      if (blurred !== src) free(blurred);
      return out;
    };

    /** The original target belongs to the caller. Intermediates are freed after their last read. */
    const filter = (
      src: Target,
      effects: readonly ResolvedEffect[],
      pad: readonly [number, number],
    ): Target => {
      let out = src;
      for (const effect of effects) {
        const next = applyEffect(out, effect, pad);
        if (out !== src && out !== next) free(out);
        out = next;
      }
      return out;
    };

    /** Draws a generator into a fresh `width × height` layer-space target. */
    const generate = (id: string, width: number, height: number, g: ResolvedGenerator): Target => {
      chargeSamples(id, width * height * generatorSamples(g), "layer size or noise octaves");
      const out = target(width, height);
      pass(
        program(`generator:${g.type}`, () => generatorShader(g.type)),
        out,
        [],
        (u) => {
          const color = (name: string, { r, g, b, a }: Rgba) => gl.uniform4f(u(name), r, g, b, a);
          const colors = (list: readonly Rgba[]) => {
            gl.uniform4fv(
              u("u_colors[0]"),
              new Float32Array(list.flatMap(({ r, g, b, a }) => [r, g, b, a])),
            );
          };
          gl.uniform2f(u("u_size"), width, height);
          switch (g.type) {
            case "gradient":
              gl.uniform1i(u("u_kind"), { linear: 0, radial: 1, conic: 2 }[g.kind]);
              gl.uniform2f(u("u_a"), ...g.start);
              gl.uniform2f(u("u_b"), ...g.end);
              gl.uniform1i(u("u_count"), g.stops.length);
              gl.uniform1fv(u("u_offsets[0]"), new Float32Array(g.stops.map((s) => s.offset)));
              colors(g.stops.map((s) => s.color));
              break;
            case "noise":
              gl.uniform1ui(u("u_seed"), g.seed);
              gl.uniform1f(u("u_scale"), g.scale);
              gl.uniform1i(u("u_octaves"), g.octaves);
              gl.uniform1f(u("u_evolution"), g.evolution);
              gl.uniform2f(u("u_offset"), ...g.offset);
              color("u_low", g.low);
              color("u_high", g.high);
              break;
            case "pattern":
              gl.uniform1i(u("u_kind"), { stripes: 0, checker: 1, dots: 2, grid: 3 }[g.kind]);
              gl.uniform1f(u("u_scale"), g.size);
              gl.uniform1f(u("u_thickness"), g.thickness);
              gl.uniform2f(u("u_rotation"), ...g.rotation);
              gl.uniform2f(u("u_offset"), ...g.offset);
              color("u_low", g.background);
              color("u_high", g.foreground);
              break;
            case "aurora":
              gl.uniform1i(u("u_count"), g.colors.length);
              gl.uniform1f(u("u_scale"), g.sigma);
              gl.uniform2fv(u("u_points[0]"), new Float32Array(g.points.flat()));
              colors(g.colors);
              break;
          }
        },
      );
      return out;
    };

    /** The masked raster, generator or precomp, with room for effects before placement. */
    const prepare = (layer: PlannedLayer, padding: [number, number]): Target => {
      let src: Target;
      let owned = false;
      if (layer.type === "precomp") {
        src = nested.get(layer.frame) ?? compositeFloat(layer.frame);
        nested.set(layer.frame, src);
        // Freed after its last read, so memory does not grow with the number of distinct precomps.
        const left = (uses.get(layer.frame) ?? 1) - 1;
        uses.set(layer.frame, left);
        owned = left <= 0;
        if (owned) nested.delete(layer.frame);
      } else if (layer.type === "generator") {
        src = generate(layer.id, layer.width, layer.height, layer.generator);
        owned = true;
      } else {
        src = upload(layer.raster);
        owned = true;
      }
      const [x, y] = padding;
      const width = src.width + 2 * x;
      const height = src.height + 2 * y;
      const effects = layer.effects ?? [];
      chargeEffects(width, height, effects, layer.id);
      const out = target(width, height);
      const mask = uploadMask(layer.mask);
      pass(
        fixed.prepare(),
        out,
        [
          ["u_src", src.texture],
          ["u_mask", mask?.texture ?? empty],
        ],
        (u) => {
          gl.uniform1i(u("u_hasMask"), mask === null ? 0 : 1);
          gl.uniform2i(u("u_pad"), x, y);
        },
      );
      if (mask !== null) free(mask);
      if (owned) free(src);
      const effected = filter(out, effects, [x, y]);
      if (effected !== out) free(out);
      return effected;
    };

    /** The layer placed in composition space with matte and opacity, before blending. */
    const placed = (layer: PlannedLayer, width: number, height: number): Target => {
      const { chain, end } = matteChain(layer);
      let below: Target | null = null;
      for (let i = chain.length - 1; i >= 0; i--) {
        const current = chain[i] as PlannedLayer;
        const padding = effectPadding(current.effects ?? []);
        const src = prepare(current, padding);
        const inv = invert(placement(current, padding));
        const lod = inv === null ? 0 : levelOfDetail(inv, src.width, src.height);
        const k = Math.floor(lod);
        // The hi level is only sampled with a positive weight, so an exact level needs no next one.
        const top = lod > k ? Math.min(k + 1, maxLevel(src.width, src.height)) : k;
        const levels = [src];
        for (let n = 1; n <= top; n++) {
          const prev = levels[n - 1] as Target;
          const next = target(Math.ceil(prev.width / 2), Math.ceil(prev.height / 2));
          pass(fixed.downsample(), next, [["u_src", prev.texture]], () => {});
          levels.push(next);
        }
        const lo = levels[k] as Target;
        const hi = levels[top] as Target;
        const out = target(width, height);
        const mode = current.matte?.mode;
        const matted = i === chain.length - 1 ? end : "source";
        const matteMode = (
          mode === undefined || matted === "none" ? 0 : MATTE_MODES[mode]
        ) as MatteMode;
        const matteEmpty = matteMode !== 0 && (matted === "empty" || below === null);
        const shift = inv !== null && lod === 0 ? wholePixelShift(inv) : null;
        const copy = shift !== null && top === 0;
        pass(
          program(`place:${matteMode}${matteEmpty ? "e" : ""}${copy ? "c" : ""}`, () =>
            placeShader({ matte: matteMode, empty: matteEmpty, copy }),
          ),
          out,
          [
            ["u_lo", lo.texture],
            ["u_hi", hi.texture],
            ["u_matte", below?.texture ?? empty],
          ],
          (u) => {
            gl.uniform2f(u("u_scale"), 2 ** -k, 2 ** -top);
            gl.uniform1f(u("u_t"), top > k ? lod - k : 0);
            const [a, b, c, d, e, f] = inv ?? [0, 0, 0, 0, 0, 0];
            gl.uniform3f(u("u_invX"), a, c, e);
            gl.uniform3f(u("u_invY"), b, d, f);
            gl.uniform1i(u("u_visible"), inv === null ? 0 : 1);
            if (shift !== null) gl.uniform2i(u("u_shift"), shift[0], shift[1]);
            gl.uniform1f(u("u_opacity"), current.opacity);
          },
        );
        for (const level of levels) free(level);
        if (below !== null) free(below);
        below = out;
      }
      return below as Target;
    };

    const adjust = (layer: PlannedAdjustmentLayer, acc: Target): Target => {
      const { width, height } = acc;
      chargeEffects(width, height, layer.effects, layer.id);
      const src = filter(acc, layer.effects, [0, 0]);
      const source = layer.matte?.source;
      const matte = source == null ? null : placed(source, width, height);
      const mask = uploadMask(layer.mask);
      const out = target(width, height);
      pass(
        blendProgram(BLEND_MODE_IDS[layer.blendMode], true),
        out,
        [
          ["u_backdrop", acc.texture],
          ["u_source", src.texture],
          ["u_mask", mask?.texture ?? empty],
          ["u_matte", matte?.texture ?? empty],
        ],
        (u) => {
          gl.uniform1i(u("u_hasMask"), mask === null ? 0 : 1);
          gl.uniform1i(u("u_matteMode"), layer.matte === null ? 0 : MATTE_MODES[layer.matte.mode]);
          gl.uniform1i(u("u_matteEmpty"), matte === null ? 1 : 0);
          gl.uniform1f(u("u_opacity"), layer.opacity);
        },
      );
      if (src !== acc) free(src);
      if (matte !== null) free(matte);
      if (mask !== null) free(mask);
      return out;
    };

    /** Composites a plan into a fresh RGBA16F target of its size (no background). */
    const compositeFloat = (frame: FramePlan): Target => {
      let acc = target(frame.width, frame.height);
      clear(gl, acc);
      for (let i = frame.layers.length - 1; i >= 0; i--) {
        const layer = frame.layers[i];
        if (layer === undefined) continue;
        if (layer.type === "adjustment") {
          if (layer.effects.length === 0) continue;
          const next = adjust(layer, acc);
          free(acc);
          acc = next;
          continue;
        }
        const src = placed(layer, frame.width, frame.height);
        const next = target(frame.width, frame.height);
        pass(
          blendProgram(BLEND_MODE_IDS[layer.blendMode], false),
          next,
          [
            ["u_backdrop", acc.texture],
            ["u_source", src.texture],
            ["u_mask", empty],
            ["u_matte", empty],
          ],
          () => {},
        );
        free(src);
        free(acc);
        acc = next;
      }
      return acc;
    };

    // Errors left by the caller's own GL work would otherwise be reported as ours.
    for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++);
    let ok = false;
    try {
      const acc = compositeFloat(plan);
      const out = target(plan.width, plan.height, true);
      const bg = plan.background;
      pass(fixed.final(), out, [["u_acc", acc.texture]], (u) =>
        bg === null
          ? gl.uniform4f(u("u_background"), 0, 0, 0, 0)
          : gl.uniform4f(u("u_background"), bg.r * bg.a, bg.g * bg.a, bg.b * bg.a, bg.a),
      );
      const pixels = new Uint8Array(plan.width * plan.height * 4);
      gl.readPixels(0, 0, plan.width, plan.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      // A lost context or an out-of-memory allocation reads back zeros without throwing.
      if (gl.isContextLost()) throw new CompositorError("the WebGL2 context was lost");
      const error = gl.getError();
      if (error !== gl.NO_ERROR)
        throw new CompositorError(
          `WebGL error 0x${error.toString(16)} while compositing (often out of GPU memory)`,
        );
      ok = true;
      return { width: plan.width, height: plan.height, pixels };
    } finally {
      for (const t of [...live]) {
        // After a failure (out of memory, lost context) the targets are not trusted again.
        if (!ok && t.poolKey !== undefined) {
          live.delete(t);
          deleteTarget(t);
        } else free(t);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      trimPool();
    }
  };

  return {
    composite,
    renderer,
    dispose: () => {
      for (const p of programs.values()) gl.deleteProgram(p.program);
      programs.clear();
      for (const t of [...pooled]) deleteTarget(t);
      idle.clear();
      idleOrder.clear();
      idleBytes = 0;
      gl.deleteTexture(empty);
      gl.deleteVertexArray(vao);
    },
  };
}

/**
 * The integer offset of a placement that only translates by whole pixels (identity linear part),
 * else null. Then bilinear sampling at level 0 lands exactly on texel centers, so the shader can
 * copy one texel; the bound keeps every coordinate exact in float32.
 */
function wholePixelShift(inv: readonly number[]): [number, number] | null {
  const [a, b, c, d, e, f] = inv as [number, number, number, number, number, number];
  const limit = 2 ** 20;
  if (a !== 1 || b !== 0 || c !== 0 || d !== 1) return null;
  if (!Number.isInteger(e) || !Number.isInteger(f) || Math.abs(e) > limit || Math.abs(f) > limit)
    return null;
  return [e, f];
}

function build(gl: WebGL2RenderingContext, fragment: string): Program {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (shader === null) throw new CompositorError("could not create a shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new CompositorError(`shader compile failed: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const program = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new CompositorError(`program link failed: ${gl.getProgramInfoLog(program)}`);
  return { program, uniforms: new Map() };
}

function uniform(gl: WebGL2RenderingContext, prog: Program, name: string) {
  if (!prog.uniforms.has(name)) prog.uniforms.set(name, gl.getUniformLocation(prog.program, name));
  return prog.uniforms.get(name) ?? null;
}

function makeTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internal: number,
  format: number,
  type: number,
  data: ArrayBufferView | null,
): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
  // Only texelFetch reads these, but a texture must be complete: no mipmaps, nearest.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}

function attach(gl: WebGL2RenderingContext, texture: WebGLTexture): WebGLFramebuffer {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    throw new CompositorError("framebuffer incomplete");
  }
  return framebuffer;
}

function clear(gl: WebGL2RenderingContext, t: Target): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
  gl.viewport(0, 0, t.width, t.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
