import {
  MAX_AURORA_COLORS,
  MAX_EFFECT_RADIUS,
  MAX_GENERATOR_STOPS,
  MAX_NOISE_OCTAVES,
  type TransitionKind,
} from "@kynimo/scene";

/**
 * GLSL ES 3.00 for the WebGL2 compositor (ADR-0021). Every function mirrors `blend.ts` and
 * `reference.ts`; change them together. Images are indexed by texel with `texelFetch`, never
 * filtered by the GPU, so the sampling math is ours and matches the reference compositor.
 * Rows keep the plan's top-to-bottom order: pixel (x, y) is texel (x, y), and gl_FragCoord.y − 0.5
 * is the row index, so nothing is ever flipped.
 */

/** A full-screen triangle; no vertex buffers. */
export const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 outColor;
`;

/** Raster (RGBA8 or RGBA16F) times mask coverage (R8), with transparent padding for effects. */
export const PREPARE = `${HEADER}
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform bool u_hasMask;
uniform ivec2 u_pad;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - u_pad;
  ivec2 size = textureSize(u_src, 0);
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, size))) {
    outColor = vec4(0.0);
    return;
  }
  vec4 c = texelFetch(u_src, p, 0);
  if (u_hasMask) c *= texelFetch(u_mask, p, 0).r;
  outColor = c;
}`;

export const DEFORM_VERTEX = `#version 300 es
layout(location = 0) in vec4 a_first;
layout(location = 1) in vec4 a_second;
layout(location = 2) in vec4 a_third;
uniform vec2 u_targetSize;
uniform vec2 u_pad;
flat out highp vec4 v_first;
flat out highp vec4 v_second;
flat out highp vec4 v_third;
void main() {
  v_first = a_first;
  v_second = a_second;
  v_third = a_third;
  int corner = gl_VertexID % 3;
  vec2 dst = corner == 0 ? a_first.xy : (corner == 1 ? a_second.xy : a_third.xy);
  gl_Position = vec4((dst + u_pad) * (2.0 / u_targetSize) - 1.0, 0.0, 1.0);
}`;

/** Bilinear sampling after masking each source texel, with transparent samples outside. */
export const DEFORM = `${HEADER}
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform bool u_hasMask;
uniform vec2 u_pad;
flat in highp vec4 v_first;
flat in highp vec4 v_second;
flat in highp vec4 v_third;

// Products in the 8192 × 16 subpixel grid can exceed signed int32. Split at 8 bits
// and propagate signed carries so subtraction happens exactly before float conversion.
float subpixelCross(ivec2 edge, ivec2 offset) {
  ivec2 edgeHi = edge >> 8;
  ivec2 offsetHi = offset >> 8;
  ivec2 edgeLo = edge & 255;
  ivec2 offsetLo = offset & 255;
  int lo = edgeLo.x * offsetLo.y - edgeLo.y * offsetLo.x;
  int mid = edgeHi.x * offsetLo.y + edgeLo.x * offsetHi.y
    - edgeHi.y * offsetLo.x - edgeLo.y * offsetHi.x + (lo >> 8);
  int hi = edgeHi.x * offsetHi.y - edgeHi.y * offsetHi.x + (mid >> 8);
  int remainder = (mid & 255) * 256 + (lo & 255);
  return float(hi) * 65536.0 + float(remainder);
}

vec4 maskedTexel(ivec2 p, ivec2 size) {
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, size))) return vec4(0.0);
  vec4 c = texelFetch(u_src, p, 0);
  if (u_hasMask) c *= texelFetch(u_mask, p, 0).r;
  return c;
}
void main() {
  // Hardware decides coverage. Exact subpixel edge values keep the UVs accurate even when the
  // triangle is almost collinear and smooth varying interpolation loses precision.
  ivec2 a = ivec2(v_first.xy * 16.0);
  ivec2 b = ivec2(v_second.xy * 16.0);
  ivec2 c = ivec2(v_third.xy * 16.0);
  ivec2 samplePoint = ivec2(gl_FragCoord.xy * 16.0 - u_pad * 16.0);
  float area = subpixelCross(b - a, c - a);
  if (area == 0.0) discard;
  float wa = subpixelCross(c - b, samplePoint - b);
  float wb = subpixelCross(a - c, samplePoint - c);
  float wc = subpixelCross(b - a, samplePoint - a);
  vec2 q = (v_first.zw * wa + v_second.zw * wb + v_third.zw * wc) / area - 0.5;
  ivec2 size = textureSize(u_src, 0);
  // Out-of-range samples overwrite previous triangles with transparency, without an int overflow.
  if (any(lessThanEqual(q, vec2(-1.0))) || any(greaterThanEqual(q, vec2(size)))) {
    outColor = vec4(0.0);
    return;
  }
  ivec2 p = ivec2(floor(q));
  vec2 f = fract(q);
  vec4 top = mix(maskedTexel(p, size), maskedTexel(p + ivec2(1, 0), size), f.x);
  vec4 bottom = mix(maskedTexel(p + ivec2(0, 1), size), maskedTexel(p + ivec2(1), size), f.x);
  outColor = mix(top, bottom, f.y);
}`;

const TRANSPARENT_FETCH = `
vec4 at(sampler2D s, ivec2 p) {
  ivec2 size = textureSize(s, 0);
  return any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, size))
    ? vec4(0.0) : texelFetch(s, p, 0);
}
`;

export const GAUSSIAN = `${HEADER}
uniform sampler2D u_src;
uniform ivec2 u_axis;
uniform int u_radius;
uniform float u_weights[${MAX_EFFECT_RADIUS + 1}];
${TRANSPARENT_FETCH}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = at(u_src, p) * u_weights[0];
  for (int i = 1; i <= u_radius; i++) {
    ivec2 d = i * u_axis;
    c += (at(u_src, p - d) + at(u_src, p + d)) * u_weights[i];
  }
  outColor = c;
}`;

/** `hashWords(seed, [a, b, c, d])` of `@kynimo/engine` in `uint` math (wrapping multiply == Math.imul). */
const HASH = `
uint rotl(uint x, uint r) { return (x << r) | (x >> (32u - r)); }
uint murmurStep(uint h, uint k) {
  k *= 0xcc9e2d51u;
  k = rotl(k, 15u);
  k *= 0x1b873593u;
  h ^= k;
  h = rotl(h, 13u);
  return h * 5u + 0xe6546b64u;
}
uint hashWords4(uint seed, uint a, uint b, uint c, uint d) {
  uint h = murmurStep(murmurStep(murmurStep(murmurStep(seed, a), b), c), d);
  h ^= 16u;
  h ^= h >> 16u;
  h *= 0x85ebca6bu;
  h ^= h >> 13u;
  h *= 0xc2b2ae35u;
  h ^= h >> 16u;
  return h;
}
// float(h) rounds to float32 on the GPU (the reference divides in float64), so hard thresholds (noise-dissolve feather 0, glitch band switch) may flip isolated pixels/rows within the ADR-0045 stepped tolerance.
float hashUnit(uint h) { return float(h) / 4294967295.0; }
`;

/** The JS twin is `band` in effects.ts. */
const BAND = `
float bandOverlap(float v, float hw) { return max(0.0, min(v + 0.5, hw) - max(v - 0.5, -hw)); }
float band(float x, float hw, float period) {
  float u = x - period * floor(x / period + 0.5);
  return min(1.0, bandOverlap(u, hw) + bandOverlap(abs(u) - period, hw));
}
`;

/** The generator types, in the order of {@link generatorShader}'s argument. */
export type GeneratorType = "gradient" | "noise" | "pattern" | "aurora";

const GENERATOR_UNIFORMS = `
uniform vec2 u_size;
uniform int u_kind;
uniform vec2 u_a;          // gradient start
uniform vec2 u_b;          // gradient end
uniform int u_count;       // gradient stops, aurora colors
uniform float u_offsets[${MAX_GENERATOR_STOPS}];
uniform vec4 u_colors[${MAX_GENERATOR_STOPS}];
uniform uint u_seed;
uniform float u_scale;     // noise scale, pattern size, aurora sigma
uniform int u_octaves;
uniform float u_evolution;
uniform vec2 u_offset;
uniform vec4 u_low;        // noise low, pattern background
uniform vec4 u_high;       // noise high, pattern foreground
uniform float u_thickness;
uniform vec2 u_rotation;
uniform vec2 u_points[${MAX_AURORA_COLORS}];
`;

const GRADIENT_COLOR = `
vec4 gradientColor(vec2 p) {
  vec2 d = u_b - u_a;
  float l2 = dot(d, d);
  vec2 q = p - u_a;
  float t;
  if (l2 < 1e-12) t = 1.0;
  else if (u_kind == 0) t = dot(q, d) / l2;
  else if (u_kind == 1) t = length(q) / sqrt(l2);
  else if (q == vec2(0.0)) t = 0.0;
  else {
    float turns = atan(d.x * q.y - d.y * q.x, dot(q, d)) / 6.28318530717958647692;
    t = turns - floor(turns);
  }
  t = clamp(t, 0.0, 1.0);
  int last = u_count - 1;
  if (t <= u_offsets[0]) return u_colors[0];
  if (t >= u_offsets[last]) return u_colors[last];
  for (int i = 0; i < last; i++) {
    float lo = u_offsets[i];
    float hi = u_offsets[i + 1];
    if (lo <= t && t <= hi && hi > lo) return mix(u_colors[i], u_colors[i + 1], (t - lo) / (hi - lo));
  }
  return u_colors[last];
}
`;

const NOISE_COLOR = `
float lattice(int o, ivec3 i) {
  return hashUnit(hashWords4(u_seed, uint(o), uint(i.x), uint(i.y), uint(i.z)));
}
vec3 fade(vec3 u) { return u * u * u * (u * (u * 6.0 - 15.0) + 10.0); }
vec4 noiseColor(vec2 p) {
  float sum = 0.0;
  float weights = 0.0;
  float amplitude = 1.0;
  for (int o = 0; o < ${MAX_NOISE_OCTAVES}; o++) {
    if (o >= u_octaves) break;
    float freq = float(1 << o);
    vec3 q = vec3((p - u_offset) / u_scale * freq, u_evolution * freq);
    vec3 fl = floor(q);
    ivec3 i = ivec3(fl);
    vec3 u = fade(q - fl);
    float z0 = mix(mix(lattice(o, i), lattice(o, i + ivec3(1, 0, 0)), u.x),
                   mix(lattice(o, i + ivec3(0, 1, 0)), lattice(o, i + ivec3(1, 1, 0)), u.x), u.y);
    float z1 = mix(mix(lattice(o, i + ivec3(0, 0, 1)), lattice(o, i + ivec3(1, 0, 1)), u.x),
                   mix(lattice(o, i + ivec3(0, 1, 1)), lattice(o, i + ivec3(1, 1, 1)), u.x), u.y);
    sum += amplitude * mix(z0, z1, u.z);
    weights += amplitude;
    amplitude *= 0.5;
  }
  return mix(u_low, u_high, sum / weights);
}
`;

const PATTERN_COLOR = `
vec4 patternColor(vec2 p) {
  vec2 r = p - u_size / 2.0 - u_offset;
  vec2 q = vec2(u_rotation.x * r.x + u_rotation.y * r.y, -u_rotation.y * r.x + u_rotation.x * r.y);
  float s = u_scale;
  float hw = u_thickness * s / 2.0;
  float cov;
  if (u_kind == 0) {
    cov = band(q.x, hw, s);
  } else if (u_kind == 1) {
    cov = band(q.x, s / 2.0, 2.0 * s);
    float b = band(q.y, s / 2.0, 2.0 * s);
    cov = cov * (1.0 - b) + b * (1.0 - cov);
  } else if (u_kind == 2) {
    vec2 c = s * floor(q / s + 0.5);
    cov = hw > 0.0 ? clamp(hw + 0.5 - length(q - c), 0.0, 1.0) : 0.0;
  } else {
    float a = band(q.x, hw, s);
    float b = band(q.y, hw, s);
    cov = a + b - a * b;
  }
  return mix(u_low, u_high, cov);
}
`;

const AURORA_COLOR = `
vec4 auroraColor(vec2 p) {
  float d2[${MAX_AURORA_COLORS}];
  float dmin = 3.4e38;
  for (int i = 0; i < ${MAX_AURORA_COLORS}; i++) {
    if (i >= u_count) break;
    vec2 d = p - u_points[i];
    d2[i] = dot(d, d);
    dmin = min(dmin, d2[i]);
  }
  float total = 0.0;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < ${MAX_AURORA_COLORS}; i++) {
    if (i >= u_count) break;
    float w = exp(-(d2[i] - dmin) / (2.0 * u_scale * u_scale));
    total += w;
    sum += w * u_colors[i];
  }
  return sum / total;
}
`;

const GENERATOR_PARTS: Record<GeneratorType, string> = {
  gradient: GRADIENT_COLOR,
  noise: `${HASH}${NOISE_COLOR}`,
  pattern: `${BAND}${PATTERN_COLOR}`,
  aurora: AURORA_COLOR,
};

/**
 * Draws a generator (the twin of generators.ts) into a W×H layer-space target, premultiplied.
 * One program per generator type, so a draw runs only its own function. Pixel centers are
 * (x + 0.5, y + 0.5).
 */
export function generatorShader(type: GeneratorType): string {
  return `${HEADER}${GENERATOR_UNIFORMS}${GENERATOR_PARTS[type]}
void main() {
  vec2 p = vec2(ivec2(gl_FragCoord.xy)) + 0.5;
  vec4 c = ${type}Color(p);
  outColor = vec4(c.rgb * c.a, c.a);
}`;
}

/** Effect-shader ids; the same numbers the single-program shader switched on. */
export type EffectMode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

const EFFECT_UNIFORMS = `
uniform sampler2D u_src;
uniform sampler2D u_blur;
uniform vec2 u_params;
uniform vec4 u_color;
uniform vec4 u_white;
uniform float u_amount;
uniform float u_offset;
uniform uint u_seed;
uniform int u_frame;
uniform int u_size;
uniform bool u_monochrome;
uniform ivec2 u_origin;
uniform ivec2 u_inner;
${TRANSPARENT_FETCH}`;

const BILINEAR_AT = `
vec4 bilinearAt(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec4 top = mix(at(u_src, i), at(u_src, i + ivec2(1, 0)), f.x);
  vec4 bottom = mix(at(u_src, i + ivec2(0, 1)), at(u_src, i + ivec2(1, 1)), f.x);
  return mix(top, bottom, f.y);
}
`;

const SHIFTED_ALPHA = `
float shiftedAlpha(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  float top = mix(at(u_blur, i).a, at(u_blur, i + ivec2(1, 0)).a, f.x);
  float bottom = mix(at(u_blur, i + ivec2(0, 1)).a, at(u_blur, i + ivec2(1, 1)).a, f.x);
  return mix(top, bottom, f.y);
}
`;

const HUE_SATURATION = `
vec3 hueSaturation(vec3 c, float hue, float saturation) {
  float hi = max(c.r, max(c.g, c.b));
  float lo = min(c.r, min(c.g, c.b));
  float d = hi - lo;
  if (d <= 0.0) return c;
  float h = hi == c.r ? (c.g - c.b) / d
    : hi == c.g ? 2.0 + (c.b - c.r) / d : 4.0 + (c.r - c.g) / d;
  h += hue / 60.0;
  vec3 wheel = clamp(abs(mod(h + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return hi - min(hi, d * (1.0 + saturation)) * (1.0 - wheel);
}
`;

/** Shadow and glow (modes 1, 2) composite the blurred alpha under the source. */
const underBody = (alpha: string) => `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  float a = ${alpha};
  vec4 under = vec4(u_color.rgb, 1.0) * (a * u_color.a * u_amount);
  outColor = c + under * (1.0 - c.a);
}`;

const CHROMATIC_BODY = `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  vec2 size = vec2(textureSize(u_src, 0));
  vec2 o = (vec2(p) + 0.5 - size / 2.0) / (0.5 * max(size.x, size.y)) * u_amount;
  vec4 r = bilinearAt(clamp(vec2(p) + 0.5 + o, vec2(0.5), size - 0.5) - 0.5);
  vec4 b = bilinearAt(clamp(vec2(p) + 0.5 - o, vec2(0.5), size - 0.5) - 0.5);
  outColor = vec4(r.r, c.g, b.b, max(r.a, max(c.a, b.a)));
}`;

/** Straight-color corrections: the statements that turn `rgb` into the new straight color. */
const COLOR_STEPS: Partial<Record<EffectMode, string>> = {
  3: "rgb = (rgb - 0.5) * (1.0 + u_params.y) + 0.5 + u_params.x;",
  4: "rgb = hueSaturation(rgb, u_params.x, u_params.y);",
  5: `float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  vec4 tint = mix(u_color, u_white, l);
  rgb = mix(rgb, tint.rgb, tint.a * u_amount);`,
  6: "rgb = mix(rgb, u_color.rgb, u_color.a * u_amount);",
  7: `vec2 halfSize = vec2(u_inner) / 2.0;
  float d = length((vec2(p) + 0.5 - halfSize - vec2(u_origin)) / halfSize);
  float k = smoothstep(u_params.x, u_params.x + u_params.y, d);
  rgb = mix(rgb, u_color.rgb, u_amount * u_color.a * k);`,
  8: `ivec2 cell = ivec2(floor(vec2(p - u_origin) / float(u_size)));
  for (int ch = 0; ch < 3; ch++) {
    uint h = hashWords4(u_seed, uint(u_frame), uint(cell.x), uint(cell.y), u_monochrome ? 0u : uint(ch));
    rgb[ch] = clamp(rgb[ch] + u_amount * 0.5 * (hashUnit(h) * 2.0 - 1.0), 0.0, 1.0);
  }`,
  10: "rgb = floor(rgb * (u_amount - 1.0) + 0.5) / (u_amount - 1.0);",
  11: `float k = band(float(p.y - u_origin.y) + 0.5 - u_offset, u_params.y * u_params.x / 2.0, u_params.x);
  rgb = mix(rgb, u_color.rgb, u_amount * u_color.a * k);`,
};

const correctionBody = (mode: EffectMode) => `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  if (c.a <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  vec3 rgb = clamp(c.rgb / c.a, 0.0, 1.0);
  {
  ${COLOR_STEPS[mode]}
  }
  outColor = vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a);
}`;

/**
 * One program per effect type (`mode`: 1 drop shadow, 2 glow, 3 brightness/contrast, 4 hue/
 * saturation, 5 tint, 6 fill, 7 vignette, 8 grain, 9 chromatic aberration, 10 posterize, 11
 * scanlines). Straight-color corrections preserve the source's coverage. Shadow and glow sit
 * under it.
 */
export function effectShader(mode: EffectMode): string {
  let parts = "";
  let body: string;
  if (mode <= 2) {
    parts = mode === 1 ? SHIFTED_ALPHA : "";
    body = underBody(
      mode === 1 ? "shiftedAlpha(vec2(p) - u_params)" : "texelFetch(u_blur, p, 0).a",
    );
  } else if (mode === 9) {
    parts = BILINEAR_AT;
    body = CHROMATIC_BODY;
  } else {
    parts = mode === 4 ? HUE_SATURATION : mode === 8 ? HASH : mode === 11 ? BAND : "";
    body = correctionBody(mode);
  }
  return `${HEADER}${EFFECT_UNIFORMS}${parts}${body}`;
}

const TRANSITION_COMMON = `
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_p;
uniform vec2 u_size;
${TRANSPARENT_FETCH}
// Bilinear sample at a texel-space point (centres at i + 0.5), clamped to the centre range.
vec4 bilinearAt(sampler2D s, vec2 pos) {
  vec2 q = clamp(pos, vec2(0.5), u_size - 0.5) - 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 f = q - floor(q);
  vec4 top = mix(at(s, i), at(s, i + ivec2(1, 0)), f.x);
  vec4 bottom = mix(at(s, i + ivec2(0, 1)), at(s, i + ivec2(1, 1)), f.x);
  return mix(top, bottom, f.y);
}
`;

const COVERAGE_TRANSITION = `
vec4 transition(vec2 c, vec4 a, vec4 b) { return mix(a, b, coverage(c)); }
`;

/** Per transition kind: the declarations and the `transition(c, a, b)` (or `coverage(c)`) body. */
const TRANSITION_PARTS: Readonly<Record<TransitionKind, string>> = {
  dissolve: `
float coverage(vec2 c) { return u_p; }
${COVERAGE_TRANSITION}`,
  "noise-dissolve": `${HASH}
uniform uint u_seed;
uniform float u_scale;
uniform float u_feather;
float lattice(ivec2 i) { return hashUnit(hashWords4(u_seed, uint(i.x), uint(i.y), 0u, 0u)); }
float coverage(vec2 c) {
  vec2 g = c / u_scale;
  vec2 fl = floor(g);
  ivec2 i = ivec2(fl);
  vec2 f = g - fl;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n = mix(mix(lattice(i), lattice(i + ivec2(1, 0)), u.x),
                mix(lattice(i + ivec2(0, 1)), lattice(i + ivec2(1, 1)), u.x), u.y);
  if (u_feather > 0.0) return clamp((u_p * (1.0 + u_feather) - n) / u_feather, 0.0, 1.0);
  return n < u_p ? 1.0 : 0.0;
}
${COVERAGE_TRANSITION}`,
  wipe: `
uniform vec2 u_dir;
uniform vec2 u_range; // sMin, length
uniform float u_feather;
float coverage(vec2 c) {
  float e = u_range.x + u_p * (u_range.y + u_feather);
  return clamp((e - dot(c, u_dir)) / u_feather, 0.0, 1.0);
}
${COVERAGE_TRANSITION}`,
  clock: `
uniform vec2 u_center;
uniform vec2 u_dir0;
uniform float u_turn;
uniform float u_feather;
float coverage(vec2 c) {
  vec2 v = c - u_center;
  float phi = 0.0;
  if (v != vec2(0.0)) {
    float deg = atan(u_turn * (u_dir0.x * v.y - u_dir0.y * v.x), dot(u_dir0, v)) * 57.29577951308232;
    phi = deg < 0.0 ? deg + 360.0 : deg;
  }
  if (u_feather > 0.0) return clamp((u_p * (360.0 + u_feather) - phi) / u_feather, 0.0, 1.0);
  return phi < u_p * 360.0 ? 1.0 : 0.0;
}
${COVERAGE_TRANSITION}`,
  iris: `
uniform vec2 u_center;
uniform float u_feather;
uniform float u_rmax;
uniform float u_shape;
float coverage(vec2 c) {
  vec2 v = abs(c - u_center);
  float r = u_shape < 0.5 ? length(v) : (u_shape < 1.5 ? v.x + v.y : max(v.x, v.y));
  return clamp((u_p * (u_rmax + u_feather) - r) / u_feather, 0.0, 1.0);
}
${COVERAGE_TRANSITION}`,
  blinds: `
uniform vec2 u_dir;
uniform float u_smin;
uniform float u_period;
uniform float u_feather;
float coverage(vec2 c) {
  float s = dot(c, u_dir) - u_smin;
  float u = s - u_period * floor(s / u_period);
  return clamp((u_p * (u_period + u_feather) - u) / u_feather, 0.0, 1.0);
}
${COVERAGE_TRANSITION}`,
  pixelate: `
uniform float u_cell;
uniform float u_mix;
vec4 transition(vec2 c, vec4 a, vec4 b) {
  vec2 q = (floor(c / u_cell) + 0.5) * u_cell;
  return mix(bilinearAt(u_a, q), bilinearAt(u_b, q), u_mix);
}`,
  push: `
uniform vec2 u_dir;
uniform vec2 u_range;
vec4 transition(vec2 c, vec4 a, vec4 b) {
  float len = u_range.y;
  float m = clamp(u_range.x + u_p * len - dot(c, u_dir) + 0.5, 0.0, 1.0);
  return mix(bilinearAt(u_a, c - u_p * len * u_dir), bilinearAt(u_b, c - (u_p - 1.0) * len * u_dir), m);
}`,
  zoom: `
uniform vec2 u_center;
uniform vec2 u_scale;
vec4 transition(vec2 c, vec4 a, vec4 b) {
  vec2 v = c - u_center;
  return mix(bilinearAt(u_a, u_center + v / u_scale.x), bilinearAt(u_b, u_center + v / u_scale.y), u_p);
}`,
  glitch: `${HASH}
uniform uint u_seed;
uniform float u_bands;
uniform float u_step;
uniform float u_amp;
vec4 pick(bool showB, vec2 pos) { return showB ? bilinearAt(u_b, pos) : bilinearAt(u_a, pos); }
vec4 transition(vec2 c, vec4 a, vec4 b) {
  uint row = uint(floor(c.y * u_bands / u_size.y));
  uint stepIndex = uint(u_step);
  bool showB = hashUnit(hashWords4(u_seed, row, stepIndex, 0u, 0u)) < u_p;
  float shift = (2.0 * hashUnit(hashWords4(u_seed, row, stepIndex, 1u, 0u)) - 1.0) * u_amp;
  float ca = 0.25 * u_amp;
  float x = c.x + shift;
  vec4 r = pick(showB, vec2(x + ca, c.y));
  vec4 g = pick(showB, vec2(x, c.y));
  vec4 bl = pick(showB, vec2(x - ca, c.y));
  return vec4(r.r, g.g, bl.b, max(r.a, max(g.a, bl.a)));
}`,
};

/**
 * Draws one built-in transition (ADR-0045): inputs `u_a` (the backdrop) and `u_b` (the layer
 * composited over it), output the premultiplied mix. One program per kind; the twin is
 * `transitionPixel` in reference.ts, and the CPU-side uniforms come from `transitionUniforms`.
 */
export function transitionShader(kind: TransitionKind): string {
  return `${HEADER}${TRANSITION_COMMON}${TRANSITION_PARTS[kind]}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = transition(vec2(p) + 0.5, texelFetch(u_a, p, 0), texelFetch(u_b, p, 0));
}`;
}

const MATTE_COVERAGE = `
float matteCoverage(sampler2D matte, ivec2 p, int mode, bool empty) {
  if (mode == 0) return 1.0;
  vec4 m = empty ? vec4(0.0) : texelFetch(matte, p, 0);
  float v = mode <= 2 ? m.a : dot(m.rgb, vec3(0.2126, 0.7152, 0.0722));
  return mode == 2 || mode == 4 ? 1.0 - v : v;
}
`;

/** Next mip level: the mean of a 2×2 block, texels past the edge transparent. */
export const DOWNSAMPLE = `${HEADER}
uniform sampler2D u_src;
vec4 at(ivec2 p, ivec2 size) {
  return (p.x < size.x && p.y < size.y) ? texelFetch(u_src, p, 0) : vec4(0.0);
}
void main() {
  ivec2 size = textureSize(u_src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  outColor = (at(p, size) + at(p + ivec2(1, 0), size) + at(p + ivec2(0, 1), size)
    + at(p + ivec2(1, 1), size)) / 4.0;
}`;

/** Which of the five matte modes (0 none, 1 alpha, 2 alpha inverted, 3 luma, 4 luma inverted). */
export type MatteMode = 0 | 1 | 2 | 3 | 4;

/** The matte coverage of one pixel with the matte mode (and an empty matte) known at compile time. */
function matteFunction(mode: MatteMode, empty: boolean): string {
  if (mode === 0) return "";
  // The matte covers a rectangle of the composition starting at u_matteOrigin; outside it is transparent.
  return `
uniform ivec2 u_matteOrigin;
vec4 matteTexel(sampler2D matte, ivec2 p) {
  ivec2 q = p - u_matteOrigin;
  ivec2 size = textureSize(matte, 0);
  return (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) ? vec4(0.0) : texelFetch(matte, q, 0);
}
float matteCoverage(sampler2D matte, ivec2 p) {
  vec4 m = ${empty ? "vec4(0.0)" : "matteTexel(matte, p)"};
  float v = ${mode <= 2 ? "m.a" : "dot(m.rgb, vec3(0.2126, 0.7152, 0.0722))"};
  return ${mode === 2 || mode === 4 ? "1.0 - v" : "v"};
}
`;
}

export interface PlaceVariant {
  /** 0 none, 1 alpha, 2 alpha inverted, 3 luma, 4 luma inverted. */
  matte: MatteMode;
  /** The matte source draws nothing (ignored when `matte` is 0). */
  empty: boolean;
  /**
   * The placement is a whole-pixel translation at level 0 (identity linear part, integer offset,
   * no hi-level blend), so bilinear sampling reads exactly one texel per pixel: copy it.
   */
  copy: boolean;
  /**
   * A projective (3D) placement: the whole mip chain is bound, one sampler per level, and the level
   * of detail comes from the projective Jacobian per pixel. Never combined with `copy`.
   */
  projective?: boolean;
}

/** Samplers of a projective placement: one per mip level (levels 0..13 of an 8192 px source). */
export const PROJECTIVE_LEVELS = 14;

/** The projective sampling of `placeShader`: `projectiveSample` and `placeProjective` in TypeScript. */
const projectiveSampling = `
uniform sampler2D ${Array.from({ length: PROJECTIVE_LEVELS }, (_, n) => `u_l${n}`).join(", ")};
uniform mat3 u_inv;      // true inverse of the placement, GLSL column-major
uniform float u_near;
uniform int u_maxLevel;  // deepest level to sample
vec4 texel(sampler2D s, ivec2 p, ivec2 size) {
  return (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) ? vec4(0.0) : texelFetch(s, p, 0);
}
vec4 bilinear(sampler2D s, vec2 q) {
  ivec2 size = textureSize(s, 0);
  // Far outside the texture everything is transparent; clamping keeps the integer conversion defined.
  vec2 u = clamp(q - 0.5, vec2(-4.0), vec2(16384.0));
  vec2 base = floor(u);
  vec2 f = u - base;
  ivec2 i = ivec2(base);
  vec4 top = mix(texel(s, i, size), texel(s, i + ivec2(1, 0), size), f.x);
  vec4 bottom = mix(texel(s, i + ivec2(0, 1), size), texel(s, i + ivec2(1, 1), size), f.x);
  return mix(top, bottom, f.y);
}
// Samplers cannot be indexed dynamically in GLSL ES 3.00: a constant-index chain picks the level.
vec4 atLevel(int n, vec2 q) {
  vec2 s = q / float(1 << n); // exact: a power of two
${Array.from(
  { length: PROJECTIVE_LEVELS },
  (_, n) =>
    `  ${n === 0 ? "" : "else "}${n === PROJECTIVE_LEVELS - 1 ? "" : `if (n == ${n}) `}return bilinear(u_l${n}, s);`,
).join("\n")}
}
`;

/**
 * Places a prepared layer into composition space through the inverse placement, bilinear within
 * a mip level and linear between two levels, then applies the track matte and opacity. The matte
 * mode is compiled in, as is the texel-copy fast path (`u_shift` is the integer offset).
 */
export function placeShader({ matte, empty, copy, projective = false }: PlaceVariant): string {
  const factor = matte === 0 ? "u_opacity" : "u_opacity * matteCoverage(u_matte, ivec2(fc))";
  const sample = projective
    ? `vec3 h = u_inv * vec3(fc, 1.0);
    if (h.z > 0.0 && h.z * u_near < 1.0) {
      vec2 q = h.xy / h.z;
      vec2 dx = (u_inv[0].xy - q * u_inv[0].z) / h.z;
      vec2 dy = (u_inv[1].xy - q * u_inv[1].z) / h.z;
      float rho = max(length(dx), length(dy));
      float lod = rho > 1.0 ? min(log2(rho), float(u_maxLevel)) : 0.0;
      int k = int(floor(lod));
      float t = lod - float(k);
      c = atLevel(k, q);
      if (t > 0.0) c = mix(c, atLevel(min(k + 1, u_maxLevel), q), t);
    }`
    : copy
      ? `c = texel(u_lo, ivec2(fc) + u_shift, textureSize(u_lo, 0));`
      : `vec3 p = vec3(fc, 1.0);
    vec2 q = vec2(dot(u_invX, p), dot(u_invY, p));
    c = bilinear(u_lo, q * u_scale.x);
    if (u_t > 0.0) c = mix(c, bilinear(u_hi, q * u_scale.y), u_t);`;
  const affine = `
uniform sampler2D u_lo;
uniform sampler2D u_hi;
uniform vec2 u_scale; // texel scale of the lo and hi levels: 2^-k, 2^-(k+1)
uniform float u_t;    // weight of the hi level
uniform vec3 u_invX;  // inverse placement: q.x = dot(u_invX, (p, 1))
uniform vec3 u_invY;
uniform ivec2 u_shift; // copy variant: the integer offset of the placement`;
  return `${HEADER}${projective ? "" : affine}
uniform bool u_visible;
uniform sampler2D u_matte;
uniform float u_opacity;
uniform vec2 u_origin; // composition pixel of the target's first texel
${matteFunction(matte, empty)}
${
  projective
    ? projectiveSampling
    : `vec4 texel(sampler2D s, ivec2 p, ivec2 size) {
  return (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) ? vec4(0.0) : texelFetch(s, p, 0);
}`
}
${
  projective
    ? ""
    : copy
      ? ""
      : `
vec4 bilinear(sampler2D s, vec2 q) {
  ivec2 size = textureSize(s, 0);
  vec2 u = q - 0.5;
  vec2 base = floor(u);
  vec2 f = u - base;
  ivec2 i = ivec2(base);
  vec4 top = mix(texel(s, i, size), texel(s, i + ivec2(1, 0), size), f.x);
  vec4 bottom = mix(texel(s, i + ivec2(0, 1), size), texel(s, i + ivec2(1, 1), size), f.x);
  return mix(top, bottom, f.y);
}
`
}
void main() {
  // The composition pixel's centre: whole numbers plus one half, so the sum is exact.
  vec2 fc = gl_FragCoord.xy + u_origin;
  vec4 c = vec4(0.0);
  if (u_visible) {
    ${sample}
  }
  float factor = ${factor};
  outColor = c * factor;
}`;
}

/** Blend-mode ids are BLEND_MODE_IDS in pipeline.ts. */

/** Helper functions of the separable modes, in dependency order. */
const BLEND_HELPERS: readonly [name: string, source: string][] = [
  ["multiply", "float multiply(float b, float s) { return b * s; }"],
  ["screen", "float screen(float b, float s) { return b + s - b * s; }"],
  [
    "hardLight",
    "float hardLight(float b, float s) { return s <= 0.5 ? multiply(b, 2.0 * s) : screen(b, 2.0 * s - 1.0); }",
  ],
  [
    "colorDodge",
    `float colorDodge(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}`,
  ],
  [
    "colorBurn",
    `float colorBurn(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}`,
  ],
  [
    "softLight",
    `float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}`,
  ],
];

/** The per-channel expression of each separable mode. */
const SEPARABLE: Readonly<Record<number, string>> = {
  1: "multiply(b, s)",
  2: "screen(b, s)",
  3: "hardLight(s, b)",
  4: "min(b, s)",
  5: "max(b, s)",
  6: "colorDodge(b, s)",
  7: "colorBurn(b, s)",
  8: "hardLight(b, s)",
  9: "softLight(b, s)",
  10: "abs(b - s)",
  11: "b + s - 2.0 * b * s",
  16: "clamp(b + s, 0.0, 1.0)",
  17: "clamp(b - s, 0.0, 1.0)",
  18: "s <= 0.0 ? (b <= 0.0 ? 0.0 : 1.0) : clamp(b / s, 0.0, 1.0)",
  19: "clamp(b + s - 1.0, 0.0, 1.0)",
  20: "clamp(b + 2.0 * s - 1.0, 0.0, 1.0)",
  21: "s <= 0.5 ? colorBurn(b, 2.0 * s) : colorDodge(b, 2.0 * s - 1.0)",
  22: "s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0)",
  23: "b + s >= 1.0 ? 1.0 : 0.0",
};

const NON_SEPARABLE = `
float lum(vec3 c) { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float x = max(max(c.r, c.g), c.b);
  float n = min(min(c.r, c.g), c.b);
  if (x <= n) return vec3(0.0);
  return (c - n) * s / (x - n);
}
`;

const NON_SEPARABLE_COLOR: Readonly<Record<number, string>> = {
  12: "setLum(setSat(s, sat(b)), lum(b))",
  13: "setLum(setSat(b, sat(s)), lum(b))",
  14: "setLum(s, lum(b))",
  15: "setLum(b, lum(s))",
};

/** The `blendColor(vec3 b, vec3 s)` function of one mode (not used for 0, normal). */
function blendColorFunction(mode: number): string {
  const nonSeparable = NON_SEPARABLE_COLOR[mode];
  if (nonSeparable !== undefined)
    return `${NON_SEPARABLE}
vec3 blendColor(vec3 b, vec3 s) { return ${nonSeparable}; }
`;
  const expression = SEPARABLE[mode] ?? "s";
  // Only the helpers this mode's expression reaches, dependencies first.
  let needed = expression;
  const used: string[] = [];
  for (let i = BLEND_HELPERS.length - 1; i >= 0; i--) {
    const [name, source] = BLEND_HELPERS[i] as [string, string];
    if (needed.includes(`${name}(`)) {
      used.unshift(source);
      needed += source;
    }
  }
  return `
${used.join("\n")}
float separable(float b, float s) { return ${expression}; }
vec3 blendColor(vec3 b, vec3 s) {
  return vec3(separable(b.r, s.r), separable(b.g, s.g), separable(b.b, s.b));
}
`;
}

/**
 * Composites a placed layer onto the accumulated backdrop with one blend mode (`mode` is the id
 * from BLEND_MODE_IDS), or, for an adjustment layer, mixes the effected backdrop in through its
 * mask, matte and opacity. One program per (mode, adjustment): no runtime mode switch.
 */
export function blendShader(mode: number, adjustment: boolean): string {
  const color = mode === 0 ? "" : blendColorFunction(mode);
  const head = `${HEADER}
uniform sampler2D u_backdrop;
uniform sampler2D u_source;
${color}`;
  if (adjustment)
    return `${head}
uniform sampler2D u_mask;
uniform bool u_hasMask;
uniform sampler2D u_matte;
uniform int u_matteMode;
uniform bool u_matteEmpty;
uniform float u_opacity;
${MATTE_COVERAGE}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 b = texelFetch(u_backdrop, p, 0);
  vec4 s = texelFetch(u_source, p, 0);
  float coverage = u_hasMask ? texelFetch(u_mask, p, 0).r : 1.0;
  float factor = u_opacity * coverage * matteCoverage(u_matte, p, u_matteMode, u_matteEmpty);
${
  mode === 0
    ? ""
    : `  if (b.a > 0.0 && s.a > 0.0) {
    vec3 cb = clamp(b.rgb / b.a, 0.0, 1.0);
    vec3 cs = clamp(s.rgb / s.a, 0.0, 1.0);
    s.rgb = mix(s.rgb, s.a * blendColor(cb, cs), b.a);
  }
`
}  outColor = mix(b, s, factor);
}`;
  // The source and the target cover one rectangle of the backdrop, starting at u_origin.
  if (mode === 0)
    return `${head}
uniform ivec2 u_origin;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 b = texelFetch(u_backdrop, p + u_origin, 0);
  vec4 s = texelFetch(u_source, p, 0);
  outColor = s + b * (1.0 - s.a);
}`;
  return `${head}
uniform ivec2 u_origin;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 b = texelFetch(u_backdrop, p + u_origin, 0);
  vec4 s = texelFetch(u_source, p, 0);
  if (b.a <= 0.0 || s.a <= 0.0) {
    outColor = s + b * (1.0 - s.a);
    return;
  }
  vec3 cb = clamp(b.rgb / b.a, 0.0, 1.0);
  vec3 cs = clamp(s.rgb / s.a, 0.0, 1.0);
  vec3 mixed = blendColor(cb, cs);
  outColor = vec4(s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * mixed, s.a + b.a * (1.0 - s.a));
}`;
}

/**
 * Copies a source into the viewport, whose first pixel is `u_origin` of the target. With
 * `ONE, ONE_MINUS_SRC_ALPHA` blending on, this is the normal blend mode, `s + b · (1 − s.a)`.
 */
export const COPY = `${HEADER}
uniform sampler2D u_src;
uniform ivec2 u_origin;
void main() {
  outColor = texelFetch(u_src, ivec2(gl_FragCoord.xy) - u_origin, 0);
}`;

/** The root background under the result, quantized to RGBA8 by the framebuffer. */
export const FINAL = `${HEADER}
uniform sampler2D u_acc;
uniform vec4 u_background; // premultiplied
void main() {
  vec4 c = texelFetch(u_acc, ivec2(gl_FragCoord.xy), 0);
  outColor = clamp(c + u_background * (1.0 - c.a), 0.0, 1.0);
}`;
