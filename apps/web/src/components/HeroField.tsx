"use client";

import { Dithering } from "@paper-design/shaders-react";
import {
  type MotionStyle,
  type MotionValue,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react";
import { type RefObject, useEffect, useRef } from "react";
import { useMediaQuery, usePrefersReducedMotion } from "./usePlayback";

/** How far the base field drifts against the pointer, in px. */
const PARALLAX = 10;
/** Peak strength of the lit layer, and how long it stays after the pointer stops. */
const LIT = 0.6;
const IDLE_MS = 2500;
const SPRING = { bounce: 0, duration: 0.5 } as const;

type Pointer = {
  mx: MotionValue<string>;
  my: MotionValue<string>;
  lit: MotionValue<number>;
  x: MotionValue<number>;
  y: MotionValue<number>;
};

/**
 * Follows the pointer over the hero without re-rendering: three springs (position and
 * strength of the glow) and two more for the parallax, all written straight to CSS.
 */
function usePointerField(field: RefObject<HTMLDivElement | null>, enabled: boolean): Pointer {
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const rawLit = useMotionValue(0);
  const rawNx = useMotionValue(0);
  const rawNy = useMotionValue(0);
  const sx = useSpring(rawX, SPRING);
  const sy = useSpring(rawY, SPRING);
  const lit = useSpring(rawLit, SPRING);
  const nx = useSpring(rawNx, SPRING);
  const ny = useSpring(rawNy, SPRING);
  const mx = useTransform(sx, (v) => `${v}px`);
  const my = useTransform(sy, (v) => `${v}px`);
  const x = useTransform(nx, (v) => -v * PARALLAX);
  const y = useTransform(ny, (v) => -v * PARALLAX);

  useEffect(() => {
    const el = field.current;
    if (!enabled || !el) return;
    const hero = el.parentElement ?? el;
    let seen = false;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const onMove = (event: PointerEvent) => {
      const box = hero.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      clearTimeout(idle);
      if (!inside) {
        rawLit.set(0);
        return;
      }
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      rawX.set(px);
      rawY.set(py);
      rawNx.set((px / Math.max(rect.width, 1)) * 2 - 1);
      rawNy.set(Math.max(-1, Math.min(1, (py / Math.max(rect.height, 1)) * 2 - 1)));
      if (!seen) {
        // The first move should not sweep the glow in from the corner.
        seen = true;
        sx.jump(px);
        sy.jump(py);
      }
      rawLit.set(LIT);
      idle = setTimeout(() => rawLit.set(0), IDLE_MS);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      clearTimeout(idle);
    };
  }, [enabled, field, rawX, rawY, rawNx, rawNy, rawLit, sx, sy]);

  return { mx, my, lit, x, y };
}

const FRONT = { hero: "#7a6327", close: "#5c4b1f" } as const;

/** The only texture on the page: a slow ordered-dither field behind the headline. */
export function HeroField({ variant = "hero" }: { variant?: "hero" | "close" }) {
  const reduced = usePrefersReducedMotion();
  // A fine pointer only: false on the server and first paint, so touch devices never mount it.
  const finePointer = useMediaQuery("(pointer: fine)");
  const interactive = variant === "hero" && finePointer && !reduced;
  const ref = useRef<HTMLDivElement>(null);
  const { mx, my, lit, x, y } = usePointerField(ref, interactive);

  const dither = (front: string, back: string, pixels: number) => (
    <Dithering
      colorBack={back}
      colorFront={front}
      shape={variant === "hero" ? "warp" : "wave"}
      type="4x4"
      size={2}
      scale={variant === "hero" ? 1.25 : 1}
      speed={reduced ? 0 : 0.16}
      maxPixelCount={pixels}
      style={{ width: "100%", height: "100%" }}
    />
  );

  if (variant === "close") {
    return (
      <div className="field" data-variant="close" aria-hidden="true">
        {dither(FRONT.close, "#0c0b0a", 1920 * 1080)}
      </div>
    );
  }

  return (
    <div className="field" data-variant="hero" aria-hidden="true" ref={ref}>
      <motion.div className="field-layer" style={interactive ? { x, y, scale: 1.03 } : {}}>
        {dither(FRONT.hero, "#0c0b0a", 1920 * 1080)}
      </motion.div>
      {interactive && (
        <motion.div
          className="field-lit"
          style={{ "--mx": mx, "--my": my, "--lit": lit } as unknown as MotionStyle}
        >
          <motion.div className="field-layer" style={{ x, y, scale: 1.03 }}>
            {dither("#f5c842", "#00000000", 1280 * 720)}
          </motion.div>
        </motion.div>
      )}
    </div>
  );
}
