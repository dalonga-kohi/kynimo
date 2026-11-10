"use client";

import { motion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";
import { Mark } from "./Mark";
import { usePrefersReducedMotion } from "./usePlayback";

const LAYERS = [
  { id: "background", kind: "solid" },
  { id: "mark", kind: "shape · 6 paths" },
  { id: "title", kind: "text · per-word animator" },
  { id: "rule", kind: "shape · trim path" },
  { id: "caption", kind: "text" },
] as const;

/**
 * One frame, flat, that comes apart into the layers it is made of as the section scrolls
 * past. Pure CSS 3D: scroll progress drives a single custom property.
 */
export function LayerStack() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.3", "end end"] });
  // Ease the scroll into a settle: fast at first, slow as the layers land.
  const p = useTransform(scrollYProgress, (v) =>
    reduced ? 1 : 1 - (1 - Math.min(1, Math.max(0, v / 0.85))) ** 3,
  );
  const flatLabel = useTransform(p, (v) => Math.max(0, 1 - v * 4));
  const openLabel = useTransform(p, (v) => Math.min(1, Math.max(0, v * 4 - 2.6)));

  return (
    <div className="stack" ref={ref}>
      <motion.div className="stack-stage" style={{ "--p": p } as never} aria-hidden="true">
        <div className="stack-frame">
          {LAYERS.map((layer, i) => (
            <div
              key={layer.id}
              className="plane"
              data-layer={layer.id}
              style={{ "--i": i } as React.CSSProperties}
            >
              {layer.id === "mark" && <Mark className="plane-mark" />}
              {layer.id === "title" && <p className="plane-title">Every frame, on purpose.</p>}
              {layer.id === "rule" && <span className="plane-rule" />}
              {layer.id === "caption" && <p className="plane-caption">Made over MCP</p>}
              <span className="plane-tag">
                <b>{layer.id}</b> {layer.kind}
              </span>
            </div>
          ))}
        </div>
        <div className="stack-readout">
          <motion.span style={{ opacity: flatLabel }}>launch-teaser.mp4 · 1 flat file</motion.span>
          <motion.span style={{ opacity: openLabel }}>
            launch-teaser · 5 layers, all editable
          </motion.span>
        </div>
      </motion.div>
      <ul className="sr-only">
        {LAYERS.map((layer) => (
          <li key={layer.id}>
            {layer.id}: {layer.kind}
          </li>
        ))}
      </ul>
    </div>
  );
}
