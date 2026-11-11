/** Rounds to 6 significant digits and normalises -0, so output is compact and deterministic. */
export function round6(n: number): number {
  const r = Number(n.toPrecision(6));
  return r === 0 ? 0 : r;
}

/**
 * One SVG number. Unambiguous (each character can only be matched one way), so it never
 * backtracks catastrophically on hostile input. Every number regex in this package derives from it.
 */
export const NUMBER_SOURCE = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";

/** Sticky pattern for one SVG number; set `lastIndex` before use. */
export function numberPattern(): RegExp {
  return new RegExp(NUMBER_SOURCE, "y");
}

/** Whole string is one finite number. */
export function parseNumber(s: string): number | undefined {
  if (!new RegExp(`^${NUMBER_SOURCE}$`).test(s.trim())) return undefined;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** A comma and/or whitespace separated list of numbers, or `undefined` when anything else is in it. */
export function parseNumberList(s: string): number[] | undefined {
  const re = numberPattern();
  const out: number[] = [];
  let i = 0;
  const skip = (): void => {
    while (i < s.length && /[\s,]/.test(s[i] ?? "")) i++;
  };
  skip();
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m === null) return undefined;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) return undefined;
    out.push(n);
    i = re.lastIndex;
    skip();
  }
  return out;
}
