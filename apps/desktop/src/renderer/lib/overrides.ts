import type { ReactNode } from "react";

/**
 * Hooks the browser mock fills in; the Electron app never sets them. They let the mock show the
 * design's artwork where the app shows rendered thumbnails and video.
 */
export interface Overrides {
  /** Artwork shown instead of a thumbnail image (`thumb`) or the video frame (`player`). */
  artwork?: (id: string, kind: "thumb" | "player") => ReactNode | undefined;
  /** The Player's starting state when there is no video to read it from. */
  player?: { time: number; playing: boolean; selectedLayer?: string };
}

let current: Overrides = {};

export const overrides = (): Overrides => current;

export function setOverrides(next: Overrides): void {
  current = next;
}
