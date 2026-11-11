import { MAX_EFFECT_RADIUS } from "@kynimo/scene";

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

/** Straight-color corrections preserve the source's coverage. Shadow and glow sit under it. */
export const EFFECT = `${HEADER}
uniform sampler2D u_src;
uniform sampler2D u_blur;
uniform int u_mode;
uniform vec2 u_params;
uniform vec4 u_color;
uniform vec4 u_white;
uniform float u_amount;
${TRANSPARENT_FETCH}

float shiftedAlpha(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  float top = mix(at(u_blur, i).a, at(u_blur, i + ivec2(1, 0)).a, f.x);
  float bottom = mix(at(u_blur, i + ivec2(0, 1)).a, at(u_blur, i + ivec2(1, 1)).a, f.x);
  return mix(top, bottom, f.y);
}

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

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  if (u_mode <= 2) {
    float a = u_mode == 1 ? shiftedAlpha(vec2(p) - u_params) : texelFetch(u_blur, p, 0).a;
    vec4 under = vec4(u_color.rgb, 1.0) * (a * u_color.a * u_amount);
    outColor = c + under * (1.0 - c.a);
    return;
  }
  if (c.a <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  vec3 rgb = clamp(c.rgb / c.a, 0.0, 1.0);
  switch (u_mode) {
    case 3:
      rgb = (rgb - 0.5) * (1.0 + u_params.y) + 0.5 + u_params.x;
      break;
    case 4:
      rgb = hueSaturation(rgb, u_params.x, u_params.y);
      break;
    case 5: {
      float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      vec4 tint = mix(u_color, u_white, l);
      rgb = mix(rgb, tint.rgb, tint.a * u_amount);
      break;
    }
    case 6:
      rgb = mix(rgb, u_color.rgb, u_color.a * u_amount);
      break;
  }
  outColor = vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a);
}`;

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

/**
 * Places a prepared layer into composition space through the inverse placement, bilinear within
 * a mip level and linear between two levels, then applies the track matte and opacity.
 * u_matteMode: 0 none, 1 alpha, 2 alpha inverted, 3 luma, 4 luma inverted; u_matteEmpty means the
 * source draws nothing.
 */
export const PLACE = `${HEADER}
uniform sampler2D u_lo;
uniform sampler2D u_hi;
uniform vec2 u_scale; // texel scale of the lo and hi levels: 2^-k, 2^-(k+1)
uniform float u_t;    // weight of the hi level
uniform vec3 u_invX;  // inverse placement: q.x = dot(u_invX, (p, 1))
uniform vec3 u_invY;
uniform bool u_visible;
uniform sampler2D u_matte;
uniform int u_matteMode;
uniform bool u_matteEmpty;
uniform float u_opacity;
${MATTE_COVERAGE}

vec4 texel(sampler2D s, ivec2 p, ivec2 size) {
  return (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) ? vec4(0.0) : texelFetch(s, p, 0);
}

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

void main() {
  vec4 c = vec4(0.0);
  if (u_visible) {
    vec3 p = vec3(gl_FragCoord.xy, 1.0);
    vec2 q = vec2(dot(u_invX, p), dot(u_invY, p));
    c = bilinear(u_lo, q * u_scale.x);
    if (u_t > 0.0) c = mix(c, bilinear(u_hi, q * u_scale.y), u_t);
  }
  float factor = u_opacity * matteCoverage(u_matte, ivec2(gl_FragCoord.xy), u_matteMode, u_matteEmpty);
  outColor = c * factor;
}`;

/** Blend-mode ids are BLEND_MODE_IDS in pipeline.ts. */
export const BLEND = `${HEADER}
uniform sampler2D u_backdrop;
uniform sampler2D u_source;
uniform int u_mode;
uniform bool u_adjustment;
uniform sampler2D u_mask;
uniform bool u_hasMask;
uniform sampler2D u_matte;
uniform int u_matteMode;
uniform bool u_matteEmpty;
uniform float u_opacity;
${MATTE_COVERAGE}

float multiply(float b, float s) { return b * s; }
float screen(float b, float s) { return b + s - b * s; }
float hardLight(float b, float s) { return s <= 0.5 ? multiply(b, 2.0 * s) : screen(b, 2.0 * s - 1.0); }
float colorDodge(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}
float colorBurn(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}
float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}

float separable(int mode, float b, float s) {
  switch (mode) {
    case 1: return multiply(b, s);
    case 2: return screen(b, s);
    case 3: return hardLight(s, b);
    case 4: return min(b, s);
    case 5: return max(b, s);
    case 6: return colorDodge(b, s);
    case 7: return colorBurn(b, s);
    case 8: return hardLight(b, s);
    case 9: return softLight(b, s);
    case 10: return abs(b - s);
    case 11: return b + s - 2.0 * b * s;
    case 16: return clamp(b + s, 0.0, 1.0);
    case 17: return clamp(b - s, 0.0, 1.0);
    case 18: return s <= 0.0 ? (b <= 0.0 ? 0.0 : 1.0) : clamp(b / s, 0.0, 1.0);
    case 19: return clamp(b + s - 1.0, 0.0, 1.0);
    case 20: return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
    case 21: return s <= 0.5 ? colorBurn(b, 2.0 * s) : colorDodge(b, 2.0 * s - 1.0);
    case 22: return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);
    case 23: return b + s >= 1.0 ? 1.0 : 0.0;
    default: return s;
  }
}

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

vec3 blendColor(int mode, vec3 b, vec3 s) {
  switch (mode) {
    case 12: return setLum(setSat(s, sat(b)), lum(b));
    case 13: return setLum(setSat(b, sat(s)), lum(b));
    case 14: return setLum(s, lum(b));
    case 15: return setLum(b, lum(s));
    default: return vec3(separable(mode, b.r, s.r), separable(mode, b.g, s.g), separable(mode, b.b, s.b));
  }
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 b = texelFetch(u_backdrop, p, 0);
  vec4 s = texelFetch(u_source, p, 0);
  if (u_adjustment) {
    float coverage = u_hasMask ? texelFetch(u_mask, p, 0).r : 1.0;
    float factor = u_opacity * coverage * matteCoverage(u_matte, p, u_matteMode, u_matteEmpty);
    if (u_mode != 0 && b.a > 0.0 && s.a > 0.0) {
      vec3 cb = clamp(b.rgb / b.a, 0.0, 1.0);
      vec3 cs = clamp(s.rgb / s.a, 0.0, 1.0);
      s.rgb = mix(s.rgb, s.a * blendColor(u_mode, cb, cs), b.a);
    }
    outColor = mix(b, s, factor);
    return;
  }
  if (u_mode == 0 || b.a <= 0.0 || s.a <= 0.0) {
    outColor = s + b * (1.0 - s.a);
    return;
  }
  vec3 cb = clamp(b.rgb / b.a, 0.0, 1.0);
  vec3 cs = clamp(s.rgb / s.a, 0.0, 1.0);
  vec3 mixed = blendColor(u_mode, cb, cs);
  outColor = vec4(s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * mixed, s.a + b.a * (1.0 - s.a));
}`;

/** The root background under the result, quantized to RGBA8 by the framebuffer. */
export const FINAL = `${HEADER}
uniform sampler2D u_acc;
uniform vec4 u_background; // premultiplied
void main() {
  vec4 c = texelFetch(u_acc, ivec2(gl_FragCoord.xy), 0);
  outColor = clamp(c + u_background * (1.0 - c.a), 0.0, 1.0);
}`;
