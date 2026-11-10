/**
 * Four ten-second motion studies, one per draft style pack. Each one is a pure function of
 * (frame) → pixels in a 1920 × 1080 scene: no clock, no Math.random. Randomness comes from a
 * seeded generator, so the same frame always draws the same picture.
 *
 * Colours, springs and staggers come from each pack's tokens (packages/guidelines/src/packs,
 * 0.1.0). Type is simplified: the packs share one family today, and the studies add the
 * page's mono for labels. The studies are drawn by hand for this page; they show the
 * character of a pack, not output of the engine.
 */

import { type Spring, springValue } from "./scene";

export const STUDY = { width: 1920, height: 1080, fps: 30, frames: 300 } as const;

export type StudyId = "keynote" | "playful-saas" | "editorial" | "brutalist";

/** The frame shown when motion is off: each study's most telling moment. */
export const STUDY_POSTER: Record<StudyId, number> = {
  keynote: 200,
  "playful-saas": 170,
  editorial: 200,
  brutalist: 70,
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** 0 → 1 over `duration` frames from `start`. */
export const progress = (frame: number, start: number, duration: number) =>
  clamp01((frame - start) / duration);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeIn = (t: number) => t ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const spring = (frame: number, start: number, s: Spring) =>
  springValue((frame - start) / STUDY.fps, s);

/** Mulberry32: a small seeded generator. Same seed, same sequence. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sans = (weight: number, size: number, wide = false) =>
  `${weight} ${wide ? "expanded " : ""}${size}px "Mona Sans Variable", system-ui, sans-serif`;
const mono = (size: number) => `${size}px "Geist Mono Variable", ui-monospace, monospace`;

type Ctx = CanvasRenderingContext2D;

/** A rounded rectangle path; square corners where the browser has no roundRect (Firefox < 112). */
function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/* Keynote: calm, one idea at a time, springs that never bounce. */

const KEYNOTE = {
  bg: "#000000",
  text: "#f5f5f7",
  muted: "#b0b0b5",
  accent: "#2997ff",
  alt: "#bf5af2",
} as const;
const GENTLE: Spring = { damping: 1, response: 0.7 };

function keynote(ctx: Ctx, f: number) {
  ctx.fillStyle = KEYNOTE.bg;
  ctx.fillRect(0, 0, STUDY.width, STUDY.height);
  const out = 1 - easeIn(progress(f, 252, 40));
  const appear = spring(f, 0, { damping: 1, response: 1.2 });
  const cx = 960;
  const cy = 440;
  const radius = 300 * (0.72 + 0.28 * appear);
  const turn = f * 0.0072;
  const tilt = -0.42;
  // A soft blue light behind the globe.
  const glow = ctx.createRadialGradient(cx, cy + 60, 0, cx, cy + 60, 620);
  glow.addColorStop(0, "rgba(41, 151, 255, 0.22)");
  glow.addColorStop(1, "rgba(41, 151, 255, 0)");
  ctx.globalAlpha = appear * out;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, STUDY.width, STUDY.height);
  // A light wave passes over the globe from pole to pole.
  const wave = progress(f, 66, 130) * 1.5 - 0.25;

  for (let i = 1; i < 18; i++) {
    const phi = (i / 18) * Math.PI;
    const band = Math.exp(-((i / 18 - wave) ** 2) / 0.006);
    for (let j = 0; j < 44; j++) {
      const theta = (j / 44) * Math.PI * 2 + turn;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      const y2 = y * Math.cos(tilt) - z * Math.sin(tilt);
      const z2 = y * Math.sin(tilt) + z * Math.cos(tilt);
      const depth = (z2 + 1) / 2;
      const alpha = (0.1 + 0.9 * depth ** 1.6) * appear * out;
      if (alpha < 0.01) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = band > 0.3 ? (j % 3 === 0 ? KEYNOTE.alt : KEYNOTE.accent) : KEYNOTE.text;
      const size = 1.8 + 2.8 * depth + band * 2.4;
      ctx.beginPath();
      ctx.arc(cx + x * radius, cy + y2 * radius, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // An orbit draws itself, then a single point travels it.
  const trim = easeInOut(progress(f, 54, 70));
  if (trim > 0) {
    ctx.globalAlpha = 0.9 * out;
    ctx.strokeStyle = KEYNOTE.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 470, 112, -0.16, Math.PI * 0.9, Math.PI * 0.9 + Math.PI * 2 * trim);
    ctx.stroke();
    if (trim >= 1) {
      const a = Math.PI * 0.9 + (f - 124) * 0.03;
      const px = cx + 470 * Math.cos(a) * Math.cos(-0.16) - 112 * Math.sin(a) * Math.sin(-0.16);
      const py = cy + 470 * Math.cos(a) * Math.sin(-0.16) + 112 * Math.sin(a) * Math.cos(-0.16);
      ctx.fillStyle = KEYNOTE.text;
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // One line of type, then one line of support.
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const title = spring(f, 120, GENTLE);
  ctx.globalAlpha = clamp01((f - 120) / 10) * out;
  ctx.fillStyle = KEYNOTE.text;
  ctx.font = sans(700, 100);
  ctx.fillText("Every frame.", cx, 900 + (1 - title) * 46);
  const sub = spring(f, 138, GENTLE);
  ctx.globalAlpha = clamp01((f - 138) / 10) * out;
  ctx.fillStyle = KEYNOTE.muted;
  ctx.font = sans(500, 36);
  ctx.fillText("Calm, on purpose, one idea at a time.", cx, 970 + (1 - sub) * 30);
  ctx.globalAlpha = 1;
}

/* Playful SaaS: friendly and quick, springs that bounce once. */

const PLAYFUL = {
  bg: "#fffaf2",
  surface: "#ffffff",
  text: "#1b1437",
  muted: "#5d5676",
  accent: "#6c47ff",
  alt: "#e8336f",
  soft: "#ece7ff",
} as const;
const BOUNCY: Spring = { damping: 0.5, response: 0.45 };

const SHAPES = [
  { x: 330, y: 230, kind: "circle", size: 70, color: PLAYFUL.alt, at: 18 },
  { x: 1600, y: 210, kind: "pill", size: 120, color: PLAYFUL.accent, at: 22 },
  { x: 250, y: 790, kind: "triangle", size: 110, color: PLAYFUL.accent, at: 28 },
  { x: 1680, y: 820, kind: "ring", size: 80, color: PLAYFUL.alt, at: 32 },
  { x: 1450, y: 120, kind: "circle", size: 28, color: PLAYFUL.text, at: 36 },
  { x: 520, y: 980, kind: "pill", size: 80, color: PLAYFUL.alt, at: 40 },
] as const;

const CONFETTI = (() => {
  const next = seeded(7);
  const colors = [PLAYFUL.accent, PLAYFUL.alt, PLAYFUL.text, PLAYFUL.muted];
  return Array.from({ length: 44 }, () => ({
    vx: (next() - 0.5) * 1500,
    vy: -500 - next() * 900,
    spin: (next() - 0.5) * 14,
    w: 14 + next() * 16,
    h: 8 + next() * 8,
    color: colors[Math.floor(next() * colors.length)] as string,
  }));
})();

function shape(ctx: Ctx, kind: string, size: number) {
  ctx.beginPath();
  if (kind === "circle") ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
  else if (kind === "pill") roundRect(ctx, -size / 2, -size / 5, size, (size * 2) / 5, size / 5);
  else if (kind === "triangle") {
    ctx.moveTo(0, -size / 2);
    ctx.lineTo(size / 2, size / 2.4);
    ctx.lineTo(-size / 2, size / 2.4);
    ctx.closePath();
  } else ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
}

function playful(ctx: Ctx, f: number) {
  ctx.fillStyle = PLAYFUL.bg;
  ctx.fillRect(0, 0, STUDY.width, STUDY.height);
  // Everything leaves together at the end: a quick ease-in shrink, so the loop restarts clean.
  const live = 1 - easeIn(progress(f, 256, 22));

  for (const [i, s] of SHAPES.entries()) {
    const drop = spring(f, s.at, BOUNCY);
    if (drop <= 0) continue;
    const float = Math.sin((f + i * 20) * 0.05) * 12;
    ctx.save();
    ctx.translate(s.x, s.y - (1 - drop) * 520 + float);
    ctx.rotate(Math.sin((f + i * 13) * 0.03) * 0.3);
    ctx.scale(live, live);
    shape(ctx, s.kind, s.size);
    if (s.kind === "ring") {
      ctx.lineWidth = 16;
      ctx.strokeStyle = s.color;
      ctx.stroke();
    } else {
      ctx.fillStyle = s.color;
      ctx.fill();
    }
    ctx.restore();
  }

  // The card pops in.
  const pop = spring(f, 6, BOUNCY);
  const cardW = 820;
  const cardH = 470;
  ctx.save();
  ctx.translate(960, 540);
  ctx.scale(pop * live, pop * live);
  ctx.shadowColor = "rgba(27, 20, 55, 0.14)";
  ctx.shadowBlur = 70;
  ctx.shadowOffsetY = 28;
  ctx.fillStyle = PLAYFUL.surface;
  roundRect(ctx, -cardW / 2, -cardH / 2, cardW, cardH, 44);
  ctx.fill();
  ctx.shadowColor = "transparent";

  // Avatar and three lines slide in with a tight stagger.
  ctx.fillStyle = PLAYFUL.accent;
  const face = spring(f, 18, BOUNCY);
  ctx.beginPath();
  ctx.arc(-cardW / 2 + 92, -cardH / 2 + 96, 40 * face, 0, Math.PI * 2);
  ctx.fill();
  const lines = [440, 360, 250];
  for (const [i, w] of lines.entries()) {
    const s = spring(f, 24 + i * 2, BOUNCY);
    ctx.globalAlpha = clamp01(s * 3);
    ctx.fillStyle = i === 0 ? PLAYFUL.text : PLAYFUL.soft;
    roundRect(ctx, -cardW / 2 + 160 + (1 - s) * 120, -cardH / 2 + 70 + i * 52, w, 26, 13);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // The button squashes on the click, then says it is done.
  const press = Math.sin(Math.PI * progress(f, 132, 10));
  const done = f >= 140;
  const settle = done ? spring(f, 140, BOUNCY) : 1;
  const bx = 160;
  const by = 120;
  ctx.save();
  ctx.translate(bx, by);
  ctx.scale(1 - press * 0.12, 1 - press * 0.2);
  ctx.fillStyle = done ? PLAYFUL.alt : PLAYFUL.accent;
  roundRect(ctx, -150 * settle, -46, 300 * settle, 92, 46);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = sans(800, 38);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (done) {
    ctx.fillText("Shipped", 26, 2);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(-112, 0);
    ctx.lineTo(-98, 14);
    ctx.lineTo(-72, -14);
    ctx.stroke();
  } else {
    ctx.fillText("Ship it", 0, 2);
  }
  ctx.restore();
  ctx.restore();

  // Confetti, with gravity, from the button.
  if (f >= 140 && f < 262) {
    const t = (f - 140) / STUDY.fps;
    const ox = 960 + bx;
    const oy = 540 + by;
    for (const c of CONFETTI) {
      const x = ox + c.vx * t;
      const y = oy + c.vy * t + 0.5 * 2200 * t * t;
      ctx.save();
      ctx.globalAlpha = clamp01(2.6 - t) * live;
      ctx.translate(x, y);
      ctx.rotate(c.spin * t);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }
  }

  // The cursor glides in, clicks, and leaves.
  const travel = easeInOut(progress(f, 88, 40));
  const leave = easeIn(progress(f, 176, 30));
  const cx = 1620 + (960 + bx + 30 - 1620) * travel + leave * 500;
  const cy =
    1000 + (540 + by + 26 - 1000) * travel - Math.sin(Math.PI * travel) * 120 + leave * 200;
  if (f > 80 && f < 210) {
    const click = 1 - press * 0.2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(click, click);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 64);
    ctx.lineTo(16, 49);
    ctx.lineTo(28, 76);
    ctx.lineTo(40, 70);
    ctx.lineTo(28, 44);
    ctx.lineTo(50, 44);
    ctx.closePath();
    ctx.fillStyle = PLAYFUL.text;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 5;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

/* Editorial: measured, a magazine spread in motion. Light type, slow fades, a strict grid. */

const EDITORIAL = {
  bg: "#f4f1ea",
  text: "#1a1a1a",
  muted: "#5f5a52",
  accent: "#b3261e",
  alt: "#1f3a5f",
} as const;
const FADE = 24;
const STAGGER = 4;

function fade(f: number, start: number) {
  return easeOut(progress(f, start, FADE));
}

function editorial(ctx: Ctx, f: number) {
  ctx.fillStyle = EDITORIAL.bg;
  ctx.fillRect(0, 0, STUDY.width, STUDY.height);
  const out = 1 - easeInOut(progress(f, 250, 44));
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // The grid draws down the page, column by column.
  ctx.strokeStyle = EDITORIAL.text;
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= 12; i++) {
    const grow = easeOut(progress(f, i * 2, 40));
    ctx.globalAlpha = 0.1 * out;
    const x = 120 + i * 140;
    ctx.beginPath();
    ctx.moveTo(x, 120);
    ctx.lineTo(x, 120 + 840 * grow);
    ctx.stroke();
  }

  // Masthead and its rule.
  ctx.globalAlpha = fade(f, 14) * out;
  ctx.fillStyle = EDITORIAL.text;
  ctx.font = mono(24);
  ctx.fillText("NO. 04 — THE MOTION ISSUE", 120, 96);
  ctx.textAlign = "right";
  ctx.fillText("KYNIMO / EDITORIAL", 1800, 96);
  ctx.textAlign = "left";
  ctx.globalAlpha = out;
  ctx.fillRect(120, 118, 1680 * easeOut(progress(f, 10, 44)), 2);

  // A large light numeral, drifting very slowly.
  ctx.globalAlpha = fade(f, 26) * out;
  ctx.fillStyle = EDITORIAL.alt;
  ctx.font = sans(200, 600);
  ctx.fillText("04", 104 - f * 0.06, 830);

  // The red rule, then the headline word by word.
  ctx.globalAlpha = out;
  ctx.fillStyle = EDITORIAL.accent;
  ctx.fillRect(820, 300, 840 * easeInOut(progress(f, 52, 40)), 6);

  ctx.fillStyle = EDITORIAL.text;
  ctx.font = sans(300, 118);
  const headline = [
    ["Motion,", "set"],
    ["like", "type."],
  ];
  let index = 0;
  for (const [row, words] of headline.entries()) {
    let x = 820;
    for (const word of words) {
      ctx.globalAlpha = fade(f, 72 + index * STAGGER) * out;
      ctx.fillText(word, x, 440 + row * 132);
      x += ctx.measureText(`${word} `).width;
      index++;
    }
  }

  // Two columns of body copy, set on the grid.
  ctx.font = sans(400, 28);
  ctx.fillStyle = EDITORIAL.muted;
  const columns = [
    ["Every keyframe sits on", "the grid. Every pause", "is given room to breathe."],
    ["Light type, slow fades,", "nothing that shouts.", "The frame does the work."],
  ];
  for (const [c, lines] of columns.entries()) {
    for (const [l, line] of lines.entries()) {
      ctx.globalAlpha = fade(f, 128 + c * 10 + l * STAGGER) * out;
      ctx.fillText(line, 820 + c * 420, 740 + l * 44);
    }
  }

  // A folio at the foot of the page.
  ctx.globalAlpha = fade(f, 170) * out;
  ctx.fillStyle = EDITORIAL.accent;
  ctx.font = mono(24);
  ctx.fillText("p. 27", 820, 960);
  ctx.globalAlpha = 1;
}

/* Brutalist: loud and blunt. Nothing eases in. Things appear and stop.
   Large changes stay at or under 3 per second (the pack's flash-rate rule). */

const BRUTAL = {
  bg: "#ffffff",
  text: "#000000",
  accent: "#ff2a00",
  alt: "#0033ff",
} as const;

function brutalist(ctx: Ctx, f: number) {
  ctx.fillStyle = BRUTAL.bg;
  ctx.fillRect(0, 0, STUDY.width, STUDY.height);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const counter = `F${String(f).padStart(3, "0")}`;

  if (f < 36) {
    // Three words, one cut each, 2.5 cuts a second.
    const word = ["MAKE", "IT", "LOUD"][Math.floor(f / 12)] as string;
    ctx.fillStyle = BRUTAL.text;
    ctx.font = sans(900, 400, true);
    ctx.fillText(word, 960, 560);
    ctx.fillStyle = BRUTAL.accent;
    ctx.fillRect(160, 860, 1600, 40);
  } else if (f < 120) {
    // A black slab, cut in on the same frame LOUD cuts out: one change, not two.
    ctx.fillStyle = BRUTAL.text;
    ctx.fillRect(0, 0, 960, STUDY.height);
    ctx.fillStyle = BRUTAL.bg;
    ctx.font = sans(900, 300, true);
    ctx.fillText("NO", 480, 470);
    ctx.fillStyle = BRUTAL.accent;
    ctx.font = sans(900, 120, true);
    ctx.fillText("EASE", 480, 720);
    // A grid of red squares, one more every two frames.
    for (let k = 0; k < 16; k++) {
      if (f < 44 + k * 2) break;
      const col = k % 4;
      const row = Math.floor(k / 4);
      ctx.fillStyle = k === 9 ? BRUTAL.alt : BRUTAL.accent;
      ctx.fillRect(1140 + col * 150, 250 + row * 150, 120, 120);
    }
  } else if (f < 204) {
    // The name runs across the frame at constant speed, cropped by both edges.
    ctx.font = sans(900, 560, true);
    const width = ctx.measureText("KYNIMO").width;
    const x = 1920 + width / 2 - ((f - 120) / 84) * (1920 + width);
    ctx.fillStyle = BRUTAL.text;
    ctx.fillText("KYNIMO", x, 520);
    ctx.fillStyle = BRUTAL.accent;
    ctx.fillRect(0, 830, 1920, 56);
    ctx.fillStyle = BRUTAL.bg;
    ctx.font = mono(34);
    ctx.textAlign = "left";
    ctx.fillText("LINEAR 200 MS · STAGGER 67 MS", 40, 860);
  } else if (f < 264) {
    // Split frame.
    ctx.fillStyle = BRUTAL.text;
    ctx.fillRect(0, 0, 960, STUDY.height);
    ctx.font = sans(900, 150, true);
    ctx.fillStyle = BRUTAL.accent;
    ctx.fillText("JUST", 480, 440);
    ctx.fillText("CUTS.", 480, 620);
    ctx.fillStyle = BRUTAL.text;
    ctx.fillText("NO", 1440, 440);
    ctx.fillText("FADES.", 1440, 620);
  } else if (f < 288) {
    ctx.fillStyle = BRUTAL.accent;
    ctx.fillRect(880, 460, 160, 160);
  }

  // A running frame counter, always on top.
  if (f < 288) {
    ctx.textAlign = "left";
    ctx.font = mono(40);
    ctx.fillStyle = f >= 204 && f < 264 ? BRUTAL.bg : BRUTAL.text;
    ctx.fillText(counter, 48, 60);
  }
}

/** The four draft packs as the page shows them. Accents are the studies' own palettes. */
export const PACKS: readonly {
  id: StudyId;
  name: string;
  accent: string;
  summary: string;
  tokens: string;
}[] = [
  {
    id: "keynote",
    name: "Keynote",
    accent: KEYNOTE.accent,
    summary: "Calm and confident. One idea at a time, long holds, springs that never bounce.",
    tokens: "spring 1.0 / 0.7 s · stagger 100 ms",
  },
  {
    id: "playful-saas",
    name: "Playful SaaS",
    accent: PLAYFUL.accent,
    summary: "Friendly and quick. Bright accents, tight staggers, springs that bounce once.",
    tokens: "spring 0.5 / 0.45 s · stagger 65 ms",
  },
  {
    id: "editorial",
    name: "Editorial",
    accent: EDITORIAL.accent,
    summary: "Measured, like a magazine spread in motion. Light type, slow fades, a strict grid.",
    tokens: "fade 800 ms · stagger 140 ms",
  },
  {
    id: "brutalist",
    name: "Brutalist",
    accent: BRUTAL.accent,
    summary: "Loud and blunt. Nothing eases in. Things appear and stop.",
    tokens: "linear 200 ms · stagger 67 ms",
  },
];

const DRAW: Record<StudyId, (ctx: Ctx, frame: number) => void> = {
  keynote,
  "playful-saas": playful,
  editorial,
  brutalist,
};

/** Draw one frame of a pack's study into a canvas of any size. */
export function drawStudy(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  id: StudyId,
  frameInput: number,
): void {
  const frame = ((Math.floor(frameInput) % STUDY.frames) + STUDY.frames) % STUDY.frames;
  const k = width / STUDY.width;
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.rect(0, 0, STUDY.width, height / k);
  ctx.clip();
  DRAW[id](ctx, frame);
  ctx.restore();
}
