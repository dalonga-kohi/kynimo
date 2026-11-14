/**
 * The stage of the "what your agent does" section: one picture per step of the loop, each a
 * pure function of (step, t) → pixels, where t runs 0 → 1 over the time the step is shown.
 * Every picture is built from the hero's demo scene, so the six steps tell one story.
 */

import { DEFAULT_CAPTION, DEFAULT_TITLE, drawScene, LOOK, OUT_FRAME, SCENE } from "./scene";

export const LOOP_STEPS = 6;

/** What a screen reader hears for each step's picture. */
export const LOOP_LABELS = [
  "A brief typed in plain words: Make a five second launch teaser. Dark, with one yellow accent.",
  "The scene being built: a logo mark, a title, a rule and a caption arrive one layer at a time.",
  "A contact sheet of six rendered frames from the scene, first to last.",
  "A timeline of the motion: one bar per layer showing when it enters and when it leaves.",
  "One edit: the title changes to a new line while every other layer stays where it was.",
  "The export: a progress bar fills, then the finished file, launch-teaser.mp4.",
] as const;

const W = SCENE.width;
const H = SCENE.height;
const STATE = { title: DEFAULT_TITLE, caption: DEFAULT_CAPTION };
const EDITED = { title: "Every frame, by design.", caption: DEFAULT_CAPTION };
const BRIEF = "Make a five second launch teaser. Dark, with one yellow accent.";
/** The frame the scene rests on, everything in place. */
const REST = 100;
const SHEET_FRAMES = [8, 24, 38, 52, 76, 136] as const;
const TIMELINE = [
  { name: "mark", start: 6 },
  { name: "title", start: 30 },
  { name: "rule", start: 46 },
  { name: "caption", start: 54 },
] as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const span = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));
const easeOut = (t: number) => 1 - (1 - t) ** 3;

const sans = (weight: number, size: number, wide = false) =>
  `${weight} ${wide ? "expanded " : ""}${size}px "Mona Sans Variable", system-ui, sans-serif`;
const mono = (size: number) => `${size}px "Geist Mono Variable", ui-monospace, monospace`;

type Ctx = CanvasRenderingContext2D;

/** Something `drawImage` accepts and that hands out a 2D context: a spare canvas for thumbnails. */
export interface Scratch {
  width: number;
  height: number;
  getContext(kind: "2d"): Ctx | null;
}

/** Break `text` into lines no wider than `max`, by words. */
function wrap(ctx: Ctx, text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function brief(ctx: Ctx, t: number) {
  const shown = BRIEF.slice(0, Math.round(span(t, 0.04, 0.62) * BRIEF.length));
  ctx.font = sans(600, 104);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = LOOK.text;
  const lines = wrap(ctx, BRIEF, 1500);
  let left = shown.length;
  let caretX = 210;
  let caretY = 360;
  lines.forEach((line, i) => {
    const part = line.slice(0, Math.max(0, left));
    left -= line.length + 1;
    const y = 360 + i * 138;
    if (part.length > 0 || i === 0) {
      ctx.fillText(part, 210, y);
      caretX = 210 + ctx.measureText(part).width + 10;
      caretY = y;
    }
  });
  // The caret blinks on a fixed rhythm derived from t, not from a clock.
  if (Math.floor(t * 12) % 2 === 0 || shown.length < BRIEF.length) {
    ctx.fillStyle = LOOK.accent;
    ctx.fillRect(caretX, caretY - 92, 8, 112);
  }
}

function build(ctx: Ctx, width: number, height: number, t: number) {
  drawScene(ctx, width, height, 2 + span(t, 0, 0.8) * (REST - 2), STATE);
}

function look(ctx: Ctx, t: number, scratch: Scratch | null) {
  const cols = 3;
  const gap = 36;
  const tw = (W - 2 * 150 - (cols - 1) * gap) / cols;
  const th = (tw * H) / W;
  const top = (H - 2 * th - gap) / 2;
  SHEET_FRAMES.forEach((frame, i) => {
    const p = easeOut(span(t, 0.04 + i * 0.09, 0.3 + i * 0.09));
    if (p <= 0) return;
    const x = 150 + (i % cols) * (tw + gap);
    const y = top + Math.floor(i / cols) * (th + gap) + (1 - p) * 30;
    ctx.globalAlpha = p;
    const inner = scratch?.getContext("2d");
    if (scratch && inner) {
      drawScene(inner, scratch.width, scratch.height, frame, STATE);
      ctx.drawImage(scratch as unknown as CanvasImageSource, x, y, tw, th);
    }
    ctx.strokeStyle = "#3d3832";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, tw, th);
  });
  ctx.globalAlpha = 1;
}

function check(ctx: Ctx, t: number) {
  const left = 470;
  const right = W - 210;
  const lane = right - left;
  const rowH = 132;
  const top = (H - TIMELINE.length * rowH) / 2 + 20;
  ctx.textBaseline = "middle";
  TIMELINE.forEach((row, i) => {
    const y = top + i * rowH;
    const p = easeOut(span(t, 0.05 + i * 0.1, 0.45 + i * 0.1));
    ctx.globalAlpha = clamp01(p * 3);
    ctx.fillStyle = LOOK.muted;
    ctx.font = mono(40);
    ctx.fillText(row.name, 210, y);
    ctx.fillStyle = "#2e2a26";
    ctx.fillRect(left, y - 2, lane, 4);
    const from = left + (row.start / SCENE.frames) * lane;
    const to = left + (OUT_FRAME / SCENE.frames) * lane;
    ctx.fillStyle = "#3d3832";
    ctx.fillRect(from, y - 16, (to - from) * p, 32);
    // The spring settling: the first 0.7 s of each bar is the move itself.
    ctx.fillStyle = LOOK.accent;
    ctx.fillRect(from, y - 16, Math.min((to - from) * p, (21 / SCENE.frames) * lane), 32);
  });
  ctx.globalAlpha = span(t, 0.5, 0.7);
  ctx.fillStyle = LOOK.muted;
  ctx.font = mono(34);
  ctx.fillText("enters on a spring, 0.7 s", left, top + TIMELINE.length * rowH - 10);
  ctx.textAlign = "right";
  ctx.fillText("5 s", right, top + TIMELINE.length * rowH - 10);
  ctx.textAlign = "left";
  ctx.globalAlpha = 1;
}

function fix(ctx: Ctx, width: number, height: number, t: number) {
  drawScene(ctx, width, height, REST, t < 0.42 ? STATE : EDITED);
  // A frame around the one layer that changed, bright at the moment of the edit.
  const flash = t < 0.42 ? span(t, 0.12, 0.3) : 1 - span(t, 0.6, 0.95);
  ctx.globalAlpha = clamp01(flash);
  ctx.strokeStyle = LOOK.accent;
  ctx.lineWidth = 5;
  ctx.strokeRect(124, 452, 1672, 330);
  ctx.fillStyle = LOOK.accent;
  ctx.font = mono(34);
  ctx.textBaseline = "alphabetic";
  ctx.fillText("title", 124, 434);
  ctx.globalAlpha = 1;
}

function exportStep(ctx: Ctx, width: number, height: number, t: number) {
  drawScene(ctx, width, height, REST, STATE);
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = LOOK.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
  const done = easeOut(span(t, 0.05, 0.6));
  const x = 460;
  const w = W - 2 * x;
  ctx.fillStyle = "#2e2a26";
  ctx.fillRect(x, 560, w, 10);
  ctx.fillStyle = LOOK.accent;
  ctx.fillRect(x, 560, w * done, 10);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = LOOK.text;
  ctx.font = sans(800, 92, true);
  ctx.fillText("launch-teaser.mp4", x, 500);
  ctx.fillStyle = LOOK.muted;
  ctx.font = mono(36);
  ctx.fillText("1920 × 1080 · 30 fps · 5 s", x, 640);
  ctx.textAlign = "right";
  ctx.fillStyle = done >= 1 ? LOOK.accent : LOOK.muted;
  ctx.fillText(done >= 1 ? "saved" : `${Math.round(done * 100)}%`, x + w, 640);
  ctx.textAlign = "left";
}

/**
 * Draw step `step` (0 to 5) at time `t` (0 to 1) into a canvas of any size. `scratch` is a
 * spare canvas the contact sheet draws its thumbnails through; without one it draws frames only.
 */
export function drawLoop(
  ctx: Ctx,
  width: number,
  height: number,
  step: number,
  t: number,
  scratch: Scratch | null = null,
): void {
  const k = width / W;
  const time = clamp01(t);
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = LOOK.bg;
  ctx.fillRect(0, 0, W, height / k);
  ctx.restore();

  // The scene draws itself with its own transform; the overlays share the 1920 × 1080 space.
  if (step === 1) build(ctx, width, height, time);
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  if (step === 0) brief(ctx, time);
  else if (step === 2) look(ctx, time, scratch);
  else if (step === 3) check(ctx, time);
  ctx.restore();
  if (step === 4 || step === 5) {
    // drawScene resets the transform, so these two set it again for their overlays.
    const overlay = step === 4 ? fix : exportStep;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    overlay(ctx, width, height, time);
    ctx.restore();
  }
}
