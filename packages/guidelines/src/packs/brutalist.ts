import type { GuidelinePack } from "../pack.js";
import { ALL_SOURCES, SOURCES as S } from "./sources.js";

const type = (weight: number, size: number, tracking: number, leading: number) =>
  ({ family: "Inter", weight, size, tracking, leading, textCase: "upper" }) as const;

/** Hard cuts and heavy uppercase type: nothing eases, things appear, jump and stop. */
export const brutalist: GuidelinePack = {
  formatVersion: 1,
  id: "brutalist",
  version: "0.1.0",
  name: "Brutalist",
  personality: {
    summary:
      "Loud and blunt. Black on white with one hot accent, heavy uppercase type filling the frame, hard cuts and linear moves. Nothing eases in; things appear and stop.",
    useFor: [
      "announcements and drops",
      "event and music promos",
      "bold social clips",
      "manifestos",
    ],
    do: [
      "Cut elements in with the enter easing (a hold) and move them with linear motion.",
      "Fill the frame: display type edge to edge inside the text-safe area.",
      "Use solid blocks of the accent and of black as layout, and hard-edged wipes.",
      "Time cuts to the beat when there is music.",
    ],
    avoid: [
      "Soft fades, blur, glow and shadows.",
      "Rounded corners and gradients.",
      "Cuts faster than the flash limit over large areas.",
    ],
  },
  color: {
    background: "#ffffff",
    surface: "#e6e6e6",
    text: "#000000",
    textMuted: "#3d3d3d",
    accent: "#ff2a00",
    accentAlt: "#0033ff",
  },
  type: {
    display: type(900, 220, -40, 0.9),
    headline: type(900, 128, -30, 0.95),
    title: type(900, 64, -10, 1.05),
    body: { ...type(500, 36, 0, 1.3), textCase: "none" },
    caption: type(500, 28, 40, 1.25),
    label: type(900, 26, 60, 1.1),
  },
  layout: {
    margin: 0.05,
    columns: 4,
    gutter: 0,
    spacing: { xs: 4, s: 12, m: 24, l: 48, xl: 120 },
    cornerRadius: 0,
  },
  motion: {
    durations: { instant: 34, fast: 100, base: 200, slow: 400, slower: 700 },
    easings: {
      enter: { type: "hold" },
      exit: { type: "hold" },
      move: { type: "linear" },
      emphasis: { type: "bezier", x1: 0.9, y1: 0, x2: 1, y2: 0.1 },
    },
    springs: {
      gentle: { damping: 1.4, response: 0.3 },
      snappy: { damping: 1.2, response: 0.18 },
      bouncy: { damping: 1, response: 0.22 },
    },
    stagger: { tight: 34, base: 67, loose: 134 },
    distance: { small: 40, base: 120, large: 400 },
    enterScale: 1,
  },
  rules: {
    "readable-hold": {
      severity: "error",
      sources: [S.bbcSubtitles.id, S.judgment.id],
      wordsPerSecond: 3,
      minHoldMs: 600,
    },
    "concurrent-motion": {
      severity: "warning",
      sources: [S.illusionOfLife.id, S.judgment.id],
      max: 3,
      windowMs: 100,
    },
    "text-contrast": {
      severity: "error",
      sources: [S.wcagContrast.id],
      minRatio: 7,
      minRatioLarge: 3,
      largeSize: 48,
    },
    "safe-area": { severity: "error", sources: [S.ebuSafeArea.id], text: 0.9, action: 0.93 },
    "min-text-size": { severity: "error", sources: [S.judgment.id], minSize: 26 },
    "token-easing": { severity: "error", sources: [S.judgment.id] },
    "token-color": { severity: "error", sources: [S.judgment.id] },
    "entrance-duration": {
      severity: "warning",
      sources: [S.judgment.id],
      minMs: 0,
      maxMs: 400,
    },
    "flash-rate": { severity: "error", sources: [S.wcagFlash.id], maxPerSecond: 3 },
    "font-variety": {
      severity: "warning",
      sources: [S.judgment.id],
      maxFamilies: 1,
      maxWeights: 2,
    },
  },
  sources: [...ALL_SOURCES],
};
