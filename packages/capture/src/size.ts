/**
 * The output size of a `width × height` frame whose longest edge may be at most `maxSize`: the
 * same aspect, rounded to whole pixels and at least 1, never larger than the frame. Callers use it
 * to check a request's limits before rendering; the page uses it to downscale.
 */
export function fitSize(
  width: number,
  height: number,
  maxSize: number | null,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (maxSize === null || long <= maxSize) return { width, height };
  if (!Number.isInteger(maxSize) || maxSize < 1)
    throw new RangeError(`maxSize must be a positive integer (got ${maxSize})`);
  const scale = maxSize / long;
  return {
    width: width >= height ? maxSize : Math.max(1, Math.round(width * scale)),
    height: height > width ? maxSize : Math.max(1, Math.round(height * scale)),
  };
}

/** A contact sheet's layout: `count` cells of `cell` size in `columns`, `gap` pixels apart. */
export function sheetSize(
  cell: { width: number; height: number },
  count: number,
  columns: number,
  gap: number,
): { width: number; height: number; columns: number; rows: number } {
  const cols = Math.min(columns, count);
  const rows = Math.ceil(count / cols);
  return {
    width: cols * cell.width + (cols - 1) * gap,
    height: rows * cell.height + (rows - 1) * gap,
    columns: cols,
    rows,
  };
}
