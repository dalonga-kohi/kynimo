import type { ShaderDefinitionInput } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { compileShader, ShaderSourceError } from "./custom-shader.js";

const definition = (
  source: string,
  kind: ShaderDefinitionInput["kind"] = "generator",
): ShaderDefinitionInput => ({
  id: "custom-test",
  title: "Test",
  version: "1.0.0",
  kind,
  source,
  uniforms: { u_tint: { type: "vec3", default: [1, 1, 1] } },
});

describe("bounded shader source", () => {
  it("evaluates typed vectors, locals, frame inputs and premultiplied output", () => {
    const program = compileShader(
      definition("vec3 color = u_tint * (frame / fps); return vec4(color.bgr, 0.5);"),
    );
    const render = program.reference({
      width: 4,
      height: 4,
      frame: 15,
      fps: 30,
      seed: 0,
      uniforms: [[1, 0.5, 0.25]],
    });
    const rgba = new Float64Array(4);
    render(1, 1, rgba, 0);
    expect([...rgba]).toEqual([0.0625, 0.125, 0.25, 0.5]);
  });

  it.each([
    ["#extension GL_EXT_shader_texture_lod : enable\nreturn vec4(1.0);", "unsupported token"],
    ["while (true) {}", "unsupported token"],
    ["return texture(u_sampler, uv);", "unknown shader value"],
    ["return sampleInput(uv);", "unknown shader function"],
    ["return vec4(uv.b, 0.0, 0.0, 1.0);", "swizzle exceeds vector width"],
    ["vec2 x = u_tint; return vec4(x, 0.0, 1.0);", "local declaration has the wrong type"],
    ["return vec4(uv + u_tint, 1.0);", "vector widths must match"],
    ["return 1.0;", "shader must return vec4"],
    ["return vec4(1.0); return vec4(0.0);", "unexpected source after return"],
    [`return vec4(${"1.0 + ".repeat(100)}0.0);`, "tokens"],
  ])("rejects unsupported or invalid input %s", (source, message) => {
    expect(() => compileShader(definition(source))).toThrow(new RegExp(message));
  });

  it("bounds input reads for effects", () => {
    const source = "return sampleInput(uv) + sampleInput(uv) + sampleInput(uv) + sampleInput(uv)";
    expect(compileShader(definition(`${source};`, "effect")).work).toBeGreaterThan(32);
    expect(() => compileShader(definition(`${source} + sampleInput(uv);`, "effect"))).toThrow(
      ShaderSourceError,
    );
  });
});
