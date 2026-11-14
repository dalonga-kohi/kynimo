"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { drawLoop, LOOP_LABELS } from "@/lib/loop";
import { SCENE } from "@/lib/scene";
import { LOOP } from "@/lib/site";
import { usePlayback } from "./usePlayback";

/** Milliseconds each step stays on the stage before the next one takes over. */
const DWELL = 5200;

/**
 * The loop as one player: the six steps on the left, and a stage that draws what the active
 * step does to the same small scene. It advances by itself while it is on screen; choosing a
 * step by hand stops the auto-advance and replays that step.
 */
export function LoopPlayer() {
  const root = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const rail = useRef<HTMLSpanElement>(null);
  const elapsed = useRef(0);
  const stepRef = useRef(0);
  const manual = useRef(false);
  const [step, setStep] = useState(0);

  const paint = useCallback((index: number, t: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || canvas.width === 0) return;
    if (!scratch.current) {
      scratch.current = document.createElement("canvas");
      scratch.current.width = 640;
      scratch.current.height = 360;
    }
    drawLoop(ctx, canvas.width, canvas.height, index, t, scratch.current);
    rail.current?.style.setProperty("--t", String(Math.min(1, Math.max(0, t))));
  }, []);

  const moving = usePlayback(root, (delta) => {
    elapsed.current += delta;
    if (elapsed.current >= DWELL) {
      if (manual.current) elapsed.current = DWELL;
      else {
        elapsed.current = 0;
        stepRef.current = (stepRef.current + 1) % LOOP.length;
        setStep(stepRef.current);
      }
    }
    paint(stepRef.current, elapsed.current / DWELL);
  });

  const choose = (index: number) => {
    manual.current = true;
    stepRef.current = index;
    elapsed.current = 0;
    setStep(index);
    paint(index, moving ? 0 : 1);
  };

  // Without motion every step shows its finished picture.
  useEffect(() => {
    if (!moving) paint(stepRef.current, 1);
  }, [moving, paint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const now = () => (moving ? elapsed.current / DWELL : 1);
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * dpr);
      if (width === 0 || width === canvas.width) return;
      canvas.width = width;
      canvas.height = Math.round((width * SCENE.height) / SCENE.width);
      paint(stepRef.current, now());
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    // Canvas text falls back to a system face until the webfonts are in.
    let alive = true;
    const repaint = () => alive && paint(stepRef.current, now());
    document.fonts.load('800 expanded 48px "Mona Sans Variable"').then(repaint, repaint);
    document.fonts.ready.then(repaint, repaint);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [paint, moving]);

  const active = LOOP[step] ?? LOOP[0];

  return (
    <div className="loop" ref={root}>
      <ol className="loop-steps">
        {LOOP.map((item, i) => (
          <li key={item.step} className="loop-step" data-active={i === step}>
            <button
              type="button"
              className="loop-button"
              aria-current={i === step ? "step" : undefined}
              onClick={() => choose(i)}
            >
              <span className="loop-rail" aria-hidden="true">
                {i === step && <span ref={rail} className="loop-rail-fill" />}
              </span>
              <span className="loop-name">{item.step}</span>
              <span className="loop-body">
                <span>{item.body}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <figure className="loop-stage">
        <div className="loop-screen">
          <canvas
            ref={canvasRef}
            className="scene-canvas"
            role="img"
            aria-label={LOOP_LABELS[step]}
          />
        </div>
        <figcaption className="loop-caption">
          <span>
            {active.tools.length > 0 ? "Tools it calls" : "No tools yet, only your words"}
          </span>
          {active.tools.length > 0 && (
            <ul>
              {active.tools.map((tool) => (
                <li key={tool}>
                  <code>{tool}</code>
                </li>
              ))}
            </ul>
          )}
        </figcaption>
      </figure>
    </div>
  );
}
