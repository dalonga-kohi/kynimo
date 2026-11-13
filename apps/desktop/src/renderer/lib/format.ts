import type { AnimationSummary } from "../../shared/api.js";

const pad2 = (n: number): string => String(Math.max(0, Math.trunc(n))).padStart(2, "0");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `MM:SS:FF` for a position in seconds: the frame at `fps` that position falls in, rounded down. */
export function formatTimecode(seconds: number, fps: number): string {
  const rate = fps > 0 ? fps : 30;
  const nominal = Math.max(1, Math.round(rate));
  // The epsilon keeps 4.4 s at 30 fps on frame 132 despite float error.
  const frame = Math.max(0, Math.floor(Math.max(0, seconds) * rate + 1e-6));
  const whole = Math.floor(frame / nominal);
  return `${pad2(Math.floor(whole / 60))}:${pad2(whole % 60)}:${pad2(frame % nominal)}`;
}

/** `HH:MM:SS` for a span in milliseconds. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`;
}

/** `MM:SS`, as on a card. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** The total of the durations: `1m 04s`, or `12s` under a minute. */
export function formatTotal(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${pad2(total % 60)}s`;
}

/** `6 scenes · 1m 04s`. */
export function sceneCount(animations: readonly AnimationSummary[]): string {
  const n = animations.length;
  const total = animations.reduce((sum, a) => sum + a.durationSec, 0);
  return `${n} ${n === 1 ? "scene" : "scenes"} · ${formatTotal(total)}`;
}

/** English, no locale APIs: "just now", "5 min ago", "2 hours ago", "yesterday", "Nov 11". */
export function relativeTime(at: number | undefined, now: number): string | undefined {
  if (at === undefined || !Number.isFinite(at)) return undefined;
  const diff = now - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (diff < 172_800_000) return "yesterday";
  const date = new Date(at);
  return `${MONTHS[date.getMonth()] ?? ""} ${date.getDate()}`;
}

/** "Codex · 2 hours ago"; unknown parts are left out. */
export function metaLine(
  createdBy: string | undefined,
  updatedAt: number | undefined,
  now: number,
): string {
  return [createdBy, relativeTime(updatedAt, now)]
    .filter((p) => p !== undefined && p !== "")
    .join(" · ");
}

export type SortOrder = "latest" | "oldest" | "name";

export const SORT_LABELS: Record<SortOrder, string> = {
  latest: "Latest first",
  oldest: "Oldest first",
  name: "Name A–Z",
};

const byName = (a: AnimationSummary, b: AnimationSummary): number => {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** A sorted copy. Animations with no known update time go last in both time orders. */
export function sortAnimations(
  animations: readonly AnimationSummary[],
  order: SortOrder,
): AnimationSummary[] {
  const list = [...animations];
  if (order === "name") return list.sort(byName);
  const sign = order === "latest" ? -1 : 1;
  return list.sort((a, b) => {
    if (a.updatedAt === undefined && b.updatedAt === undefined) return byName(a, b);
    if (a.updatedAt === undefined) return 1;
    if (b.updatedAt === undefined) return -1;
    return sign * (a.updatedAt - b.updatedAt) || byName(a, b);
  });
}

/** The dot colors of the design: blue, purple, and two reds. */
export const PACK_COLORS = ["#2997ff", "#6c47ff", "#b3261e", "#ff2a00"] as const;

/** A stable color for a style pack (FNV-1a of its id); no style gets the faint text color. */
export function packColor(packId: string | undefined): string {
  if (packId === undefined || packId === "") return "var(--color-text-faint)";
  let hash = 0x811c9dc5;
  for (let i = 0; i < packId.length; i++) {
    hash ^= packId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PACK_COLORS[hash % PACK_COLORS.length] ?? PACK_COLORS[0];
}

/** "editorial-dark" gives "Editorial Dark"; no style gives "None". */
export function prettyPack(packId: string | undefined): string {
  const words = (packId ?? "").split(/[-_]+/).filter((w) => w !== "");
  if (words.length === 0) return "None";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** "12 s", "7.5 s". */
export function lengthLabel(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} s`;
}

/** "1920×1080 · 30 fps". */
export function sizeLabel(width: number, height: number, fps: number): string {
  return `${width}×${height} · ${Number(fps.toFixed(2))} fps`;
}

/** "Rendering frames · 62%". */
export function renderingLabel(progress: number): string {
  return `Rendering frames · ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}
