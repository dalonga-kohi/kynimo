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
      const problem = await page.evaluate(
        ({ vertex, fragment }) => {
          const unavailable = (message: string) => ({
            kind: "ShaderValidationUnavailable",
            message,
          });
          const invalid = (message: string) => ({ kind: "ShaderSourceError", message });
          const gl = document.createElement("canvas").getContext("webgl2");
          if (gl === null) return unavailable("the pinned browser could not create WebGL2");
          const debug = gl.getExtension("WEBGL_debug_renderer_info");
          if (
            debug === null ||
            !/swiftshader/i.test(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
          )
            return unavailable("shader validation requires SwiftShader");
          const program = gl.createProgram();
          if (program === null) return unavailable("could not allocate a shader program");
          for (const [type, source] of [
            [gl.VERTEX_SHADER, vertex],
            [gl.FRAGMENT_SHADER, fragment],
          ] as const) {
            const shader = gl.createShader(type);
            if (shader === null) return unavailable("could not allocate a shader");
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
              if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR || type === gl.VERTEX_SHADER)
                return unavailable("the pinned browser could not compile the shader program");
              return invalid(gl.getShaderInfoLog(shader) || "shader compilation failed");
            }
            gl.attachShader(program, shader);
            gl.deleteShader(shader);
          }
          gl.linkProgram(program);
          const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
          if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR)
            return unavailable("the pinned browser could not link the shader program");
          return linked ? null : invalid(gl.getProgramInfoLog(program) || "shader linking failed");
        },
        { vertex: FULLSCREEN_VERTEX_SHADER, fragment },
      );
      if (problem !== null) throw new CaptureError(problem.message.slice(0, 300), problem.kind);
    };
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CaptureError(
              "shader compilation exceeded its deadline",
              "ShaderValidationUnavailable",
            ),
          ),
        SHADER_COMPILE_TIMEOUT_MS,
      );
    });
    await Promise.race([compile(), deadline]);
  } finally {
    clearTimeout(timer);
    await server.kill();
  }
}
