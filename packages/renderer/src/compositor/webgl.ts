import type { FramePlan, PlannedLayer, RasterImage } from "../raster.js";
import {
  BLEND_MODE_IDS,
  invert,
  levelOfDetail,
  MATTE_MODES,
  matteChain,
  maxLevel,
  placement,
} from "./pipeline.js";
import { BLEND, DOWNSAMPLE, FINAL, PLACE, PREPARE, VERTEX } from "./shaders.js";

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
}

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

export function createCompositor(gl: WebGL2RenderingContext): Compositor {
  if (gl.getExtension("EXT_color_buffer_float") === null)
    throw new CompositorError("the WebGL2 context cannot render to float (RGBA16F) targets");
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(
    debug === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
  );
  const vao = gl.createVertexArray();
  const programs = {
    prepare: build(gl, PREPARE),
    downsample: build(gl, DOWNSAMPLE),
    place: build(gl, PLACE),
    blend: build(gl, BLEND),
    final: build(gl, FINAL),
  };
  const empty = makeTexture(gl, 1, 1, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null);

  const composite = (plan: FramePlan): RasterImage => {
    const live = new Set<Target>();
    const target = (width: number, height: number): Target => {
      if (width > maxSize || height > maxSize)
        throw new CompositorError(
          `a ${width}×${height} image exceeds this GPU's texture size limit of ${maxSize}`,
        );
      const t = makeTarget(gl, width, height);
      live.add(t);
      return t;
    };
    const free = (t: Target) => {
      if (!live.delete(t)) return;
      gl.deleteTexture(t.texture);
      if (t.framebuffer !== null) gl.deleteFramebuffer(t.framebuffer);
    };
    const upload = (raster: RasterImage): Target => {
      const texture = makeTexture(
        gl,
        raster.width,
        raster.height,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        raster.pixels,
      );
      const t = { texture, framebuffer: null, width: raster.width, height: raster.height };
      live.add(t);
      return t;
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

    /** The layer's raster (or composited precomp) times its mask, RGBA16F at raster size. */
    const prepare = (layer: PlannedLayer): Target => {
      let src: Target;
      let owned = false;
      if (layer.type === "precomp") {
        src = nested.get(layer.frame) ?? compositeFloat(layer.frame);
        nested.set(layer.frame, src);
      } else {
        src = upload(layer.raster);
        owned = true;
      }
      const out = target(src.width, src.height);
      const mask =
        layer.mask === null
          ? null
          : makeTexture(
              gl,
              layer.mask.width,
              layer.mask.height,
              gl.R8,
              gl.RED,
              gl.UNSIGNED_BYTE,
              layer.mask.coverage,
            );
      pass(
        programs.prepare,
        out,
        [
          ["u_src", src.texture],
          ["u_mask", mask ?? empty],
        ],
        (u) => gl.uniform1i(u("u_hasMask"), mask === null ? 0 : 1),
      );
      if (mask !== null) gl.deleteTexture(mask);
      if (owned) free(src);
      return out;
    };

    /** The layer placed in composition space with matte and opacity, before blending. */
    const placed = (layer: PlannedLayer, width: number, height: number): Target => {
      const { chain, end } = matteChain(layer);
      let below: Target | null = null;
      for (let i = chain.length - 1; i >= 0; i--) {
        const current = chain[i] as PlannedLayer;
        const src = prepare(current);
        const inv = invert(placement(current));
        const lod = inv === null ? 0 : levelOfDetail(inv, src.width, src.height);
        const k = Math.floor(lod);
        const top = Math.min(k + 1, maxLevel(src.width, src.height));
        const levels = [src];
        for (let n = 1; n <= top; n++) {
          const prev = levels[n - 1] as Target;
          const next = target(Math.ceil(prev.width / 2), Math.ceil(prev.height / 2));
          pass(programs.downsample, next, [["u_src", prev.texture]], () => {});
          levels.push(next);
        }
        const lo = levels[k] as Target;
        const hi = levels[top] as Target;
        const out = target(width, height);
        const mode = current.matte?.mode;
        const matted = i === chain.length - 1 ? end : "source";
        const matteMode = mode === undefined || matted === "none" ? 0 : MATTE_MODES[mode];
        pass(
          programs.place,
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
            gl.uniform1i(u("u_matteMode"), matteMode);
            gl.uniform1i(u("u_matteEmpty"), matted === "empty" || below === null ? 1 : 0);
            gl.uniform1f(u("u_opacity"), current.opacity);
          },
        );
        for (const level of levels) free(level);
        if (below !== null) free(below);
        below = out;
      }
      return below as Target;
    };

    /** Composites a plan into a fresh RGBA16F target of its size (no background). */
    const compositeFloat = (frame: FramePlan): Target => {
      let acc = target(frame.width, frame.height);
      clear(gl, acc);
      for (let i = frame.layers.length - 1; i >= 0; i--) {
        const layer = frame.layers[i];
        if (layer === undefined) continue;
        const src = placed(layer, frame.width, frame.height);
        const next = target(frame.width, frame.height);
        pass(
          programs.blend,
          next,
          [
            ["u_backdrop", acc.texture],
            ["u_source", src.texture],
          ],
          (u) => gl.uniform1i(u("u_mode"), BLEND_MODE_IDS[layer.blendMode]),
        );
        free(src);
        free(acc);
        acc = next;
      }
      return acc;
    };

    try {
      const acc = compositeFloat(plan);
      const out = makeByteTarget(gl, plan.width, plan.height);
      const bg = plan.background;
      pass(programs.final, out, [["u_acc", acc.texture]], (u) =>
        bg === null
          ? gl.uniform4f(u("u_background"), 0, 0, 0, 0)
          : gl.uniform4f(u("u_background"), bg.r * bg.a, bg.g * bg.a, bg.b * bg.a, bg.a),
      );
      const pixels = new Uint8Array(plan.width * plan.height * 4);
      gl.readPixels(0, 0, plan.width, plan.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.deleteTexture(out.texture);
      gl.deleteFramebuffer(out.framebuffer);
      return { width: plan.width, height: plan.height, pixels };
    } finally {
      for (const t of [...live]) free(t);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  };

  return {
    composite,
    renderer,
    dispose: () => {
      for (const p of Object.values(programs)) gl.deleteProgram(p.program);
      gl.deleteTexture(empty);
      gl.deleteVertexArray(vao);
    },
  };
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
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    throw new CompositorError("framebuffer incomplete");
  return framebuffer;
}

function makeTarget(gl: WebGL2RenderingContext, width: number, height: number): Target {
  const texture = makeTexture(gl, width, height, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null);
  return { texture, framebuffer: attach(gl, texture), width, height };
}

function makeByteTarget(gl: WebGL2RenderingContext, width: number, height: number) {
  const texture = makeTexture(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return { texture, framebuffer: attach(gl, texture), width, height };
}

function clear(gl: WebGL2RenderingContext, t: Target): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
  gl.viewport(0, 0, t.width, t.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
