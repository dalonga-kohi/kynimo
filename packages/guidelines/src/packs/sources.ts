/**
 * Where thresholds and token values come from. A rule cites these by id. `kynimo-judgment`
 * marks a value we chose ourselves and still have to prove on the brief suite (ADR-0037).
 */
export const SOURCES = {
  wcagContrast: {
    id: "wcag-contrast",
    title: "WCAG 2.2, Success Criterion 1.4.3 Contrast (Minimum): 4.5:1, or 3:1 for large text",
    url: "https://www.w3.org/TR/WCAG22/#contrast-minimum",
  },
  wcagFlash: {
    id: "wcag-flash",
    title: "WCAG 2.2, Success Criterion 2.3.1 Three Flashes or Below Threshold",
    url: "https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold",
  },
  ebuSafeArea: {
    id: "ebu-r95",
    title:
      "EBU R 95, Safe areas for 16:9 television production: action safe 93 %, graphics safe 90 %",
    url: "https://tech.ebu.ch/publications/r095",
  },
  bbcSubtitles: {
    id: "bbc-subtitles",
    title: "BBC Subtitle Guidelines: reading rate of 160–180 words per minute",
    url: "https://www.bbc.co.uk/accessibility/forproducts/guides/subtitles/",
  },
  material: {
    id: "material-motion",
    title: "Material Design 3, Motion: easing and duration tokens",
    url: "https://m3.material.io/styles/motion/easing-and-duration/tokens-specs",
  },
  carbon: {
    id: "carbon-motion",
    title: "IBM Carbon Design System, Motion: productive and expressive curves",
    url: "https://carbondesignsystem.com/elements/motion/overview/",
  },
  appleSprings: {
    id: "apple-springs",
    title: "Apple, WWDC 2023 “Animate with springs”: springs as damping (bounce) and response",
    url: "https://developer.apple.com/videos/play/wwdc2023/10158/",
  },
  illusionOfLife: {
    id: "illusion-of-life",
    title:
      "Thomas & Johnston, The Illusion of Life (1981): staging, slow in and slow out, follow through",
  },
  judgment: {
    id: "kynimo-judgment",
    title: "Kynimo's own choice, not yet measured against reference videos",
  },
} as const;

export const ALL_SOURCES = Object.values(SOURCES);
