import type { GuidelinePack } from "../pack.js";
import { ALL_SOURCES, SOURCES as S } from "./sources.js";

const type = (weight: number, size: number, tracking: number, leading: number) =>
  ({ family: "Inter", weight, size, tracking, leading, case: "none" }) as const;

/** Energetic UI-promo look: light background, bright accents, quick staggers, springs that bounce. */
export const playfulSaas: GuidelinePack = {
  formatVersion: 1,
  id: "playful-saas",
  version: "0.1.0",
  name: "Playful SaaS",
  personality: {
    summary:
      "Friendly and energetic, like a good app promo. Light background, rounded shapes, bright accents, quick staggers and springs that bounce once.",
    useFor: ["app and SaaS promos", "feature tours", "social clips", "onboarding explainers"],
    do: [
      "Pop elements in with the bouncy spring from the enter scale; follow with a tight stagger.",
      "Let related elements overlap in time so the scene feels busy but grouped.",
      "Use both accents, and rounded cards on the surface color.",
      "Keep scenes short; cut on the beat when there is music.",
    ],
    avoid: [
      "Bouncing text that has to be read: bounce the container, settle the words.",
      "Long, slow fades.",
      "More than one bounce per element.",
    ],
  },
  color: {
    background: "#fffaf2",
    surface: "#ffffff",
    text: "#1b1437",
    textMuted: "#5d5676",
    accent: "#6c47ff",
    accentAlt: "#e8336f",
  },
  type: {
    display: type(800, 144, -30, 1.02),
    headline: type(800, 92, -25, 1.06),
    title: type(700, 56, -15, 1.15),
    body: type(500, 36, 0, 1.35),
    caption: type(500, 28, 0, 1.3),
    label: type(700, 24, 10, 1.2),
  },
  layout: {
    margin: 0.08,
    columns: 12,
    gutter: 24,
    spacing: { xs: 8, s: 16, m: 24, l: 48, xl: 96 },
    cornerRadius: 32,
  },
  motion: {
    durations: { instant: 80, fast: 180, base: 350, slow: 550, slower: 800 },
    easings: {
      enter: { type: "bezier", x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 },
      exit: { type: "bezier", x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 },
      move: { type: "bezier", x1: 0.2, y1: 0, x2: 0, y2: 1 },
      emphasis: { type: "bezier", x1: 0.68, y1: -0.6, x2: 0.32, y2: 1.6 },
    },
    springs: {
      gentle: { damping: 0.8, response: 0.5 },
      snappy: { damping: 0.7, response: 0.32 },
      bouncy: { damping: 0.5, response: 0.45 },
    },
    stagger: { tight: 35, base: 65, loose: 110 },
    distance: { small: 24, base: 64, large: 160 },
    enterScale: 0.8,
  },
  rules: {
    "readable-hold": {
      severity: "error",
      sources: [S.bbcSubtitles.id, S.judgment.id],
      wordsPerSecond: 3,
      minHoldMs: 800,
    },
    "concurrent-motion": {
      severity: "warning",
      sources: [S.illusionOfLife.id, S.judgment.id],
      max: 5,
      windowMs: 150,
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
    "token-easing": { severity: "warning", sources: [S.appleSprings.id, S.judgment.id] },
    "token-color": { severity: "warning", sources: [S.judgment.id] },
    "entrance-duration": {
      severity: "warning",
      sources: [S.material.id, S.judgment.id],
      minMs: 150,
      maxMs: 800,
    },
    "flash-rate": { severity: "error", sources: [S.wcagFlash.id], maxPerSecond: 3 },
    "font-variety": { severity: "warning", sources: [S.judgment.id], max: 1, maxWeights: 3 },
  },
  sources: [...ALL_SOURCES],
};
