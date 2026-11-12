import { compileShader, FULLSCREEN_VERTEX_SHADER } from "@kynimo/renderer";
import type { ShaderDefinitionInput } from "@kynimo/scene";
import { chromium } from "playwright";
import { CaptureError, CHROMIUM_ARGS } from "./session.js";

export const SHADER_COMPILE_TIMEOUT_MS = 5_000;
const SHADER_BROWSER_TIMEOUT_MS = 10_000;

/** Validate the generated program on the worker's compiler in its own killable browser. */
export async function validateShaderProgram(definition: ShaderDefinitionInput): Promise<void> {
  const { fragment } = compileShader(definition);
  const server = await chromium.launchServer({
    host: "127.0.0.1",
    args: [...CHROMIUM_ARGS],
    timeout: SHADER_BROWSER_TIMEOUT_MS,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const compile = async () => {
      const browser = await chromium.connect(server.wsEndpoint(), {
        timeout: SHADER_COMPILE_TIMEOUT_MS,
      });
      const page = await browser.newPage({ serviceWorkers: "block" });
      const error = await page.evaluate(
        ({ vertex, fragment }) => {
          const gl = document.createElement("canvas").getContext("webgl2");
          if (gl === null) return "the pinned browser could not create WebGL2";
          const debug = gl.getExtension("WEBGL_debug_renderer_info");
          if (
            debug === null ||
            !/swiftshader/i.test(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
          )
            return "shader validation requires SwiftShader";
          const program = gl.createProgram();
          if (program === null) return "could not allocate a shader program";
          for (const [type, source] of [
            [gl.VERTEX_SHADER, vertex],
            [gl.FRAGMENT_SHADER, fragment],
          ] as const) {
            const shader = gl.createShader(type);
            if (shader === null) return "could not allocate a shader";
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
              return gl.getShaderInfoLog(shader) || "shader compilation failed";
            gl.attachShader(program, shader);
            gl.deleteShader(shader);
          }
          gl.linkProgram(program);
          return gl.getProgramParameter(program, gl.LINK_STATUS)
            ? null
            : gl.getProgramInfoLog(program) || "shader linking failed";
        },
        { vertex: FULLSCREEN_VERTEX_SHADER, fragment },
      );
      if (error !== null) throw new CaptureError(error.slice(0, 300), "ShaderSourceError");
    };
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new CaptureError("shader compilation exceeded its deadline", "ShaderSourceError")),
        SHADER_COMPILE_TIMEOUT_MS,
      );
    });
    await Promise.race([compile(), deadline]);
  } finally {
    clearTimeout(timer);
    await server.kill();
  }
}
