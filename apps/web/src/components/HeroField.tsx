"use client";

import { Dithering } from "@paper-design/shaders-react";
import { usePrefersReducedMotion } from "./usePlayback";

/** The only texture on the page: a slow ordered-dither field behind the headline. */
export function HeroField({ variant = "hero" }: { variant?: "hero" | "close" }) {
  const reduced = usePrefersReducedMotion();
  return (
    <div className="field" data-variant={variant} aria-hidden="true">
      <Dithering
        colorBack="#0c0b0a"
        colorFront={variant === "hero" ? "#7a6327" : "#5c4b1f"}
        shape={variant === "hero" ? "warp" : "wave"}
        type="4x4"
        size={2}
        scale={variant === "hero" ? 1.25 : 1}
        speed={reduced ? 0 : 0.16}
        maxPixelCount={1920 * 1080}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
