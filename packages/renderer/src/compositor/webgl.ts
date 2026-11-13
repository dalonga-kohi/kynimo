import type { ResolvedEffect, ResolvedGenerator, ResolvedShader, Rgba } from "@kynimo/engine";
import { MAX_PROJECT_DEFINITIONS } from "@kynimo/scene";
import { FrameDeformWork } from "../deform.js";
import type {
  CoverageImage,
  FramePlan,
  PlannedAdjustmentLayer,
  PlannedDeform,
  PlannedLayer,
  RasterImage,
} from "../raster.js";
import { compiledShader, MAX_FRAME_SHADER_WORK } from "./custom-shader.js";
import {
  effectPadding,
  effectSamples,
  gaussianWeights,
  generatorSamples,
  MAX_FRAME_EFFECT_SAMPLES,
  transitionSamples,
} from "./effects.js";
import {
  BLEND_MODE_IDS,
  invert,
  layerProjection,
  levelOfDetail,
  MATTE_MODES,
  MAX_PROJECTIVE_LEVEL,
  matteChain,
  maxLevel,
  NEAR,
  placement,
  precompUses,
  projectiveInvert,
  projectivePlacement,
  samplePlacement,
} from "./pipeline.js";
import {
  blendShader,
  COPY,
  DEFORM,
  DEFORM_VERTEX,
  DIRECT,
  DOWNSAMPLE,
  type EffectMode,
  effectShader,
  FINAL,
  GAUSSIAN,
  generatorShader,
  type MatteMode,
  PREPARE,
  PROJECTIVE_LEVELS,
  placeShader,
  transitionShader,
  VERTEX,
} from "./shaders.js";
import { transitionUniforms } from "./transition.js";

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

const EFFECT_MODES: Readonly<
  Record<Exclude<ResolvedEffect["type"], "custom-shader">, EffectMode | 0>
> = {
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
  /**
   * Composites a frame plan into premultiplied sRGB RGBA8, rows top to bottom. With `prefix`, the
   * composited bottom layers of the root plan are kept, or taken from an earlier call
   * ({@link CompositePrefix}); the pixels are the same either way.
   */
  composite(plan: FramePlan, prefix?: CompositePrefix): RasterImage;
  /** Whether the bottom layers saved under `token` are still held. */
  hasPrefix(token: number): boolean;
  /** The `UNMASKED_RENDERER_WEBGL` string, for workers to check they run on SwiftShader. */
  readonly renderer: string;
  /** Frees the programs. The context itself belongs to the caller. */
  dispose(): void;
}

/**
 * Reuse of the root plan's bottom layers across frames, for callers that know those layers did not
 * change (an export, whose frames mostly differ in a few layers). One result is held at a time:
 *
 * - `save`: the plan is whole; the frame composited from its bottom `layers` layers is kept under
 *   the token `save`, replacing any earlier one.
 * - `use`: the plan holds only the layers above the ones saved under this token, at the same size.
 *
 * A call without `use` drops what was saved, as does a frame that fails.
 */
export type CompositePrefix = { save: number; layers: number } | { use: number };

/** Most bytes of released render targets the compositor keeps for reuse. */
const POOL_IDLE_BYTES = 64 * 1024 * 1024;

export function createCompositor(gl: WebGL2RenderingContext): Compositor {
  if (gl.getExtension("EXT_color_buffer_float") === null)
    throw new CompositorError("the WebGL2 context cannot render to float (RGBA16F) targets");
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  // A projective placement binds one sampler per mip level plus the matte, with a spare.
  const units = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
  if (units < PROJECTIVE_LEVELS + 2)
    throw new CompositorError(
      `the WebGL2 context has ${units} texture units per shader; 3D layers need ${PROJECTIVE_LEVELS + 2}`,
    );
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(
    debug === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
  );
  const vao = gl.createVertexArray();
  const blendProgram = (mode: number, adjustment: boolean) =>
    program(`blend:${mode}${adjustment ? "a" : ""}`, () => blendShader(mode, adjustment));
  /** Programs by variant key, compiled on first use and kept until `dispose`. */
  const programs = new Map<string, Program>();
  const program = (key: string, fragment: () => string, vertex = VERTEX): Program => {
    let p = programs.get(key);
    if (p === undefined) {
      p = build(gl, fragment(), vertex);
      programs.set(key, p);
    }
    return p;
  };
  const shaderPrograms = new Map<string, Program>();
  const shaderProgram = (fragment: string): Program => {
    const cached = shaderPrograms.get(fragment);
    if (cached !== undefined) return cached;
    const next = build(gl, fragment);
    if (shaderPrograms.size >= MAX_PROJECT_DEFINITIONS) {
      const oldest = shaderPrograms.keys().next().value;
      if (oldest !== undefined) {
        const previous = shaderPrograms.get(oldest);
        if (previous !== undefined) gl.deleteProgram(previous.program);
        shaderPrograms.delete(oldest);
      }
    }
    shaderPrograms.set(fragment, next);
    return next;
  };
  const fixed = {
    prepare: () => program("prepare", () => PREPARE),
    deform: () => program("deform", () => DEFORM, DEFORM_VERTEX),
    gaussian: () => program("gaussian", () => GAUSSIAN),
    downsample: () => program("downsample", () => DOWNSAMPLE),
    final: () => program("final", () => FINAL),
    copy: () => program("copy", () => COPY),
    direct: () => program("direct", () => DIRECT),
  };
  let deformGeometry: { array: WebGLVertexArrayObject; buffer: WebGLBuffer } | undefined;

  const drawDeform = (
    warp: PlannedDeform,
    into: Target,
    src: Target,
    mask: Target | null,
    [x, y]: [number, number],
  ) => {
    const caps = [
      gl.BLEND,
      gl.DEPTH_TEST,
      gl.CULL_FACE,
      gl.SCISSOR_TEST,
      gl.STENCIL_TEST,
      gl.RASTERIZER_DISCARD,
    ].filter((cap) => gl.isEnabled(cap));
    const previousArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const previousBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const previousMask = gl.getParameter(gl.COLOR_WRITEMASK) as [
      boolean,
      boolean,
      boolean,
      boolean,
    ];
    try {
      for (const cap of caps) gl.disable(cap);
      gl.colorMask(true, true, true, true);
      if (deformGeometry === undefined) {
        const array = gl.createVertexArray();
        const buffer = gl.createBuffer();
        if (array === null || buffer === null) {
          gl.deleteVertexArray(array);
          gl.deleteBuffer(buffer);
          throw new CompositorError("could not allocate the deform triangle buffer");
        }
        deformGeometry = { array, buffer };
        gl.bindVertexArray(array);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        for (let attr = 0; attr < 3; attr++) {
          gl.enableVertexAttribArray(attr);
          gl.vertexAttribPointer(attr, 4, gl.FLOAT, false, 48, 16 * attr);
        }
      } else {
        gl.bindVertexArray(deformGeometry.array);
        gl.bindBuffer(gl.ARRAY_BUFFER, deformGeometry.buffer);
      }
      // Every vertex passes all three corners as flat attributes for exact fragment barycentrics.
      const corners = new Float32Array(warp.vertices.length * 3);
      for (let i = 0; i < warp.vertices.length; i += 12) {
        const start = i * 3;
        for (let j = 0; j < 12; j++) {
          const value = warp.vertices[i + j] as number;
          corners[start + j] = value;
          corners[start + 12 + j] = value;
          corners[start + 24 + j] = value;
        }
      }
      gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STREAM_DRAW);
      const prog = fixed.deform();
      // Triangle passes write only part of a recycled target, including when the mesh folds.
      clear(gl, into);
      gl.useProgram(prog.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mask?.texture ?? empty);
      gl.uniform1i(uniform(gl, prog, "u_src"), 0);
      gl.uniform1i(uniform(gl, prog, "u_mask"), 1);
      gl.uniform1i(uniform(gl, prog, "u_hasMask"), mask === null ? 0 : 1);
      gl.uniform2f(uniform(gl, prog, "u_targetSize"), into.width, into.height);
      gl.uniform2f(uniform(gl, prog, "u_pad"), x, y);
      gl.drawArrays(gl.TRIANGLES, 0, warp.vertices.length / 4);
    } finally {
      gl.bindVertexArray(previousArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer);
      gl.colorMask(...previousMask);
      for (const cap of caps) gl.enable(cap);
    }
  };

  /**
   * Render targets recycled across passes and frames, by size and format. Passes that cover only
   * part of the target or blend into it clear first. A target idle for two frames is deleted, and
   * idle targets never hold more than
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
  /** The saved bottom layers ({@link CompositePrefix}); the target is outside the pool's lists. */
  let saved: { token: number; target: Target } | undefined;
  const dropSaved = () => {
    if (saved !== undefined) deleteTarget(saved.target);
    saved = undefined;
  };

  const composite = (plan: FramePlan, prefix?: CompositePrefix): RasterImage => {
    gl.disable(gl.BLEND); // a previous frame may have failed with blending on
    frameNumber++;
    if (prefix === undefined || !("use" in prefix)) dropSaved();
    else if (
      saved?.token !== prefix.use ||
      saved.target.width !== plan.width ||
      saved.target.height !== plan.height
    )
      throw new CompositorError("the saved bottom layers of this frame are gone");
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
      /** The pixels of `into` to draw; all of them by default. */
      view: Bounds = { x: 0, y: 0, width: into.width, height: into.height },
    ) => {
      gl.useProgram(prog.program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
      // The triangle is clipped to the viewport, so only these pixels are shaded.
      gl.viewport(view.x, view.y, view.width, view.height);
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
    const deformWork = new FrameDeformWork();
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

    let remainingShaderWork = MAX_FRAME_SHADER_WORK;
    const customShader = (
      id: string,
      width: number,
      height: number,
      shader: ResolvedShader,
      src?: Target,
    ) => {
      const compiled = compiledShader(shader.definition);
      remainingShaderWork -= width * height * compiled.work;
      if (remainingShaderWork < 0)
        throw new CompositorError(
          `layer '${id}' exceeds the frame budget of ${MAX_FRAME_SHADER_WORK} custom shader work units`,
        );
      const out = target(width, height);
      pass(
        shaderProgram(compiled.fragment),
        out,
        src === undefined ? [] : [["k_input", src.texture]],
        (u) => {
          gl.uniform2f(u("k_size"), width, height);
          gl.uniform1f(u("k_frame"), shader.frame);
          gl.uniform1f(u("k_fps"), shader.fps);
          gl.uniform1f(u("k_seed"), shader.seed);
          shader.uniforms.forEach((value, i) => {
            const location = u(`k_u${i}`);
            switch (value.length) {
              case 1:
                gl.uniform1fv(location, value);
                break;
              case 2:
                gl.uniform2fv(location, value);
                break;
              case 3:
                gl.uniform3fv(location, value);
                break;
              case 4:
                gl.uniform4fv(location, value);
                break;
            }
          });
        },
      );
      return out;
    };

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
      id: string,
      src: Target,
      effect: ResolvedEffect,
      pad: readonly [number, number],
    ): Target => {
      if (effect.type === "custom-shader")
        return customShader(id, src.width, src.height, effect, src);
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
      id: string,
      src: Target,
      effects: readonly ResolvedEffect[],
      pad: readonly [number, number],
    ): Target => {
      let out = src;
      for (const effect of effects) {
        const next = applyEffect(id, out, effect, pad);
        if (out !== src && out !== next) free(out);
        out = next;
      }
      return out;
    };

    /** Draws a generator into a fresh `width × height` layer-space target. */
    const generate = (id: string, width: number, height: number, g: ResolvedGenerator): Target => {
      chargeSamples(id, width * height * generatorSamples(g), "layer size or noise octaves");
      if (g.type === "custom-shader") return customShader(id, width, height, g);
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

    /** The layer's own pixels as a texture; the caller frees it after reading when `owned`. */
    const source = (layer: PlannedLayer): { src: Target; owned: boolean } => {
      if (layer.type === "precomp") {
        const src = nested.get(layer.frame) ?? compositeFloat(layer.frame);
        nested.set(layer.frame, src);
        // Freed after its last read, so memory does not grow with the number of distinct precomps.
        const left = (uses.get(layer.frame) ?? 1) - 1;
        uses.set(layer.frame, left);
        const owned = left <= 0;
        if (owned) nested.delete(layer.frame);
        return { src, owned };
      }
      if (layer.type === "generator")
        return {
          src: generate(layer.id, layer.width, layer.height, layer.generator),
          owned: true,
        };
      return { src: upload(layer.raster), owned: true };
    };

    /**
     * Composites a layer onto `acc` in one pass when all it needs is its mask, a whole-pixel offset
     * and opacity under the normal blend mode: most layers of most frames. Returns false, having
     * done nothing, for any other layer. The result is the same bits as the general path's.
     */
    const direct = (layer: PlannedLayer, acc: Target): boolean => {
      if (layer.blendMode !== "normal" || layer.matte !== null) return false;
      if ((layer.effects ?? []).length > 0 || (layer.motion ?? null) !== null) return false;
      if (layer.space === "layer" && layer.deform !== undefined) return false;
      if (layerProjection(layer) !== null) return false;
      const inv = invert(placement(layer));
      const shift = inv === null ? null : wholePixelShift(inv);
      if (shift === null) return false;
      const { src, owned } = source(layer);
      // Source texel (0, 0) sits on composition pixel −shift; draw where the two overlap.
      const x = Math.max(0, -shift[0]);
      const y = Math.max(0, -shift[1]);
      const width = Math.min(acc.width, src.width - shift[0]) - x;
      const height = Math.min(acc.height, src.height - shift[1]) - y;
      if (width > 0 && height > 0) {
        const mask = uploadMask(layer.mask);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        try {
          pass(
            fixed.direct(),
            acc,
            [
              ["u_src", src.texture],
              ["u_mask", mask?.texture ?? empty],
            ],
            (u) => {
              gl.uniform1i(u("u_hasMask"), mask === null ? 0 : 1);
              gl.uniform2i(u("u_shift"), shift[0], shift[1]);
              gl.uniform1f(u("u_opacity"), layer.opacity);
            },
            { x, y, width, height },
          );
        } finally {
          gl.disable(gl.BLEND);
        }
        if (mask !== null) free(mask);
      }
      if (owned) free(src);
      return true;
    };

    /** The masked and optionally deformed source, with room for effects before placement. */
    const prepare = (layer: PlannedLayer, padding: [number, number]): Target => {
      const warp = layer.space === "layer" ? layer.deform : undefined;
      if (warp !== undefined) deformWork.charge(layer.id, warp.drawWork);
      const { src, owned } = source(layer);
      const [x, y] = padding;
      const width = (warp?.width ?? src.width) + 2 * x;
      const height = (warp?.height ?? src.height) + 2 * y;
      if (warp !== undefined && (width > maxSize || height > maxSize))
        throw new CompositorError(
          `layer '${layer.id}' exceeds this GPU's deform target size limit of ${maxSize}; reduce pin displacement, layer size or effect radius`,
        );
      const effects = layer.effects ?? [];
      chargeEffects(width, height, effects, layer.id);
      const out = target(width, height);
      const mask = uploadMask(layer.mask);
      if (warp !== undefined) drawDeform(warp, out, src, mask, padding);
      else
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
      const effected = filter(layer.id, out, effects, [x, y]);
      if (effected !== out) free(out);
      return effected;
    };

    /** Copies `region` into the same pixels of `into`; with `over`, composites it there (normal blend). */
    const copyInto = (into: Target, region: Region, over = false) => {
      if (over) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      try {
        pass(
          fixed.copy(),
          into,
          [["u_src", region.target.texture]],
          (u) => gl.uniform2i(u("u_origin"), region.x, region.y),
          { x: region.x, y: region.y, width: region.target.width, height: region.target.height },
        );
      } finally {
        gl.disable(gl.BLEND);
      }
    };

    /** A region as a whole `width × height` target; takes ownership of the region's target. */
    const whole = (region: Region, width: number, height: number): Target => {
      const t = region.target;
      if (region.x === 0 && region.y === 0 && t.width === width && t.height === height) return t;
      const out = target(width, height);
      clear(gl, out);
      copyInto(out, region);
      free(t);
      return out;
    };

    /** Composites `region` onto the same pixels of `acc` with a blend mode; `acc` keeps the rest. */
    const blendInto = (acc: Target, region: Region, blendMode: number) => {
      if (blendMode === BLEND_MODE_IDS.normal) {
        copyInto(acc, region, true);
        return;
      }
      // A pass cannot read the target it writes: blend into a spare, then copy that back.
      const { target: src, x, y } = region;
      const mixed = target(src.width, src.height);
      pass(
        blendProgram(blendMode, false),
        mixed,
        [
          ["u_backdrop", acc.texture],
          ["u_source", src.texture],
        ],
        (u) => gl.uniform2i(u("u_origin"), x, y),
      );
      copyInto(acc, { target: mixed, x, y });
      free(mixed);
    };

    /**
     * The layer placed in composition space with matte and opacity, before blending: a target
     * holding the rectangle of the composition the layer can reach. It draws nothing outside.
     */
    const placed = (layer: PlannedLayer, width: number, height: number): Region => {
      const { chain, end } = matteChain(layer);
      let below: Region | null = null;
      for (let i = chain.length - 1; i >= 0; i--) {
        const current = chain[i] as PlannedLayer;
        const padding = effectPadding(current.effects ?? []);
        const motion = current.motion ?? null;
        // Charged up front (width × height per sample) so a huge blur fails before any work is done.
        if (motion !== null)
          chargeSamples(
            current.id,
            width * height * motion.length,
            "motion blur samples or number of blurred layers",
          );
        const src = prepare(current, padding);
        const mode = current.matte?.mode;
        const matted = i === chain.length - 1 ? end : "source";
        const matteMode = (
          mode === undefined || matted === "none" ? 0 : MATTE_MODES[mode]
        ) as MatteMode;
        const matteEmpty = matteMode !== 0 && (matted === "empty" || below === null);
        // A blurred layer is drawn once per shutter sample and summed into `out` (premultiplied,
        // additive blending); a plain layer is drawn once and replaces it.
        const draws = motion ?? [null];
        const projective = layerProjection(current) !== null;
        const plans = projective
          ? []
          : draws.map((sample) => {
              const forward =
                sample === null
                  ? placement(current, padding)
                  : samplePlacement(current, sample, padding);
              const inv = invert(forward);
              const lod = inv === null ? 0 : levelOfDetail(inv, src.width, src.height);
              const k = Math.floor(lod);
              // The hi level is only sampled with a positive weight, so an exact level needs no next one.
              const top = lod > k ? Math.min(k + 1, maxLevel(src.width, src.height)) : k;
              return { sample, forward, inv, lod, k, top };
            });
        // Only the pixels the layer can reach are drawn. A 3D layer may reach any of them.
        const bounds = projective
          ? { x: 0, y: 0, width, height }
          : enclose(
              plans.flatMap((p) =>
                p.inv === null ? [] : [reach(p.forward, src.width, src.height, p.top)],
              ),
              width,
              height,
            );
        const out = target(bounds.width, bounds.height);
        const origins = (u: (name: string) => WebGLUniformLocation | null) => {
          gl.uniform2f(u("u_origin"), bounds.x, bounds.y);
          gl.uniform2i(u("u_matteOrigin"), below?.x ?? 0, below?.y ?? 0);
        };
        const matteTexture = below?.target.texture ?? empty;
        // One mip chain per source, shared by every sample, built with blending off. A projective
        // layer's levels vary per pixel, so it gets the whole chain.
        const levels = [src];
        const deepest = projective
          ? Math.min(maxLevel(src.width, src.height), MAX_PROJECTIVE_LEVEL)
          : plans.reduce((m, p) => Math.max(m, p.top), 0);
        try {
          for (let n = 1; n <= deepest; n++) {
            const prev = levels[n - 1] as Target;
            const next = target(Math.ceil(prev.width / 2), Math.ceil(prev.height / 2));
            levels.push(next);
            pass(fixed.downsample(), next, [["u_src", prev.texture]], () => {});
          }
          if (motion !== null) clear(gl, out);
          if (projective)
            for (const sample of draws) {
              const inv = projectiveInvert(projectivePlacement(current, padding, sample));
              if (motion !== null) {
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.ONE, gl.ONE);
              }
              pass(
                program(`place:${matteMode}${matteEmpty ? "e" : ""}p`, () =>
                  placeShader({
                    matte: matteMode,
                    empty: matteEmpty,
                    copy: false,
                    projective: true,
                  }),
                ),
                out,
                [
                  ...Array.from({ length: PROJECTIVE_LEVELS }, (_, n): [string, WebGLTexture] => [
                    `u_l${n}`,
                    (levels[n] ?? { texture: empty }).texture,
                  ]),
                  ["u_matte", matteTexture],
                ],
                (u) => {
                  origins(u);
                  const m = inv ?? [0, 0, 0, 0, 0, 0, 0, 0, 0];
                  // GLSL matrices are column-major.
                  gl.uniformMatrix3fv(
                    u("u_inv"),
                    false,
                    new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]),
                  );
                  gl.uniform1f(u("u_near"), NEAR);
                  gl.uniform1i(u("u_maxLevel"), deepest);
                  gl.uniform1i(u("u_visible"), inv === null ? 0 : 1);
                  gl.uniform1f(
                    u("u_opacity"),
                    sample === null ? current.opacity : sample.opacity / draws.length,
                  );
                },
              );
            }
          else
            for (const { sample, inv, lod, k, top } of plans) {
              const lo = levels[k] as Target;
              const hi = levels[top] as Target;
              const shift =
                sample === null && inv !== null && lod === 0 ? wholePixelShift(inv) : null;
              const copy = shift !== null && top === 0;
              if (motion !== null) {
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.ONE, gl.ONE);
              }
              pass(
                program(`place:${matteMode}${matteEmpty ? "e" : ""}${copy ? "c" : ""}`, () =>
                  placeShader({ matte: matteMode, empty: matteEmpty, copy }),
                ),
                out,
                [
                  ["u_lo", lo.texture],
                  ["u_hi", hi.texture],
                  ["u_matte", matteTexture],
                ],
                (u) => {
                  origins(u);
                  gl.uniform2f(u("u_scale"), 2 ** -k, 2 ** -top);
                  gl.uniform1f(u("u_t"), top > k ? lod - k : 0);
                  const [a, b, c, d, e, f] = inv ?? [0, 0, 0, 0, 0, 0];
                  gl.uniform3f(u("u_invX"), a, c, e);
                  gl.uniform3f(u("u_invY"), b, d, f);
                  gl.uniform1i(u("u_visible"), inv === null ? 0 : 1);
                  if (shift !== null) gl.uniform2i(u("u_shift"), shift[0], shift[1]);
                  gl.uniform1f(
                    u("u_opacity"),
                    sample === null ? current.opacity : sample.opacity / draws.length,
                  );
                },
              );
            }
        } finally {
          gl.disable(gl.BLEND);
          for (const level of levels.slice(1)) free(level);
        }
        free(src);
        if (below !== null) free(below.target);
        below = { target: out, x: bounds.x, y: bounds.y };
      }
      return below as Region;
    };

    const adjust = (layer: PlannedAdjustmentLayer, acc: Target): Target => {
      const { width, height } = acc;
      chargeEffects(width, height, layer.effects, layer.id);
      const src = filter(layer.id, acc, layer.effects, [0, 0]);
      const source = layer.matte?.source;
      const matte = source == null ? null : whole(placed(source, width, height), width, height);
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
    const compositeFloat = (frame: FramePlan, reuse?: CompositePrefix): Target => {
      let acc = target(frame.width, frame.height);
      if (reuse !== undefined && "use" in reuse && saved !== undefined)
        copyInto(acc, { target: saved.target, x: 0, y: 0 });
      else clear(gl, acc);
      // Layers are drawn from the last index down; the bottom `layers` are done once `i` gets here.
      const saveAt =
        reuse !== undefined && "save" in reuse
          ? Math.max(0, frame.layers.length - reuse.layers) - 1
          : Number.NaN;
      const save = () => {
        if (reuse === undefined || !("save" in reuse)) return;
        const kept = target(acc.width, acc.height);
        copyInto(kept, { target: acc, x: 0, y: 0 });
        live.delete(kept); // outlives the frame
        saved = { token: reuse.save, target: kept };
      };
      for (let i = frame.layers.length - 1; i >= 0; i--) {
        if (i === saveAt) save();
        const layer = frame.layers[i];
        if (layer === undefined) continue;
        if (layer.type === "adjustment") {
          if (layer.effects.length === 0) continue;
          const next = adjust(layer, acc);
          free(acc);
          acc = next;
          continue;
        }
        const transition = layer.transition ?? null;
        // At progress 0 the result is the backdrop: the layer is still placed (budgets and skip
        // reports stay the same) but not blended or charged for a transition pass.
        const drawn = transition !== null && transition.progress > 0 ? transition : null;
        if (drawn !== null)
          chargeSamples(
            layer.id,
            frame.width * frame.height * transitionSamples(drawn.kind),
            "composition size or number of transitions",
          );
        if (transition === null && direct(layer, acc)) continue;
        const src = placed(layer, frame.width, frame.height);
        if (transition !== null && drawn === null) {
          free(src.target);
          continue;
        }
        if (drawn === null) {
          blendInto(acc, src, BLEND_MODE_IDS[layer.blendMode]);
          free(src.target);
          continue;
        }
        // A transition reads the frame below the layer (A) and the layer over it (B).
        const next = target(frame.width, frame.height);
        copyInto(next, { target: acc, x: 0, y: 0 });
        blendInto(next, src, BLEND_MODE_IDS[layer.blendMode]);
        free(src.target);
        const out = target(frame.width, frame.height);
        const uniforms = transitionUniforms(drawn, frame.width, frame.height);
        pass(
          program(`transition:${drawn.kind}`, () => transitionShader(drawn.kind)),
          out,
          [
            ["u_a", acc.texture],
            ["u_b", next.texture],
          ],
          (u) => {
            for (const [name, values] of Object.entries(uniforms)) {
              const location = u(`u_${name}`);
              const f = Float32Array.from(values);
              if (f.length === 1) gl.uniform1fv(location, f);
              else gl.uniform2fv(location, f);
            }
            if ("seed" in drawn) gl.uniform1ui(u("u_seed"), drawn.seed);
          },
        );
        free(acc);
        free(next);
        acc = out;
      }
      if (saveAt === -1) save();
      return acc;
    };

    // Errors left by the caller's own GL work would otherwise be reported as ours.
    for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++);
    let ok = false;
    try {
      const acc = compositeFloat(plan, prefix);
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
      if (!ok) dropSaved();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      trimPool();
    }
  };

  return {
    composite,
    hasPrefix: (token) => saved?.token === token,
    renderer,
    dispose: () => {
      saved = undefined; // its target is deleted with the pooled ones below
      for (const p of programs.values()) gl.deleteProgram(p.program);
      programs.clear();
      for (const p of shaderPrograms.values()) gl.deleteProgram(p.program);
      shaderPrograms.clear();
      for (const t of [...pooled]) deleteTarget(t);
      idle.clear();
      idleOrder.clear();
      idleBytes = 0;
      gl.deleteTexture(empty);
      gl.deleteVertexArray(vao);
      if (deformGeometry !== undefined) {
        gl.deleteVertexArray(deformGeometry.array);
        gl.deleteBuffer(deformGeometry.buffer);
      }
    },
  };
}

/** A rectangle of whole pixels. */
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A target holding the rectangle of a composition that starts at (`x`, `y`); the rest is transparent. */
interface Region {
  target: Target;
  x: number;
  y: number;
}

/** Region sizes are rounded up to this, so animated layers keep reusing pooled targets. */
const REGION_STEP = 32;

/**
 * Corners (x0, y0, x1, y1) of the composition rectangle a `width × height` source placed by
 * `forward` can colour when its deepest sampled mip level is `top`. Bilinear sampling at level L
 * reads texels up to 2^(L+1) level-0 texels past the source's edges, so the source rectangle
 * grows by that much before it is mapped.
 */
function reach(
  [a, b, c, d, e, f]: readonly number[],
  width: number,
  height: number,
  top: number,
): [number, number, number, number] {
  const m = 2 ** (top + 1);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [-m, -m],
    [width + m, -m],
    [-m, height + m],
    [width + m, height + m],
  ] as const) {
    xs.push((a as number) * x + (c as number) * y + (e as number));
    ys.push((b as number) * x + (d as number) * y + (f as number));
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * The whole-pixel rectangle inside a `width × height` composition that holds every box, with a
 * pixel of slack for the float32 inverse on the GPU. Never empty: a layer that reaches nothing
 * gets one pixel, which the placement pass then leaves transparent. Sizes are rounded up to
 * `REGION_STEP` (a larger rectangle only draws more transparent pixels).
 */
function enclose(
  boxes: readonly (readonly [number, number, number, number])[],
  width: number,
  height: number,
): Bounds {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    // A box that is not finite (a degenerate placement) may reach anything.
    if (!box.every(Number.isFinite)) return { x: 0, y: 0, width, height };
    x0 = Math.min(x0, box[0]);
    y0 = Math.min(y0, box[1]);
    x1 = Math.max(x1, box[2]);
    y1 = Math.max(y1, box[3]);
  }
  const span = (lo: number, hi: number, limit: number): [number, number] => {
    const from = Math.max(0, Math.floor(lo) - 1);
    const to = Math.min(limit, Math.ceil(hi) + 1);
    if (!(to > from)) return [0, 1];
    const size = Math.min(limit, Math.ceil((to - from) / REGION_STEP) * REGION_STEP);
    return [Math.min(from, limit - size), size];
  };
  const [x, w] = span(x0, x1, width);
  const [y, h] = span(y0, y1, height);
  return { x, y, width: w, height: h };
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

function build(gl: WebGL2RenderingContext, fragment: string, vertex = VERTEX): Program {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (shader === null) throw new CompositorError("could not create a shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new CompositorError(`shader compile failed: ${message}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  if (program === null) throw new CompositorError("could not create a shader program");
  let vs: WebGLShader | null = null;
  let fs: WebGLShader | null = null;
  try {
    vs = compile(gl.VERTEX_SHADER, vertex);
    fs = compile(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new CompositorError(`program link failed: ${gl.getProgramInfoLog(program)}`);
    return { program, uniforms: new Map() };
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  }
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
