"use client";

import { type MotionValue, motion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";
import { Mark } from "./Mark";
import { usePrefersReducedMotion } from "./usePlayback";

const EXPOSURES = 9;

function Exposure({ index, progress }: { index: number; progress: MotionValue<number> }) {
  const behind = EXPOSURES - 1 - index;
  const sharp = behind === 0;
  // The mark arrives from the right: each earlier exposure sits further back along its path.
  const x = useTransform(progress, (p) => `${behind * 9.6 * (1 - p)}vw`);
  const opacity = useTransform(progress, (p) =>
    sharp ? 1 : (0.07 + 0.42 * (index / EXPOSURES)) * Math.min(1, (1 - p) * 2.4),
  );
  return (
    <motion.div className="exposure" data-sharp={sharp} style={{ x, opacity }}>
      <Mark />
      <span>f{String(index * 3).padStart(2, "0")}</span>
    </motion.div>
  );
}

/** A motion study: nine exposures of the mark that close into one frame as you scroll. */
export function Statement() {
  const ref = useRef<HTMLElement>(null);
  const reduced = usePrefersReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.9", "start 0.3"] });
  const eased = useTransform(scrollYProgress, (p) => (reduced ? 1 : 1 - (1 - p) ** 2.2));

  return (
    <section className="statement" ref={ref} aria-labelledby="statement-title">
      <div className="wrap">
        <div className="study" aria-hidden="true">
          {Array.from({ length: EXPOSURES }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed run of identical exposures
            <Exposure key={i} index={i} progress={eased} />
          ))}
        </div>
        <h2 id="statement-title" className="statement-title">
          <span>AI video gives you pixels.</span> Kynimo gives you the project.
        </h2>
        <p className="lede">
          A generated clip is finished the moment it renders. Wrong word? Roll again. A Kynimo scene
          stays open. Every layer, every keyframe and every frame has an address.
        </p>
      </div>
    </section>
  );
}
