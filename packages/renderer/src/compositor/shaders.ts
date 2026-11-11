import {
  MAX_AURORA_COLORS,
  MAX_EFFECT_RADIUS,
  MAX_GENERATOR_STOPS,
  MAX_NOISE_OCTAVES,
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

/**
 * Draws a generator (the twin of generators.ts) into a W×H layer-space target, premultiplied.
 * u_type: 0 gradient, 1 noise, 2 pattern, 3 aurora. Pixel centers are (x + 0.5, y + 0.5).
 */
export const GENERATOR = `${HEADER}
uniform int u_type;
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
${HASH}
${BAND}
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

void main() {
  vec2 p = vec2(ivec2(gl_FragCoord.xy)) + 0.5;
  vec4 c = u_type == 0 ? gradientColor(p)
    : u_type == 1 ? noiseColor(p)
    : u_type == 2 ? patternColor(p) : auroraColor(p);
  outColor = vec4(c.rgb * c.a, c.a);
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
uniform float u_offset;
uniform uint u_seed;
uniform int u_frame;
uniform int u_size;
uniform bool u_monochrome;
uniform ivec2 u_origin;
uniform ivec2 u_inner;
${TRANSPARENT_FETCH}
${HASH}
${BAND}

vec4 bilinearAt(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec4 top = mix(at(u_src, i), at(u_src, i + ivec2(1, 0)), f.x);
  vec4 bottom = mix(at(u_src, i + ivec2(0, 1)), at(u_src, i + ivec2(1, 1)), f.x);
  return mix(top, bottom, f.y);
}

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
  if (u_mode == 9) {
    vec2 size = vec2(textureSize(u_src, 0));
    vec2 o = (vec2(p) + 0.5 - size / 2.0) / (0.5 * max(size.x, size.y)) * u_amount;
    vec4 r = bilinearAt(clamp(vec2(p) + 0.5 + o, vec2(0.5), size - 0.5) - 0.5);
    vec4 b = bilinearAt(clamp(vec2(p) + 0.5 - o, vec2(0.5), size - 0.5) - 0.5);
    outColor = vec4(r.r, c.g, b.b, max(r.a, max(c.a, b.a)));
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
    case 7: {
      vec2 halfSize = vec2(u_inner) / 2.0;
      float d = length((vec2(p) + 0.5 - halfSize - vec2(u_origin)) / halfSize);
      float k = smoothstep(u_params.x, u_params.x + u_params.y, d);
      rgb = mix(rgb, u_color.rgb, u_amount * u_color.a * k);
      break;
    }
    case 8: {
      ivec2 cell = ivec2(floor(vec2(p - u_origin) / float(u_size)));
      for (int ch = 0; ch < 3; ch++) {
        uint h = hashWords4(u_seed, uint(u_frame), uint(cell.x), uint(cell.y), u_monochrome ? 0u : uint(ch));
        rgb[ch] = clamp(rgb[ch] + u_amount * 0.5 * (hashUnit(h) * 2.0 - 1.0), 0.0, 1.0);
      }
      break;
    }
    case 10:
      rgb = floor(rgb * (u_amount - 1.0) + 0.5) / (u_amount - 1.0);
      break;
    case 11: {
      float k = band(float(p.y - u_origin.y) + 0.5 - u_offset, u_params.y * u_params.x / 2.0, u_params.x);
      rgb = mix(rgb, u_color.rgb, u_amount * u_color.a * k);
      break;
    }
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
