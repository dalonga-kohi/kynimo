/**
 * The demo scene the hero plays and scrubs.
 *
 * It is a small stand-in for the real engine, built on the same idea: a pure function of
 * (scene, frame) → pixels. No clock, no randomness, so the same frame always looks the same.
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

/** How the scene looks and moves: the page's own palette and a critically damped spring. */
export const LOOK = {
  bg: "#0c0b0a",
  text: "#ede8df",
  muted: "#a39c90",
  accent: "#f5c842",
  spring: { damping: 1, response: 0.7 },
  /** Frames between one element starting and the next. */
  stagger: 3,
  /** Pixels an element travels on entry, in scene units. */
  travel: 560,
} as const;

export interface SceneState {
  title: string;
  caption: string;
}

export const DEFAULT_TITLE = "Every frame, on purpose.";
export const DEFAULT_CAPTION = "Made over MCP";

/** Frame the layers start to leave. */
export const OUT_FRAME = 132;
const CAPTION_BASELINE = SCENE.height - 76;

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
  axis: "x" | "y",
  travel: number = LOOK.travel,
): Pose {
  const since = frame - start;
  const progress = springValue(since / SCENE.fps, LOOK.spring);
  let opacity = clamp01(since / 4);
  const distance = axis === "x" ? travel : travel * 0.18;
  let dx = axis === "x" ? (1 - progress) * distance : 0;
  const dy = axis === "y" ? (1 - progress) * distance : 0;

  const leaving = clamp01((frame - out) / 10);
  if (leaving > 0) {
    const eased = leaving * leaving;
    opacity *= 1 - eased;
    dx -= eased * 90;
  }
  return { dx, dy, opacity, grow: progress };
}

const fontOf = (size: number, weight = 800, wide = true) =>
  `${weight} ${wide ? "expanded " : ""}${size}px "Mona Sans Variable", system-ui, sans-serif`;

interface TitleLayout {
  size: number;
  lines: string[][];
}

/** Break the title into at most two lines, shrinking the type until it fits. */
function layoutTitle(ctx: CanvasRenderingContext2D, raw: string): TitleLayout {
  const text = raw.trim();
  const words = text.length > 0 ? text.split(/\s+/) : [];
  for (let size = 150; size >= 64; size -= 8) {
    ctx.font = fontOf(size);
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
  frame: number,
  state: SceneState,
): void {
  const { stagger } = LOOK;
  const k = width / SCENE.width;
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = LOOK.bg;
  ctx.fillRect(0, 0, SCENE.width, height / k);
  ctx.textBaseline = "alphabetic";

  // mark, with stroboscopic echoes behind each moving piece
  MARK_PIECES.forEach((d, i) => {
    const path = new Path2D(d);
    const start = 6 + i * stagger;
    const draw = (f: number, alpha: number) => {
      const pose = poseAt(f, start, OUT_FRAME, "x");
      if (pose.opacity * alpha <= 0.004) return;
      ctx.save();
      ctx.globalAlpha = pose.opacity * alpha;
      ctx.translate(MARK.x + pose.dx, MARK.y);
      ctx.scale(MARK.scale, MARK.scale);
      ctx.fillStyle = LOOK.accent;
      ctx.fill(path);
      ctx.restore();
    };
    const now = poseAt(frame, start, OUT_FRAME, "x");
    for (let e = ECHO_COUNT; e >= 1; e--) {
      const past = poseAt(frame - e * ECHO_STEP, start, OUT_FRAME, "x");
      if (Math.abs(past.dx - now.dx) > 3) draw(frame - e * ECHO_STEP, 0.34 * 0.72 ** e);
    }
    draw(frame, 1);
  });

  // title
  const title = layoutTitle(ctx, state.title);
  const lineHeight = title.size * 1.06;
  const firstBaseline = 430 + title.size;
  const lastBaseline = firstBaseline + (title.lines.length - 1) * lineHeight;
  ctx.font = fontOf(title.size);
  const space = ctx.measureText(" ").width;
  let index = 0;
  title.lines.forEach((line, row) => {
    let x = LEFT;
    for (const word of line) {
      const pose = poseAt(frame, 30 + index * stagger, OUT_FRAME, "y");
      ctx.globalAlpha = pose.opacity;
      ctx.fillStyle = LOOK.text;
      ctx.fillText(word, x + pose.dx, firstBaseline + row * lineHeight + pose.dy);
      x += ctx.measureText(word).width + space;
      index++;
    }
  });

  // rule
  const ruleStart = 30 + index * stagger + 4;
  const rule = poseAt(frame, ruleStart, OUT_FRAME, "x");
  ctx.globalAlpha = rule.opacity;
  ctx.fillStyle = LOOK.accent;
  ctx.fillRect(LEFT + Math.min(rule.dx, 0), lastBaseline + 58, 220 * rule.grow, 12);

  // caption
  ctx.font = fontOf(36, 500, false);
  const caption = poseAt(frame, ruleStart + 8, OUT_FRAME, "y", 0);
  ctx.globalAlpha = caption.opacity;
  ctx.fillStyle = LOOK.muted;
  ctx.fillText(state.caption, LEFT + caption.dx, CAPTION_BASELINE);

  ctx.globalAlpha = 1;
  ctx.restore();
}

export function timecode(frame: number): string {
  const f = Math.max(0, Math.round(frame));
  const s = Math.floor(f / SCENE.fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `00:${pad(s)}:${pad(f % SCENE.fps)}`;
}
