import type { GuidelinePack } from "../pack.js";
import { ALL_SOURCES, SOURCES as S } from "./sources.js";

const type = (weight: number, size: number, tracking: number, leading: number) =>
  ({ family: "Inter", weight, size, tracking, leading, case: "none" }) as const;

/** Calm, confident product-launch look: one idea on screen, long holds, springs without bounce. */
export const keynote: GuidelinePack = {
  formatVersion: 1,
  id: "keynote",
  version: "0.1.0",
  name: "Keynote",
  personality: {
    summary:
      "Calm and confident, like a product launch on a dark stage. One idea on screen at a time, very large type, long holds, motion that settles without bouncing.",
    useFor: ["product launches", "feature reveals", "hero statements", "premium hardware or apps"],
    do: [
      "Give each scene one message and let it hold before the next arrives.",
      "Bring elements in with the gentle spring or the enter easing over the base or slow duration.",
      "Move the camera or background slowly and continuously while text holds still.",
      "Use the accent for one word or one graphic per scene.",
    ],
    avoid: [
      "Bounce or overshoot.",
      "More than two elements entering together.",
      "Small text: if it needs body size or less, cut the words instead.",
    ],
  },
  color: {
    background: "#000000",
    surface: "#1d1d1f",
    text: "#f5f5f7",
    textMuted: "#b0b0b5",
    accent: "#2997ff",
    accentAlt: "#bf5af2",
  },
  type: {
    display: type(700, 168, -30, 1.02),
    headline: type(600, 104, -25, 1.06),
    title: type(600, 60, -15, 1.12),
    body: type(400, 38, -5, 1.35),
    caption: type(500, 28, 0, 1.3),
    label: { ...type(600, 24, 80, 1.2), case: "upper" },
  },
  layout: {
    margin: 0.1,
    columns: 12,
    gutter: 24,
    spacing: { xs: 8, s: 16, m: 32, l: 64, xl: 128 },
    cornerRadius: 28,
  },
  motion: {
    durations: { instant: 100, fast: 300, base: 600, slow: 900, slower: 1400 },
    easings: {
      enter: { type: "bezier", x1: 0.05, y1: 0.7, x2: 0.1, y2: 1 },
      exit: { type: "bezier", x1: 0.3, y1: 0, x2: 0.8, y2: 0.15 },
      move: { type: "bezier", x1: 0.2, y1: 0, x2: 0, y2: 1 },
      emphasis: { type: "bezier", x1: 0.4, y1: 0.14, x2: 0.3, y2: 1 },
    },
    springs: {
      gentle: { damping: 1, response: 0.7 },
      snappy: { damping: 1, response: 0.4 },
      bouncy: { damping: 0.85, response: 0.55 },
    },
    stagger: { tight: 50, base: 100, loose: 180 },
    distance: { small: 16, base: 40, large: 96 },
    enterScale: 0.96,
  },
  rules: {
    "readable-hold": {
      severity: "error",
      sources: [S.bbcSubtitles.id, S.judgment.id],
      wordsPerSecond: 2.5,
      minHoldMs: 1200,
    },
    "concurrent-motion": {
      severity: "warning",
      sources: [S.illusionOfLife.id, S.judgment.id],
      max: 2,
      windowMs: 200,
    },
    "text-contrast": {
      severity: "error",
      sources: [S.wcagContrast.id],
      minRatio: 7,
      minRatioLarge: 4.5,
      largeSize: 48,
    },
    "safe-area": { severity: "error", sources: [S.ebuSafeArea.id], text: 0.9, action: 0.93 },
    "min-text-size": { severity: "error", sources: [S.judgment.id], minSize: 24 },
    "token-easing": { severity: "warning", sources: [S.material.id, S.carbon.id] },
    "token-color": { severity: "warning", sources: [S.judgment.id] },
    "entrance-duration": {
      severity: "warning",
      sources: [S.material.id, S.judgment.id],
      minMs: 300,
      maxMs: 1400,
    },
    "flash-rate": { severity: "error", sources: [S.wcagFlash.id], maxPerSecond: 3 },
    "font-variety": { severity: "warning", sources: [S.judgment.id], max: 1, maxWeights: 4 },
  },
  sources: [...ALL_SOURCES],
};
