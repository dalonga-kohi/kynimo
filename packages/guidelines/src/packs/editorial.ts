import type { GuidelinePack } from "../pack.js";
import { ALL_SOURCES, SOURCES as S } from "./sources.js";

const type = (weight: number, size: number, tracking: number, leading: number) =>
  ({ family: "Inter", weight, size, tracking, leading, case: "none" }) as const;

/** Magazine look: paper background, strong weight contrast, strict grid, slow reveals. */
export const editorial: GuidelinePack = {
  formatVersion: 1,
  id: "editorial",
  version: "0.1.0",
  name: "Editorial",
  personality: {
    summary:
      "Measured and literate, like a magazine spread in motion. Paper background, light display type against heavy labels, a strict grid, slow fades and mask reveals.",
    useFor: ["explainers", "quotes and statements", "reports and data stories", "brand films"],
    do: [
      "Reveal text line by line with masks or slow fades on the slow duration.",
      "Align everything to the grid columns; leave generous empty space.",
      "Set small uppercase labels above large light headlines.",
      "Use the accent sparingly: a rule, a number, one word.",
    ],
    avoid: [
      "Springs that overshoot, scale pops and rotation.",
      "Elements entering from different directions in one scene.",
      "Fast cuts: let each spread breathe.",
    ],
  },
  color: {
    background: "#f4f1ea",
    surface: "#ebe6db",
    text: "#1a1a1a",
    textMuted: "#5f5a52",
    accent: "#b3261e",
    accentAlt: "#1f3a5f",
  },
  type: {
    display: type(300, 176, -40, 1),
    headline: type(300, 108, -30, 1.05),
    title: type(500, 56, -10, 1.2),
    body: type(400, 36, 0, 1.5),
    caption: type(400, 28, 5, 1.4),
    label: { ...type(700, 24, 140, 1.2), case: "upper" },
  },
  layout: {
    margin: 0.09,
    columns: 6,
    gutter: 32,
    spacing: { xs: 8, s: 16, m: 40, l: 80, xl: 160 },
    cornerRadius: 0,
  },
  motion: {
    durations: { instant: 120, fast: 400, base: 800, slow: 1200, slower: 1800 },
    easings: {
      enter: { type: "bezier", x1: 0, y1: 0, x2: 0.3, y2: 1 },
      exit: { type: "bezier", x1: 0.4, y1: 0.14, x2: 1, y2: 1 },
      move: { type: "bezier", x1: 0.4, y1: 0.14, x2: 0.3, y2: 1 },
      emphasis: { type: "bezier", x1: 0.45, y1: 0, x2: 0.15, y2: 1 },
    },
    springs: {
      gentle: { damping: 1, response: 0.9 },
      snappy: { damping: 1, response: 0.5 },
      bouncy: { damping: 1, response: 0.7 },
    },
    stagger: { tight: 80, base: 140, loose: 240 },
    distance: { small: 12, base: 28, large: 64 },
    enterScale: 1,
  },
  rules: {
    "readable-hold": {
      severity: "error",
      sources: [S.bbcSubtitles.id, S.judgment.id],
      wordsPerSecond: 2.5,
      minHoldMs: 1500,
    },
    "concurrent-motion": {
      severity: "warning",
      sources: [S.illusionOfLife.id, S.judgment.id],
      max: 2,
      windowMs: 250,
    },
    "text-contrast": {
      severity: "error",
      sources: [S.wcagContrast.id],
      minRatio: 4.5,
      minRatioLarge: 3,
      largeSize: 48,
    },
    "safe-area": { severity: "error", sources: [S.ebuSafeArea.id], text: 0.9, action: 0.93 },
    "min-text-size": { severity: "error", sources: [S.judgment.id], minSize: 24 },
    "token-easing": { severity: "warning", sources: [S.carbon.id] },
    "token-color": { severity: "warning", sources: [S.judgment.id] },
    "entrance-duration": {
      severity: "warning",
      sources: [S.carbon.id, S.judgment.id],
      minMs: 400,
      maxMs: 1800,
    },
    "flash-rate": { severity: "error", sources: [S.wcagFlash.id], maxPerSecond: 3 },
    "font-variety": { severity: "warning", sources: [S.judgment.id], max: 1, maxWeights: 4 },
  },
  sources: [...ALL_SOURCES],
};
