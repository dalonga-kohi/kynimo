import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "../host/files.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1440, height: 900 } as const;
export const MIN_SIZE = { width: 1100, height: 720 } as const;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The saved window state made safe: sizes at least the minimum, and the position kept only when
 * the window would still be mostly on a display (a monitor may have been unplugged).
 */
export function sanitizeWindowState(raw: unknown, workAreas: readonly Rect[]): WindowState {
  const saved = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const width = finite(saved.width)
    ? Math.max(MIN_SIZE.width, Math.round(saved.width))
    : DEFAULT_SIZE.width;
  const height = finite(saved.height)
    ? Math.max(MIN_SIZE.height, Math.round(saved.height))
    : DEFAULT_SIZE.height;
  const state: WindowState = { width, height, maximized: saved.maximized === true };
  if (finite(saved.x) && finite(saved.y)) {
    const x = Math.round(saved.x);
    const y = Math.round(saved.y);
    // At least a 100 x 50 corner of the window on some display, so it can be grabbed.
    const reachable = workAreas.some(
      (area) =>
        Math.min(x + width, area.x + area.width) - Math.max(x, area.x) >= 100 &&
        Math.min(y + height, area.y + area.height) - Math.max(y, area.y) >= 50,
    );
    if (reachable) {
      state.x = x;
      state.y = y;
    }
  }
  return state;
}

export async function loadWindowState(
  file: string,
  workAreas: readonly Rect[],
): Promise<WindowState> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // Missing or unreadable: the defaults.
  }
  return sanitizeWindowState(raw, workAreas);
}

export const saveWindowState = (file: string, state: WindowState): Promise<void> =>
  atomicWriteJson(file, state);
