/**
 * The demo scene every section of the landing page draws.
 *
 * It is a small stand-in for the real engine, built on the same idea: a pure function of
 * (scene, frame) → pixels. No clock, no randomness. The page scrubs it, re-themes it and
 * edits it, and the same frame always looks the same.
 */

export const SCENE = { width: 1920, height: 1080, fps: 30, frames: 150 } as const;

/** Apple-style spring: damping ratio (1 = no overshoot) and response in seconds. */
export interface Spring {
  damping: number;
  response: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Position of a spring released at 0 towards 1, `t` seconds in. */
export function springValue(t: number, { damping, response }: Spring): number {
  if (t <= 0) return 0;
  const w = (2 * Math.PI) / response;
  if (damping >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
  const wd = w * Math.sqrt(1 - damping * damping);
  const decay = Math.exp(-damping * w * t);
  return 1 - decay * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
}

export type Entrance = "spring" | "fade" | "cut";

/** How a scene looks and moves. The page's own look plus one per guideline pack. */
export interface Look {
  id: string;
  name: string;
  bg: string;
  text: string;
  muted: string;
  accent: string;
  weight: number;
  wide: boolean;
  upper: boolean;
  entrance: Entrance;
  spring: Spring;
  /** Frames between one element starting and the next. */
  stagger: number;
  /** Pixels an element travels on entry, in scene units. */
  travel: number;
}

export const KYNIMO_LOOK: Look = {
  id: "kynimo",
  name: "Kynimo",
  bg: "#0c0b0a",
  text: "#ede8df",
  muted: "#a39c90",
  accent: "#f5c842",
  weight: 800,
  wide: true,
  upper: false,
  entrance: "spring",
  spring: { damping: 1, response: 0.7 },
  stagger: 3,
  travel: 560,
};

/**
 * Colours, springs and staggers copied from the draft packs in
 * packages/guidelines/src/packs (0.1.0). Type is simplified: the page draws every pack
 * in its own typeface.
 */
export const PACK_LOOKS: readonly (Look & { summary: string; tokens: string })[] = [
  {
    id: "keynote",
    name: "Keynote",
    bg: "#000000",
    text: "#f5f5f7",
    muted: "#b0b0b5",
    accent: "#2997ff",
    weight: 700,
    wide: false,
    upper: false,
    entrance: "spring",
    spring: { damping: 1, response: 0.7 },
    stagger: 3,
    travel: 420,
    summary: "Calm and confident. One idea at a time, long holds, springs that never bounce.",
    tokens: "spring 1.0 / 0.7 s · stagger 100 ms",
  },
  {
    id: "playful-saas",
    name: "Playful SaaS",
    bg: "#fffaf2",
    text: "#1b1437",
    muted: "#5d5676",
    accent: "#6c47ff",
    weight: 800,
    wide: false,
    upper: false,
    entrance: "spring",
    spring: { damping: 0.5, response: 0.45 },
    stagger: 2,
    travel: 420,
    summary: "Friendly and quick. Bright accents, tight staggers, springs that bounce once.",
    tokens: "spring 0.5 / 0.45 s · stagger 65 ms",
  },
  {
    id: "editorial",
    name: "Editorial",
    bg: "#f4f1ea",
    text: "#1a1a1a",
    muted: "#5f5a52",
    accent: "#b3261e",
    weight: 300,
    wide: false,
    upper: false,
    entrance: "fade",
    spring: { damping: 1, response: 0.9 },
    stagger: 4,
    travel: 0,
    summary: "Measured, like a magazine spread in motion. Light type, slow fades, a strict grid.",
    tokens: "fade 800 ms · stagger 140 ms",
  },
  {
    id: "brutalist",
    name: "Brutalist",
    bg: "#ffffff",
    text: "#000000",
    muted: "#3d3d3d",
    accent: "#ff2a00",
    weight: 900,
    wide: true,
    upper: true,
    entrance: "cut",
    spring: { damping: 1.2, response: 0.18 },
    stagger: 2,
    travel: 240,
    summary: "Loud and blunt. Nothing eases in. Things appear and stop.",
    tokens: "linear 200 ms · stagger 67 ms",
  },
];

export type SceneLayer = "mark" | "title" | "rule" | "caption";
export const SCENE_LAYERS: readonly SceneLayer[] = ["mark", "title", "rule", "caption"];

export interface SceneState {
  look: Look;
  title: string;
  caption: string;
  /** Overrides the look's accent (the edit demo). */
  accent?: string;
  /** Overrides the look's stagger, in frames (the edit demo). */
  stagger?: number;
  /** How many layers exist yet, in SCENE_LAYERS order. */
  layers: number;
  /** False before keyframes are set: layers sit at rest. */
  animated: boolean;
  /** False while the quality findings are open: short hold, caption outside the safe area. */
  fixed: boolean;
  /** Stroboscopic trails behind moving layers. */
  echoes: boolean;
  /** Draw the safe area and outline a layer (the quality section). */
  guides?: boolean;
  highlight?: SceneLayer | null;
}

export const DEFAULT_TITLE = "Every frame, on purpose.";
export const DEFAULT_CAPTION = "Made over MCP";

/** Frame the title starts to leave. The unfixed scene cuts the hold short on purpose. */
export const OUT_FRAME = { open: 84, fixed: 132 } as const;
/** The unfixed scene loops early, so its short hold reads as rushed rather than as a blank tail. */
export const LOOP_FRAMES = { open: OUT_FRAME.open + 16, fixed: SCENE.frames } as const;
export const SAFE_MARGIN = 0.05;
const CAPTION_BASELINE = { open: SCENE.height - 22, fixed: SCENE.height - 76 } as const;

const MARK_PIECES = [
  "M0 0H5V120H0Z",
  "M11 0H21V120H11Z",
  "M47 0H74L47 27Z",
  "M51 60L74 37V83Z",
  "M47 93L74 120H47Z",
  "M111 0H132V120H111L82 91V29Z",
] as const;
const MARK = { x: 160, y: 132, scale: 208 / 120 } as const;
const LEFT = 160;
const TITLE_MAX_WIDTH = 1600;
const ECHO_STEP = 2;
const ECHO_COUNT = 5;

export interface Pose {
  /** Horizontal offset from rest, scene px. */
  dx: number;
  dy: number;
  opacity: number;
  /** 0 → 1 growth, used by the rule. */
  grow: number;
}

/** Where an element that starts at `start` is on `frame`. Pure. */
export function poseAt(
  frame: number,
  start: number,
  out: number,
  look: Pick<Look, "entrance" | "spring" | "travel">,
  axis: "x" | "y",
): Pose {
  const since = frame - start;
  let progress: number;
  let opacity: number;
  if (look.entrance === "spring") {
    progress = springValue(since / SCENE.fps, look.spring);
    opacity = clamp01(since / 4);
  } else if (look.entrance === "fade") {
    const p = clamp01(since / 24);
    progress = 1 - (1 - p) ** 3;
    opacity = progress;
  } else {
    progress = clamp01(since / 6);
    opacity = since >= 0 ? 1 : 0;
  }
  const travel = axis === "x" ? look.travel : look.travel * 0.18;
  let dx = axis === "x" ? (1 - progress) * travel : 0;
  const dy = axis === "y" ? (1 - progress) * travel : 0;

  const leaving = clamp01((frame - out) / 10);
  if (leaving > 0) {
    if (look.entrance === "cut") {
      opacity = 0;
    } else {
      const eased = leaving * leaving;
      opacity *= 1 - eased;
      dx -= eased * 90;
    }
  }
  return { dx, dy, opacity, grow: progress };
}

function fontOf(look: Look, size: number, weight = look.weight): string {
  const stretch = look.wide ? "expanded " : "";
  return `${weight} ${stretch}${size}px "Mona Sans Variable", system-ui, sans-serif`;
}

interface TitleLayout {
  size: number;
  lines: string[][];
}

/** Break the title into at most two lines, shrinking the type until it fits. */
function layoutTitle(ctx: CanvasRenderingContext2D, look: Look, raw: string): TitleLayout {
  const text = (look.upper ? raw.toUpperCase() : raw).trim();
  const words = text.length > 0 ? text.split(/\s+/) : [];
  for (let size = 150; size >= 64; size -= 8) {
    ctx.font = fontOf(look, size);
    const space = ctx.measureText(" ").width;
    const lines: string[][] = [[]];
    let width = 0;
    let fits = true;
    for (const word of words) {
      const w = ctx.measureText(word).width;
      if (w > TITLE_MAX_WIDTH) fits = false;
      const line = lines[lines.length - 1] as string[];
      if (line.length > 0 && width + space + w > TITLE_MAX_WIDTH) {
        lines.push([word]);
        width = w;
      } else {
        width += (line.length > 0 ? space : 0) + w;
        line.push(word);
      }
    }
    if ((fits && lines.length <= 2) || size <= 64) return { size, lines };
  }
  return { size: 64, lines: [words] };
}

/** Draw one frame of the scene into a canvas of any size. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frameInput: number,
  state: SceneState,
): void {
  const { look } = state;
  const accent = state.accent ?? look.accent;
  const stagger = state.stagger ?? look.stagger;
  const out = state.fixed ? OUT_FRAME.fixed : OUT_FRAME.open;
  // At rest (no keyframes yet) every layer sits where its animation would land.
  const frame = state.animated ? frameInput : 100;
  const outAt = state.animated ? out : Number.POSITIVE_INFINITY;
  const visible = (layer: SceneLayer) => SCENE_LAYERS.indexOf(layer) < state.layers;

  const k = width / SCENE.width;
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = look.bg;
  ctx.fillRect(0, 0, SCENE.width, height / k);
  ctx.textBaseline = "alphabetic";

  // mark
  if (visible("mark")) {
    MARK_PIECES.forEach((d, i) => {
      const path = new Path2D(d);
      const start = 6 + i * stagger;
      const draw = (f: number, alpha: number) => {
        const pose = poseAt(f, start, outAt, look, "x");
        if (pose.opacity * alpha <= 0.004) return pose;
        ctx.save();
        ctx.globalAlpha = pose.opacity * alpha;
        ctx.translate(MARK.x + pose.dx, MARK.y);
        ctx.scale(MARK.scale, MARK.scale);
        ctx.fillStyle = accent;
        ctx.fill(path);
        ctx.restore();
        return pose;
      };
      const now = poseAt(frame, start, outAt, look, "x");
      if (state.echoes && state.animated) {
        for (let e = ECHO_COUNT; e >= 1; e--) {
          const past = poseAt(frame - e * ECHO_STEP, start, outAt, look, "x");
          if (Math.abs(past.dx - now.dx) > 3) draw(frame - e * ECHO_STEP, 0.34 * 0.72 ** e);
        }
      }
      draw(frame, 1);
    });
  }

  // title
  const title = layoutTitle(ctx, look, state.title);
  const lineHeight = title.size * 1.06;
  const firstBaseline = 430 + title.size;
  const lastBaseline = firstBaseline + (title.lines.length - 1) * lineHeight;
  let titleRight = LEFT;
  if (visible("title")) {
    ctx.font = fontOf(look, title.size);
    const space = ctx.measureText(" ").width;
    let index = 0;
    title.lines.forEach((line, row) => {
      let x = LEFT;
      for (const word of line) {
        const pose = poseAt(frame, 30 + index * stagger, outAt, look, "y");
        ctx.globalAlpha = pose.opacity;
        ctx.fillStyle = look.text;
        ctx.fillText(word, x + pose.dx, firstBaseline + row * lineHeight + pose.dy);
        x += ctx.measureText(word).width + space;
        index++;
      }
      titleRight = Math.max(titleRight, x - space);
    });
  }
  const wordCount = title.lines.reduce((n, line) => n + line.length, 0);

  // rule
  const ruleStart = 30 + wordCount * stagger + 4;
  if (visible("rule")) {
    const pose = poseAt(frame, ruleStart, outAt, look, "x");
    ctx.globalAlpha = pose.opacity;
    ctx.fillStyle = accent;
    ctx.fillRect(LEFT + Math.min(pose.dx, 0), lastBaseline + 58, 220 * pose.grow, 12);
  }

  // caption
  const captionBaseline = state.fixed ? CAPTION_BASELINE.fixed : CAPTION_BASELINE.open;
  ctx.font = fontOf({ ...look, wide: false }, 36, look.upper ? 700 : 500);
  const caption = look.upper ? state.caption.toUpperCase() : state.caption;
  const captionWidth = ctx.measureText(caption).width;
  if (visible("caption")) {
    const pose = poseAt(frame, ruleStart + 8, outAt, { ...look, travel: 0 }, "y");
    ctx.globalAlpha = pose.opacity;
    ctx.fillStyle = look.muted;
    ctx.fillText(caption, LEFT + pose.dx, captionBaseline);
  }

  ctx.globalAlpha = 1;
  if (state.guides) {
    const mx = SCENE.width * SAFE_MARGIN;
    const my = SCENE.height * SAFE_MARGIN;
    ctx.lineWidth = 2 / Math.max(k, 0.25);
    ctx.setLineDash([14, 12]);
    ctx.strokeStyle = "rgba(142, 193, 255, 0.55)";
    ctx.strokeRect(mx, my, SCENE.width - mx * 2, SCENE.height - my * 2);
    ctx.setLineDash([]);
  }
  if (state.highlight === "title" || state.highlight === "caption") {
    const box =
      state.highlight === "title"
        ? [
            LEFT - 24,
            firstBaseline - title.size,
            titleRight - LEFT + 48,
            lastBaseline - firstBaseline + title.size * 1.3,
          ]
        : [LEFT - 20, captionBaseline - 44, captionWidth + 40, 62];
    ctx.lineWidth = 3 / Math.max(k, 0.25);
    ctx.strokeStyle = state.fixed ? "#8dc48a" : "#ef6a4c";
    ctx.strokeRect(box[0] as number, box[1] as number, box[2] as number, box[3] as number);
  }
  ctx.restore();
}

export function timecode(frame: number): string {
  const f = Math.max(0, Math.round(frame));
  const s = Math.floor(f / SCENE.fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `00:${pad(s)}:${pad(f % SCENE.fps)}`;
}
