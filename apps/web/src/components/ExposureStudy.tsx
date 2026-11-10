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
  const x = useTransform(progress, (p) => `${behind * 7.5 * (1 - p)}vw`);
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

/** A motion study: nine exposures of the mark that close into one sharp frame as you scroll. */
export function ExposureStudy() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.95", "start 0.35"] });
  const eased = useTransform(scrollYProgress, (p) => (reduced ? 1 : 1 - (1 - p) ** 2.2));

  return (
    <div className="study" ref={ref} aria-hidden="true">
      {Array.from({ length: EXPOSURES }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed run of identical exposures
        <Exposure key={i} index={i} progress={eased} />
      ))}
    </div>
  );
}
