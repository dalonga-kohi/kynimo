import { numberPattern } from "./numbers.js";

export type Axis = "x" | "y" | "r";

export interface Viewport {
  width: number;
  height: number;
}

export interface ParsedLength {
  value: number;
  /** An `em` or `ex` length, converted with a fixed font size. */
  relative: boolean;
}

const PX: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

/** `em` and `ex` are converted at a fixed 16 px font size (no text layout here). */
const EM = 16;
const EX = 8;

/**
 * Parses an SVG length to px. Percentages resolve against the viewBox: width for `x`, height
 * for `y`, sqrt((w² + h²) / 2) for `r`. `undefined` when it is not a length.
 */
export function parseLength(
  input: string,
  axis: Axis,
  viewport: Viewport,
): ParsedLength | undefined {
  const s = input.trim();
  const re = numberPattern();
  const m = re.exec(s);
  if (m === null) return undefined;
  const unit = s.slice(re.lastIndex).trim().toLowerCase();
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return undefined;
  if (unit === "%") {
    const base =
      axis === "x"
        ? viewport.width
        : axis === "y"
          ? viewport.height
          : Math.sqrt((viewport.width ** 2 + viewport.height ** 2) / 2);
    return { value: (n / 100) * base, relative: false };
  }
  if (unit === "em") return { value: n * EM, relative: true };
  if (unit === "ex") return { value: n * EX, relative: true };
  const factor = PX[unit];
  if (factor === undefined) return undefined;
  return { value: n * factor, relative: false };
}
