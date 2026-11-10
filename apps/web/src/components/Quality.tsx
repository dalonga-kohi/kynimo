"use client";

import { useInView } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_CAPTION,
  DEFAULT_TITLE,
  KYNIMO_LOOK,
  LOOP_FRAMES,
  PACK_LOOKS,
  SCENE,
  type SceneLayer,
  type SceneState,
} from "@/lib/scene";
import { SceneCanvas, type SceneCanvasHandle } from "./SceneCanvas";
import { usePlayback } from "./usePlayback";

interface Rule {
  id: string;
  layer?: SceneLayer;
  open?: string;
  fix?: string;
  done: string;
}

/** Rule ids are the real ones from packages/guidelines. The findings are illustrative. */
const RULES: readonly Rule[] = [
  {
    id: "readable-hold",
    layer: "title",
    open: "4 words on screen for 0.9 s. Reading them takes 1.6 s.",
    fix: "Move the title's out-point to frame 132.",
    done: "4 words held for 2.5 s.",
  },
  {
    id: "safe-area",
    layer: "caption",
    open: "Caption sits 22 px from the bottom edge. The margin is 54 px.",
    fix: "Move the caption up 54 px.",
    done: "Every layer inside the 5% margin.",
  },
  { id: "text-contrast", done: "Title on background, 16.1 : 1." },
  { id: "token-easing", done: "11 of 11 keyframes use pack tokens." },
  { id: "concurrent-motion", done: "Never more than 2 things moving at once." },
  { id: "min-text-size", done: "Smallest text is 36 px." },
  { id: "flash-rate", done: "No flashing." },
];

export function QualityReport() {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<SceneCanvasHandle>(null);
  const inView = useInView(root, { amount: 0.5 });
  const [fixed, setFixed] = useState(false);
  const [run, setRun] = useState(0);
  const [focus, setFocus] = useState<SceneLayer | null>(null);
  const clock = useRef(0);

  // Each run: show the findings, then let the fixes land.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` restarts the sequence
  useEffect(() => {
    if (!inView) return;
    setFixed(false);
    clock.current = 0;
    const id = window.setTimeout(() => {
      setFixed(true);
      clock.current = 0;
    }, 3600);
    return () => window.clearTimeout(id);
  }, [inView, run]);

  const state = useMemo<SceneState>(
    () => ({
      look: KYNIMO_LOOK,
      title: DEFAULT_TITLE,
      caption: DEFAULT_CAPTION,
      layers: 4,
      animated: true,
      fixed,
      echoes: false,
      guides: true,
      highlight: focus,
    }),
    [fixed, focus],
  );

  const moving = usePlayback(root, (delta) => {
    clock.current += delta;
    const loop = fixed ? LOOP_FRAMES.fixed : LOOP_FRAMES.open;
    canvas.current?.draw(Math.floor((clock.current / 1000) * SCENE.fps) % loop);
  });

  const open = RULES.filter((r) => r.open).length;

  return (
    <div className="report" ref={root}>
      <div className="report-frame">
        <div className="viewer">
          <SceneCanvas
            ref={canvas}
            state={moving ? state : { ...state, animated: false }}
            label="The scene with its safe area drawn. The caption starts outside the margin and moves inside once fixed."
          />
        </div>
        <p className="fineprint">Dashed line: the 5% safe area.</p>
      </div>

      <div className="report-list">
        <div className="report-head">
          <h3>Quality report</h3>
          <span className="verdict" data-ok={fixed} aria-live="polite">
            {fixed ? "All clear" : `${open} findings`}
          </span>
        </div>
        <ul>
          {RULES.map((rule) => {
            const failing = Boolean(rule.open) && !fixed;
            return (
              <li
                key={rule.id}
                className="rule"
                data-status={failing ? "fail" : "pass"}
                onMouseEnter={() => rule.layer && setFocus(rule.layer)}
                onMouseLeave={() => setFocus(null)}
              >
                <span className="check-dot" aria-hidden="true" />
                <div>
                  <code>{rule.id}</code>
                  <p>{failing ? rule.open : rule.done}</p>
                  {failing && rule.fix && <p className="rule-fix">Fix: {rule.fix}</p>}
                </div>
              </li>
            );
          })}
        </ul>
        <button type="button" className="btn btn-quiet" onClick={() => setRun((n) => n + 1)}>
          Run the check again
        </button>
      </div>
    </div>
  );
}

export function PackSwitcher() {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<SceneCanvasHandle>(null);
  const [active, setActive] = useState(0);
  const clock = useRef(0);
  const pack = PACK_LOOKS[active] ?? PACK_LOOKS[0];

  const state = useMemo<SceneState | null>(
    () =>
      pack
        ? {
            look: pack,
            title: DEFAULT_TITLE,
            caption: DEFAULT_CAPTION,
            layers: 4,
            animated: true,
            fixed: true,
            echoes: true,
          }
        : null,
    [pack],
  );

  const moving = usePlayback(root, (delta) => {
    clock.current += delta;
    canvas.current?.draw(Math.floor((clock.current / 1000) * SCENE.fps) % SCENE.frames);
  });

  if (!pack || !state) return null;

  return (
    <div className="packs" ref={root}>
      <div className="packs-pick" role="radiogroup" aria-label="Guideline pack">
        {PACK_LOOKS.map((p, i) => (
          // biome-ignore lint/a11y/useSemanticElements: buttons give the swatch and roving focus a native radio cannot
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={i === active}
            tabIndex={i === active ? 0 : -1}
            className="pack"
            onClick={() => {
              clock.current = 0;
              setActive(i);
            }}
            onKeyDown={(e) => {
              const dir =
                e.key === "ArrowRight" || e.key === "ArrowDown"
                  ? 1
                  : e.key === "ArrowLeft" || e.key === "ArrowUp"
                    ? -1
                    : 0;
              if (!dir) return;
              e.preventDefault();
              const next = (i + dir + PACK_LOOKS.length) % PACK_LOOKS.length;
              clock.current = 0;
              setActive(next);
              const group = e.currentTarget.parentElement;
              (group?.children[next] as HTMLElement | undefined)?.focus();
            }}
          >
            <span className="pack-swatch" aria-hidden="true">
              <i style={{ background: p.bg }} />
              <i style={{ background: p.text }} />
              <i style={{ background: p.accent }} />
            </span>
            <span className="pack-name">{p.name}</span>
          </button>
        ))}
      </div>
      <div className="viewer">
        <SceneCanvas
          ref={canvas}
          state={moving ? state : { ...state, animated: false }}
          label={`The same scene in the ${pack.name} pack.`}
        />
      </div>
      <div className="packs-meta" aria-live="polite">
        <p>{pack.summary}</p>
        <code>{pack.tokens}</code>
      </div>
    </div>
  );
}
