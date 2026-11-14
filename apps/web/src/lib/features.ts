/**
 * Six short motion studies, one per engine feature. Each is a pure function of (frame) → pixels
 * in a 1920 × 1080 scene, in the page's own palette: no clock, no Math.random, so the same
 * frame always draws the same picture. They are drawn by hand for this page to show what a
 * feature does; they are not output of the engine.
 */

import { type Spring, springValue } from "./scene";

export const FEATURE = { width: 1920, height: 1080, fps: 30, frames: 180 } as const;

export const FEATURES = [
  {
    id: "text",
    name: "Text animators",
    body: "Move type per character, word or line, with range selectors that sweep through it.",
    label:
      "Text animator study: the word Kinetic rises one character at a time as a selector line sweeps across it.",
    poster: 96,
  },
  {
    id: "shapes",
    name: "Shape operators",
    body: "Trim paths, repeaters, round corners and path morphing, stacked in any order.",
    label:
      "Shape operator study: a ring draws itself, twelve copies fan out around it and a square rounds into a circle.",
    poster: 110,
  },
  {
    id: "mattes",
    name: "Masks and mattes",
    body: "Cut any layer with a mask, or reveal it through the shape of another layer.",
    label: "Matte study: a circle travels across outlined type and fills in the letters it covers.",
    poster: 90,
  },
  {
    id: "easing",
    name: "Springs and curves",
    body: "Bezier keyframes for exact timing, springs for motion that settles like a real object.",
    label:
      "Easing study: two blocks cross the frame, one on a spring that overshoots and settles, one on a bezier curve.",
    poster: 70,
  },
  {
    id: "shaders",
    name: "Shaders",
    body: "GLSL generators, looks and transitions. Your agent can write its own, with typed inputs.",
    label: "Shader study: a slow field of dithered yellow waves.",
    poster: 40,
  },
  {
    id: "camera",
    name: "Cameras and depth",
    body: "Layers placed in depth, a camera that moves through them, and real motion blur.",
    label: "Camera study: a camera drifts past five cards set at different depths.",
    poster: 60,
  },
] as const;

export type FeatureId = (typeof FEATURES)[number]["id"];

const C = {
  bg: "#0c0b0a",
  surface: "#171513",
  line: "#3d3832",
  text: "#ede8df",
  muted: "#a39c90",
  accent: "#f5c842",
} as const;

const W = FEATURE.width;
const H = FEATURE.height;
const TAU = Math.PI * 2;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** 0 → 1 over `duration` frames from `start`. */
export const progress = (frame: number, start: number, duration: number) =>
  clamp01((frame - start) / duration);
const easeIn = (t: number) => t ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const spring = (frame: number, start: number, s: Spring) =>
  springValue((frame - start) / FEATURE.fps, s);

const sans = (weight: number, size: number) =>
  `${weight} expanded ${size}px "Mona Sans Variable", system-ui, sans-serif`;
const mono = (size: number) => `${size}px "Geist Mono Variable", ui-monospace, monospace`;

type Ctx = CanvasRenderingContext2D;

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/* Text animators: one word, a range selector sweeping through its characters. */

const SOFT: Spring = { damping: 0.82, response: 0.5 };

function text(ctx: Ctx, f: number) {
  const word = "Kinetic";
  ctx.font = sans(800, 320);
  ctx.textBaseline = "alphabetic";
  const widths = [...word].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0);
  const left = (W - total) / 2;
  const baseline = 650;
  // The selector: a line that crosses the word. Characters it has passed are animated in.
  const sweep = easeInOut(progress(f, 10, 70));
  const leave = easeIn(progress(f, 140, 30));
  let x = left;
  [...word].forEach((ch, i) => {
    const start = 10 + ((x + (widths[i] ?? 0) / 2 - left) / total) * 70;
    const p = spring(f, start, SOFT);
    const out = easeIn(progress(f, 138 + i * 3, 22));
    ctx.globalAlpha = clamp01((f - start) / 5) * (1 - out);
    ctx.fillStyle = C.text;
    ctx.fillText(ch, x, baseline + (1 - p) * 190 - out * 120);
    x += widths[i] ?? 0;
  });
  const lineX = lerp(left - 60, left + total + 60, sweep);
  ctx.globalAlpha = (1 - progress(f, 82, 14)) * clamp01(f / 8) * (1 - leave);
  ctx.fillStyle = C.accent;
  ctx.fillRect(lineX - 3, 300, 6, 460);
  // The range the selector covers, as a bar under the word.
  ctx.globalAlpha = 1 - leave;
  ctx.fillStyle = C.line;
  ctx.fillRect(left, 820, total, 6);
  ctx.fillStyle = C.accent;
  ctx.fillRect(left, 820, total * sweep, 6);
}

/* Shape operators: trim path, repeater, round corners. */

function shapes(ctx: Ctx, f: number) {
  const cx = W / 2;
  const cy = H / 2;
  const out = easeIn(progress(f, 150, 30));
  // Trim path: the ring draws from 0 to 100 %, then its start chases the end.
  const end = easeInOut(progress(f, 6, 60));
  const startTrim = easeInOut(progress(f, 120, 50));
  ctx.lineWidth = 14;
  ctx.lineCap = "round";
  ctx.strokeStyle = C.line;
  ctx.globalAlpha = 1 - out;
  ctx.beginPath();
  ctx.arc(cx, cy, 380, 0, TAU);
  ctx.stroke();
  if (end > startTrim) {
    ctx.strokeStyle = C.accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 380, -TAU / 4 + startTrim * TAU, -TAU / 4 + end * TAU);
    ctx.stroke();
  }
  // Repeater: twelve copies, each offset by rotation, arriving one after another.
  for (let i = 0; i < 12; i++) {
    const p = spring(f, 30 + i * 3, { damping: 0.7, response: 0.45 });
    const angle = (i / 12) * TAU - TAU / 4 + f * 0.004;
    ctx.save();
    ctx.translate(cx + Math.cos(angle) * 250 * p, cy + Math.sin(angle) * 250 * p);
    ctx.rotate(angle);
    ctx.globalAlpha = clamp01((f - 30 - i * 3) / 5) * (1 - out) * (0.35 + 0.65 * (i / 11));
    ctx.fillStyle = C.text;
    roundRect(ctx, -26, -26, 52, 52, 10);
    ctx.fill();
    ctx.restore();
  }
  // Round corners: a square that becomes a circle and back.
  const round = easeInOut(progress(f, 66, 30)) - easeInOut(progress(f, 118, 26));
  const size = 190 * spring(f, 12, { damping: 0.75, response: 0.5 });
  ctx.globalAlpha = 1 - out;
  ctx.fillStyle = C.accent;
  roundRect(ctx, cx - size / 2, cy - size / 2, size, size, (size / 2) * clamp01(round));
  ctx.fill();
}

/* Masks and mattes: type that is only filled where a second layer covers it. */

function mattes(ctx: Ctx, f: number) {
  const word = "REVEAL";
  ctx.font = sans(800, 330);
  ctx.textBaseline = "alphabetic";
  const width = ctx.measureText(word).width;
  const x = (W - width) / 2;
  const baseline = 655;
  const fade = clamp01(f / 10) * (1 - easeIn(progress(f, 156, 24)));
  ctx.globalAlpha = fade * 0.7;
  ctx.lineWidth = 3;
  ctx.strokeStyle = C.muted;
  ctx.strokeText(word, x, baseline);
  ctx.globalAlpha = fade;
  // The matte layer: a circle that crosses the frame, growing to cover everything.
  const travel = easeInOut(progress(f, 8, 96));
  const grow = easeIn(progress(f, 104, 34));
  const mx = lerp(x - 120, x + width + 120, travel);
  const radius = 250 + grow * 1500;
  ctx.save();
  ctx.beginPath();
  ctx.arc(mx, 540, radius, 0, TAU);
  ctx.clip();
  ctx.fillStyle = C.surface;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.accent;
  ctx.fillText(word, x, baseline);
  ctx.restore();
  ctx.globalAlpha = fade * (1 - grow);
  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 12]);
  ctx.beginPath();
  ctx.arc(mx, 540, radius, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
}

/* Springs and curves: the same move, timed two ways, with the curve that drives each. */

const BOUNCY: Spring = { damping: 0.42, response: 0.62 };

/** Cubic bezier (0.65, 0, 0.35, 1) solved for y at time x by bisection: fixed work. */
function bezierEase(x: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const t = (lo + hi) / 2;
    const bx = 3 * (1 - t) ** 2 * t * 0.65 + 3 * (1 - t) * t ** 2 * 0.35 + t ** 3;
    if (bx < x) lo = t;
    else hi = t;
  }
  const t = (lo + hi) / 2;
  return 3 * (1 - t) * t ** 2 + t ** 3;
}

function easing(ctx: Ctx, f: number) {
  const fade = clamp01(f / 8) * (1 - easeIn(progress(f, 156, 24)));
  const span = 96; // frames the move takes on the graph
  const rows = [
    { name: "spring", y: 300, value: (n: number) => springValue((n * span) / FEATURE.fps, BOUNCY) },
    { name: "bezier", y: 760, value: (n: number) => bezierEase(clamp01(n / 0.6)) },
  ] as const;
  const now = progress(f, 16, span);
  for (const row of rows) {
    const gx = 200;
    const gw = 520;
    const gh = 220;
    ctx.globalAlpha = fade;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.strokeRect(gx, row.y - gh / 2, gw, gh);
    // The curve, drawn up to the current time.
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const n = (i / 60) * now;
      const px = gx + n * gw;
      const py = row.y + gh / 2 - 24 - row.value(n) * (gh - 80);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = C.muted;
    ctx.font = mono(44);
    ctx.textBaseline = "alphabetic";
    ctx.fillText(row.name, gx, row.y - gh / 2 - 24);
    // The block that curve moves.
    const from = 860;
    const to = 1560;
    ctx.fillStyle = C.line;
    ctx.fillRect(from, row.y + 78, to - from + 160, 4);
    ctx.fillStyle = row.name === "spring" ? C.accent : C.text;
    roundRect(ctx, lerp(from, to, row.value(now)), row.y - 80, 160, 160, 22);
    ctx.fill();
  }
}

/* Shaders: a wave field through a 4 × 4 ordered dither, the page's own texture. */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

function shaders(ctx: Ctx, f: number) {
  const t = (f / FEATURE.frames) * TAU;
  const cell = 24;
  ctx.fillStyle = C.accent;
  for (let gy = 0; gy < H / cell; gy++) {
    for (let gx = 0; gx < W / cell; gx++) {
      const u = gx / (W / cell);
      const v = gy / (H / cell);
      const wave =
        Math.sin(u * 7 + t + Math.sin(v * 5 - t) * 1.4) * 0.5 +
        Math.sin(v * 9 - t * 2 + u * 3) * 0.3 +
        Math.sin((u + v) * 4 + t) * 0.2;
      const edge = 1 - Math.hypot(u - 0.5, v - 0.5) * 1.1;
      const level = clamp01((wave * 0.5 + 0.5) * edge);
      const threshold = ((BAYER[(gy % 4) * 4 + (gx % 4)] ?? 0) + 0.5) / 16;
      if (level > threshold) ctx.fillRect(gx * cell + 3, gy * cell + 3, cell - 6, cell - 6);
    }
  }
}

/* Cameras and depth: flat cards at different depths, one camera drifting past. */

const CARDS = [
  { x: -620, y: -60, z: 2600, w: 620, h: 380, lit: false },
  { x: 520, y: -220, z: 2100, w: 560, h: 340, lit: false },
  { x: -80, y: 120, z: 1500, w: 640, h: 400, lit: true },
  { x: 700, y: 240, z: 1050, w: 460, h: 290, lit: false },
  { x: -760, y: 300, z: 760, w: 420, h: 260, lit: false },
] as const;

function camera(ctx: Ctx, f: number) {
  const t = (f / FEATURE.frames) * TAU;
  const camX = Math.sin(t) * 420;
  const camY = Math.cos(t) * 60;
  const camZ = -200 + (1 - Math.cos(t)) * 170;
  const focal = 1500;
  for (const card of CARDS) {
    const depth = card.z - camZ;
    const k = focal / depth;
    const x = W / 2 + (card.x - camX) * k;
    const y = H / 2 + (card.y - camY) * k;
    const w = card.w * k;
    const h = card.h * k;
    const near = clamp01(1.25 - depth / 2600);
    ctx.globalAlpha = 1;
    ctx.fillStyle = card.lit ? C.accent : C.surface;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, 18 * k);
    ctx.fill();
    ctx.globalAlpha = 0.35 + 0.65 * near;
    ctx.strokeStyle = card.lit ? C.accent : C.muted;
    ctx.lineWidth = Math.max(1.5, 3 * k);
    ctx.stroke();
    // Two lines of stand-in content, so the cards read as layers.
    ctx.fillStyle = card.lit ? C.bg : C.line;
    ctx.fillRect(x - w / 2 + 40 * k, y - h / 2 + 46 * k, w * 0.5, 26 * k);
    ctx.fillRect(x - w / 2 + 40 * k, y - h / 2 + 96 * k, w * 0.3, 14 * k);
  }
}

const DRAW: Record<FeatureId, (ctx: Ctx, frame: number) => void> = {
  text,
  shapes,
  mattes,
  easing,
  shaders,
  camera,
};

/** Draw one frame of a feature study into a canvas of any size. Frames wrap around the loop. */
export function drawFeature(
  ctx: Ctx,
  width: number,
  height: number,
  id: FeatureId,
  frame: number,
): void {
  const f = ((Math.floor(frame) % FEATURE.frames) + FEATURE.frames) % FEATURE.frames;
  const k = width / W;
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, height / k);
  DRAW[id](ctx, f);
  ctx.globalAlpha = 1;
  ctx.restore();
}
