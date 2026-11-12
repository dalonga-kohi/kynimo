import { MAX_SHADER_SOURCE, MAX_SHADER_VALUE, type ShaderDefinitionInput } from "@kynimo/scene";

export const MAX_SHADER_TOKENS = 192;
export const MAX_SHADER_SAMPLES = 4;
export const MAX_FRAME_SHADER_WORK = 128_000_000;

type Width = 1 | 2 | 3 | 4;
type Register = { slot: number; width: Width };
type Instruction = (values: Float32Array, sample: ShaderSample | undefined) => void;
type ShaderSample = (u: number, v: number, out: Float32Array, offset: number) => void;
const widths = { float: 1, vec2: 2, vec3: 3, vec4: 4 } as const;
const types = ["", "float", "vec2", "vec3", "vec4"] as const;
const channels = "xyzw";
const max = MAX_SHADER_VALUE;
const clip = (x: number) => Math.min(max, Math.max(-max, x));
const unit = (x: number) => Math.min(1, Math.max(0, x));
const epsilon = Math.fround(0.000001);
const divisor = (x: number) => (x < 0 ? -1 : 1) * Math.max(Math.abs(x), epsilon);

const inputs = [
  ["uv", 2],
  ["pixel", 2],
  ["resolution", 2],
  ["frame", 1],
  ["fps", 1],
  ["seed", 1],
] as const;

export interface ShaderDraw {
  width: number;
  height: number;
  frame: number;
  fps: number;
  seed: number;
  uniforms: readonly (readonly number[])[];
}

export interface CompiledShader {
  fragment: string;
  work: number;
  /** A reference evaluator for one draw. It writes premultiplied RGBA into the destination. */
  reference(
    draw: ShaderDraw,
    sample?: ShaderSample,
  ): (x: number, y: number, out: Float64Array, offset: number) => void;
}

export class ShaderSourceError extends Error {
  override name = "ShaderSourceError";
}

type Token = { text: string; offset: number };
const identifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function tokenize(source: string): Token[] {
  if (source.length > MAX_SHADER_SOURCE) throw new ShaderSourceError("shader source is too long");
  const next =
    /(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)|([a-zA-Z_][a-zA-Z0-9_]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[.,;=()+*/-])/y;
  const tokens: Token[] = [];
  for (let offset = 0; offset < source.length; offset = next.lastIndex) {
    const match = next.exec(source);
    if (match === null)
      throw new ShaderSourceError(`unsupported token at source character ${offset + 1}`);
    if (match[1] !== undefined) tokens.push({ text: match[1], offset });
    if (tokens.length > MAX_SHADER_TOKENS)
      throw new ShaderSourceError(`shader source exceeds ${MAX_SHADER_TOKENS} tokens`);
  }
  return tokens;
}

type MathFunction = {
  count: number;
  glsl: (args: string[]) => string;
  run: (...args: number[]) => number;
};
const builtIn = (name: string, count: number, run: MathFunction["run"]): MathFunction => ({
  count,
  glsl: (args) => `${name}(${args.join(", ")})`,
  run,
});
const math = new Map<string, MathFunction>([
  ["abs", builtIn("abs", 1, Math.abs)],
  ["cos", builtIn("cos", 1, Math.cos)],
  ["floor", builtIn("floor", 1, Math.floor)],
  ["fract", builtIn("fract", 1, (x) => x - Math.floor(x))],
  ["sin", builtIn("sin", 1, Math.sin)],
  ["min", builtIn("min", 2, Math.min)],
  ["max", builtIn("max", 2, Math.max)],
  ["mix", builtIn("mix", 3, (a, b, t) => Math.fround(a * Math.fround(1 - t)) + Math.fround(b * t))],
  [
    "clamp",
    {
      count: 3,
      glsl: ([x, lo, hi]) => `min(max(${x}, ${lo}), ${hi})`,
      run: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
    },
  ],
  ["+", { count: 2, glsl: ([a, b]) => `${a} + ${b}`, run: (a, b) => a + b }],
  ["-", { count: 2, glsl: ([a, b]) => `${a} - ${b}`, run: (a, b) => a - b }],
  ["*", { count: 2, glsl: ([a, b]) => `${a} * ${b}`, run: (a, b) => a * b }],
  ["/", { count: 2, glsl: ([a, b]) => `${a} / divisor(${b})`, run: (a, b) => a / divisor(b) }],
]);

// Parser widths and validated argument counts determine every register and lane index.
const at = <T>(items: ArrayLike<T>, index: number): T => items[index] as T;
const read = (reg: Register, lane: number) => reg.slot + (reg.width === 1 ? 0 : lane);
const variable = (slot: number) => `r${slot}`;
const component = (reg: Register, lane: number) =>
  variable(reg.slot) + (reg.width === 1 ? "" : `.${channels[lane]}`);

const compiled = new WeakMap<ShaderDefinitionInput, CompiledShader>();

export function compiledShader(definition: ShaderDefinitionInput): CompiledShader {
  let program = compiled.get(definition);
  if (program === undefined) {
    program = compileShader(definition);
    compiled.set(definition, program);
  }
  return program;
}

/** Parse and type-check a bounded GLSL body, then emit both the GPU program and its reference. */
export function compileShader(definition: ShaderDefinitionInput): CompiledShader {
  const tokens = tokenize(definition.source);
  const uniforms = Object.entries(definition.uniforms).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const isEffect = definition.kind === "effect";
  const scope = new Map<string, Register>();
  const lines: string[] = [];
  const instructions: Instruction[] = [];
  let cursor = 0;
  let slots = 0;
  let samples = 0;
  let work = 1;

  function reserve(width: Width): Register {
    const slot = slots;
    slots += width;
    return { slot, width };
  }

  const inputRegisters = inputs.map(([name, width]) => {
    const reg = reserve(width);
    scope.set(name, reg);
    return reg;
  });
  const uniformRegisters = uniforms.map(([name, descriptor]) => {
    const reg = reserve(widths[descriptor.type]);
    scope.set(name, reg);
    return reg;
  });

  function fail(message: string): never {
    const offset = tokens[Math.max(0, cursor - 1)]?.offset ?? 0;
    throw new ShaderSourceError(`${message} at source character ${offset + 1}`);
  }

  const peek = () => tokens[cursor]?.text;
  const take = () => tokens[cursor++]?.text ?? fail("unexpected end of shader");
  function expect(text: string): void {
    if (take() !== text) fail(`expected '${text}'`);
  }

  function emit(width: Width, glsl: string, run: (slot: number) => Instruction): Register {
    const reg = reserve(width);
    lines.push(`${types[width]} ${variable(reg.slot)} = ${glsl};`);
    instructions.push(run(reg.slot));
    work += width;
    return reg;
  }

  function lanes(
    width: Width,
    code: (lane: number) => string,
    run: (values: Float32Array, lane: number) => number,
  ): Register {
    const parts = Array.from({ length: width }, (_, lane) => code(lane));
    return emit(
      width,
      width === 1 ? at(parts, 0) : `${types[width]}(${parts.join(", ")})`,
      (slot) => (values) => {
        for (let lane = 0; lane < width; lane++) values[slot + lane] = run(values, lane);
      },
    );
  }

  function arithmetic(fn: MathFunction, args: Register[]): Register {
    if (args.length !== fn.count) fail(`expected ${fn.count} arguments`);
    const width = Math.max(...args.map((arg) => arg.width)) as Width;
    if (args.some((arg) => arg.width !== 1 && arg.width !== width))
      fail("vector widths must match");
    const indices = Array.from({ length: width }, (_, lane) => args.map((arg) => read(arg, lane)));
    return lanes(
      width,
      (lane) => `bound(${fn.glsl(args.map((arg) => component(arg, lane)))})`,
      (values, lane) => {
        const row = at(indices, lane);
        const a = at(row, 0);
        switch (fn.count) {
          case 1:
            return clip(fn.run(at(values, a)));
          case 2:
            return clip(fn.run(at(values, a), at(values, at(row, 1))));
          default:
            return clip(fn.run(at(values, a), at(values, at(row, 1)), at(values, at(row, 2))));
        }
      },
    );
  }

  function construct(width: Width, args: Register[]): Register {
    const parts = args.flatMap((arg) =>
      Array.from({ length: arg.width }, (_, lane) => ({ arg, lane })),
    );
    if (parts.length === 1) while (parts.length < width) parts.push(at(parts, 0));
    if (parts.length !== width) fail(`expected ${width} constructor components`);
    return lanes(
      width,
      (lane) => {
        const { arg, lane: index } = at(parts, lane);
        return component(arg, index);
      },
      (values, lane) => {
        const { arg, lane: index } = at(parts, lane);
        return at(values, read(arg, index));
      },
    );
  }

  function call(name: string): Register {
    expect("(");
    const args: Register[] = [];
    if (peek() !== ")") {
      args.push(expression());
      while (peek() === ",") {
        take();
        args.push(expression());
      }
    }
    expect(")");
    if (Object.hasOwn(widths, name)) return construct(widths[name as keyof typeof widths], args);
    const fn = math.get(name);
    if (fn !== undefined && /^[a-z]/.test(name)) return arithmetic(fn, args);
    if (name !== "sampleInput" || !isEffect) fail(`unknown shader function '${name}'`);
    if (args.length !== 1 || args[0]?.width !== 2) fail("sampleInput expects one vec2");
    if (++samples > MAX_SHADER_SAMPLES) fail("too many input texture samples");
    work += 8;
    const arg = at(args, 0).slot;
    return emit(4, `sampleInput(${variable(arg)})`, (slot) => (values, sample) => {
      if (sample === undefined) throw new Error("an effect shader needs its input texture");
      sample(at(values, arg), at(values, arg + 1), values, slot);
    });
  }

  function primary(): Register {
    const token = take();
    let reg: Register;
    if (token === "(") {
      reg = expression();
      expect(")");
    } else if (numeric.test(token)) {
      const value = Math.fround(Number(token));
      if (Math.abs(value) > max) fail("numeric literal is out of range");
      const decimal = String(value);
      reg = emit(1, /[.e]/.test(decimal) ? decimal : `${decimal}.0`, (slot) => (values) => {
        values[slot] = value;
      });
    } else if (peek() === "(" && identifier.test(token)) {
      reg = call(token);
    } else {
      reg = scope.get(token) ?? fail(`unknown shader value '${token}'`);
    }
    while (peek() === ".") {
      take();
      const fields = take();
      if (!/^(?:[xyzw]{1,4}|[rgba]{1,4})$/.test(fields) || reg.width === 1)
        fail("invalid vector swizzle");
      const indexes = [...fields].map((field) =>
        (channels.includes(field) ? channels : "rgba").indexOf(field),
      );
      if (indexes.some((lane) => lane >= reg.width)) fail("swizzle exceeds vector width");
      const from = reg;
      reg = lanes(
        indexes.length as Width,
        (lane) => component(from, at(indexes, lane)),
        (values, lane) => at(values, read(from, at(indexes, lane))),
      );
    }
    return reg;
  }

  function unary(): Register {
    if (peek() !== "-") return primary();
    take();
    const value = unary();
    return lanes(
      value.width,
      (lane) => `-${component(value, lane)}`,
      (values, lane) => -at(values, read(value, lane)),
    );
  }

  function expression(minPrecedence = 0): Register {
    let lhs = unary();
    for (;;) {
      const op = peek();
      const precedence = op === "*" || op === "/" ? 2 : op === "+" || op === "-" ? 1 : 0;
      if (precedence <= minPrecedence || op === undefined) return lhs;
      take();
      const fn = math.get(op);
      if (fn === undefined) return fail("unknown operator");
      lhs = arithmetic(fn, [lhs, expression(precedence)]);
    }
  }

  while (peek() !== "return") {
    const type = take();
    if (!Object.hasOwn(widths, type)) fail("expected a typed local declaration or return");
    const name = take();
    if (
      !identifier.test(name) ||
      scope.has(name) ||
      Object.hasOwn(widths, name) ||
      math.has(name) ||
      name === "return" ||
      name === "sampleInput"
    )
      fail(`invalid or duplicate local name '${name}'`);
    expect("=");
    const value = expression();
    if (value.width !== widths[type as keyof typeof widths])
      fail("local declaration has the wrong type");
    expect(";");
    scope.set(name, value);
  }

  expect("return");
  const result = expression();
  if (result.width !== 4) fail("shader must return vec4");
  expect(";");
  if (peek() !== undefined) fail("unexpected source after return");

  const fragment = [
    "#version 300 es",
    "precision highp float;",
    "precision highp int;",
    "precision highp sampler2D;",
    "out vec4 outColor;",
    "uniform vec2 k_size;",
    "uniform float k_frame;",
    "uniform float k_fps;",
    "uniform float k_seed;",
    ...uniformRegisters.map(({ width }, i) => `uniform ${types[width]} k_u${i};`),
    `float bound(float v) { return clamp(v, -${max}.0, ${max}.0); }`,
    "float divisor(float v) { return (v < 0.0 ? -1.0 : 1.0) * max(abs(v), 0.000001); }",
    ...(isEffect
      ? [
          "uniform sampler2D k_input;",
          "vec4 sampleInput(vec2 uv) {",
          "  ivec2 size = textureSize(k_input, 0);",
          "  vec2 p = floor(clamp(uv, 0.0, 1.0) * k_size);",
          "  vec4 c = texelFetch(k_input, clamp(ivec2(p), ivec2(0), size - 1), 0);",
          "  return c.a > 0.0 ? vec4(clamp(c.rgb / c.a, 0.0, 1.0), c.a) : vec4(0.0);",
          "}",
        ]
      : []),
    "void main() {",
    ...inputRegisters.map(
      ({ slot, width }, i) =>
        types[width] +
        " " +
        variable(slot) +
        " = " +
        ["gl_FragCoord.xy / k_size", "gl_FragCoord.xy", "k_size", "k_frame", "k_fps", "k_seed"][i] +
        ";",
    ),
    ...uniformRegisters.map(({ slot, width }, i) => `${types[width]} ${variable(slot)} = k_u${i};`),
    ...lines,
    `vec4 c = clamp(${variable(result.slot)}, 0.0, 1.0);`,
    "outColor = vec4(c.rgb * c.a, c.a);",
    "}",
  ].join("\n");

  return {
    fragment,
    work,
    reference(draw, sample) {
      // GLSL highp stores each scalar intermediate at float32 precision.
      const values = new Float32Array(slots);
      const [uv, pixel, resolution, frame, fps, seed] = inputRegisters as [
        Register,
        Register,
        Register,
        Register,
        Register,
        Register,
      ];
      values.set([draw.width, draw.height], resolution.slot);
      values[frame.slot] = Math.fround(draw.frame);
      values[fps.slot] = Math.fround(draw.fps);
      values[seed.slot] = Math.fround(draw.seed);
      uniformRegisters.forEach(({ slot, width }, i) => {
        for (let lane = 0; lane < width; lane++)
          values[slot + lane] = Math.fround(at(at(draw.uniforms, i), lane));
      });
      return (x, y, out, offset) => {
        const px = x + 0.5;
        const py = y + 0.5;
        values[pixel.slot] = px;
        values[pixel.slot + 1] = py;
        values[uv.slot] = Math.fround(px / draw.width);
        values[uv.slot + 1] = Math.fround(py / draw.height);
        for (const step of instructions) step(values, sample);
        const alpha = unit(at(values, result.slot + 3));
        for (let lane = 0; lane < 3; lane++)
          out[offset + lane] = unit(at(values, result.slot + lane)) * alpha;
        out[offset + 3] = alpha;
      };
    },
  };
}
