"use client";

import {
  animate,
  type MotionStyle,
  motion,
  useInView,
  useMotionValue,
  useScroll,
  useTransform,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Mark } from "./Mark";
import { useMediaQuery, usePrefersReducedMotion } from "./usePlayback";

const LAYERS = [
  { id: "background", kind: "solid" },
  { id: "mark", kind: "shape · 6 paths" },
  { id: "title", kind: "text · per-word animator" },
  { id: "rule", kind: "shape · trim path" },
  { id: "caption", kind: "text" },
] as const;

/** Same query as the CSS that turns the pinned scroll track off. */
const TOUCH = "(max-width: 900px), (pointer: coarse)";

/**
 * One frame, flat, that comes apart into the layers it is made of. With a mouse the page's
 * scroll drives it. On touch screens a long pinned scroll fights the finger, so it opens by
 * itself once it is in view and a button flattens or opens it again.
 */
export function LayerStack() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const touch = useMediaQuery(TOUCH);
  const touchRef = useRef(touch);
  touchRef.current = touch;

  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.3", "end end"] });
  const opened = useMotionValue(0);
  const [open, setOpen] = useState(false);
  const inView = useInView(ref, { amount: 0.6, once: true });

  useEffect(() => {
    if (touch && inView) setOpen(true);
  }, [touch, inView]);

  useEffect(() => {
    if (!touch) return;
    const controls = animate(
      opened,
      open ? 1 : 0,
      reduced ? { duration: 0 } : { type: "spring", bounce: 0, duration: 1.2 },
    );
    return () => controls.stop();
  }, [touch, open, reduced, opened]);

  const p = useTransform([scrollYProgress, opened], ([scroll, tapped]) => {
    if (touchRef.current) return tapped as number;
    if (reduced) return 1;
    // Ease the scroll into a settle: fast at first, slow as the layers land.
    return 1 - (1 - Math.min(1, Math.max(0, (scroll as number) / 0.85))) ** 3;
  });
  const flatLabel = useTransform(p, (v) => Math.max(0, 1 - v * 4));
  const openLabel = useTransform(p, (v) => Math.min(1, Math.max(0, v * 4 - 2.6)));

  return (
    <div className="stack" ref={ref}>
      <motion.div className="stack-stage" style={{ "--p": p } as unknown as MotionStyle}>
        <div className="stack-frame" aria-hidden="true">
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
        <div className="stack-readout" aria-hidden="true">
          <motion.span style={{ opacity: flatLabel }}>launch-teaser.mp4 · 1 flat file</motion.span>
          <motion.span style={{ opacity: openLabel }}>
            launch-teaser · 5 layers, all editable
          </motion.span>
        </div>
      </motion.div>
      {touch && (
        <button
          type="button"
          className="btn btn-quiet stack-toggle"
          aria-pressed={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Flatten the frame" : "Show the layers"}
        </button>
      )}
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
