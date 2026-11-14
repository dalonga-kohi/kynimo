"use client";

import { animate, type MotionStyle, motion, useInView, useMotionValue } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Mark } from "./Mark";
import { usePrefersReducedMotion } from "./usePlayback";

/** Bottom to top, the order the planes stack in. */
const LAYERS = [
  { id: "background", kind: "solid" },
  { id: "mark", kind: "shape · 6 paths" },
  { id: "title", kind: "text · per-word animator" },
  { id: "rule", kind: "shape · trim path" },
  { id: "caption", kind: "text" },
] as const;

type LayerId = (typeof LAYERS)[number]["id"];

/** Top layer first, the way a layers panel lists them. */
const PANEL = [...LAYERS].reverse();

/**
 * The "Not a clip. A project." scene. One frame comes apart into the layers it is made of as
 * it enters the screen, with no pinned scroll. Beside it sits the scene's layers panel: point
 * at a layer and it lifts out of the stack; one button makes an edit, and only the title moves.
 */
export function LayerStack() {
  const stage = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const inView = useInView(stage, { amount: 0.5, once: true });
  const opened = useMotionValue(0);
  const [picked, setPicked] = useState<LayerId | null>(null);
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    if (!inView) return;
    const controls = animate(
      opened,
      1,
      reduced ? { duration: 0 } : { type: "spring", bounce: 0, duration: 1.5 },
    );
    return () => controls.stop();
  }, [inView, reduced, opened]);

  const shown = picked ?? (edited ? "title" : null);
  const layer = LAYERS.find((item) => item.id === shown);
  const readout = layer
    ? edited && layer.id === "title"
      ? "title changed · 4 layers untouched"
      : `${layer.id} · ${layer.kind}`
    : "launch-teaser · 5 layers, all editable";

  return (
    <motion.div className="wrap layers-grid" style={{ "--p": opened } as unknown as MotionStyle}>
      <div className="layers-copy">
        <h2 id="layers-title" data-echo>
          <span>Not a clip.</span> <span className="layers-then">A project.</span>
        </h2>
        <p className="lede">
          Video generators hand you finished pixels. Want a different word? Generate again and hope.
        </p>
        <p className="lede">
          Kynimo builds a scene: every layer, keyframe, colour and timing has a name. Your agent
          changes one of them, and every other frame stays exactly as it was.
        </p>

        <div className="layer-panel">
          <ul className="layer-list" aria-label="Layers in this scene">
            {PANEL.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="layer-row"
                  data-picked={shown === item.id}
                  aria-pressed={picked === item.id}
                  onPointerEnter={(event) => {
                    if (event.pointerType === "mouse") setPicked(item.id);
                  }}
                  onPointerLeave={(event) => {
                    if (event.pointerType === "mouse") setPicked(null);
                  }}
                  onFocus={() => setPicked(item.id)}
                  onBlur={() => setPicked(null)}
                  onClick={() => setPicked(picked === item.id ? null : item.id)}
                >
                  <span className="layer-name">{item.id}</span>
                  <span className="layer-kind">{item.kind}</span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-quiet layer-edit"
            aria-pressed={edited}
            onClick={() => setEdited(!edited)}
          >
            {edited ? "Change it back" : "Change the title"}
          </button>
        </div>
      </div>

      <div className="stack-stage" ref={stage}>
        <div
          className="stack-frame"
          data-picking={shown !== null}
          data-edited={edited}
          aria-hidden="true"
        >
          {LAYERS.map((item, i) => (
            <div
              key={item.id}
              className="plane"
              data-layer={item.id}
              data-picked={shown === item.id}
              style={{ "--i": i } as React.CSSProperties}
            >
              {item.id === "mark" && <Mark className="plane-mark" />}
              {item.id === "title" && (
                <>
                  <p className="plane-title plane-title-was">Every frame, on purpose.</p>
                  <p className="plane-title plane-title-now">
                    Every frame, <em>by design.</em>
                  </p>
                </>
              )}
              {item.id === "rule" && <span className="plane-rule" />}
              {item.id === "caption" && <p className="plane-caption">Made over MCP</p>}
            </div>
          ))}
        </div>
        <output className="stack-readout" aria-live="polite">
          {readout}
        </output>
      </div>
    </motion.div>
  );
}
