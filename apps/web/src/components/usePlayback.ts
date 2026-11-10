"use client";

import { useInView } from "motion/react";
import { type RefObject, useEffect, useRef, useSyncExternalStore } from "react";

/** A media query that hydrates cleanly: the server and the first paint read it as false. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Reduced-motion preference; the server and first paint assume motion. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/**
 * Calls `tick` with the milliseconds elapsed since the last tick, only while `target` is on
 * screen and the visitor has not asked for reduced motion. Returns whether motion is allowed.
 */
export function usePlayback(
  target: RefObject<Element | null>,
  tick: (deltaMs: number) => void,
): boolean {
  const reduced = usePrefersReducedMotion();
  const inView = useInView(target, { margin: "0px 0px -10% 0px" });
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  });

  useEffect(() => {
    if (reduced || !inView) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      // A background tab can hand back a huge delta; treat it as one frame.
      const delta = Math.min(now - last, 100);
      last = now;
      tickRef.current(delta);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduced, inView]);

  return !reduced;
}
