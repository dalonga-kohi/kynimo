"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { drawLoop, LOOP_LABELS } from "@/lib/loop";
import { SCENE } from "@/lib/scene";
import { LOOP } from "@/lib/site";
import { usePlayback } from "./usePlayback";

/** Milliseconds each step stays on the stage before the next one takes over. */
const DWELL = 5200;

/**
 * The loop as a player. The stage draws what the active step does to one small scene, the
 * text beside it says what the agent is doing, and the track underneath is the loop's own
 * timeline: six clips and a playhead. It plays by itself while it is on screen; choosing a
 * clip by hand stops the auto-advance and replays that step.
 */
export function LoopPlayer() {
  const root = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const fill = useRef<HTMLSpanElement>(null);
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
      scratch.current.width = 960;
      scratch.current.height = 540;
    }
    drawLoop(ctx, canvas.width, canvas.height, index, t, scratch.current);
    fill.current?.style.setProperty("--t", String(Math.min(1, Math.max(0, t))));
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

  return (
    <div className="loop" ref={root}>
      <div className="loop-main">
        <div className="loop-texts">
          {LOOP.map((item, i) => (
            <div
              key={item.step}
              className="loop-text"
              data-active={i === step}
              aria-hidden={i === step ? undefined : true}
            >
              <h3 className="loop-name">{item.step}</h3>
              <p>{item.body}</p>
              {item.tools.length > 0 ? (
                <ul className="loop-tools" aria-label="Tools the agent calls">
                  {item.tools.map((tool) => (
                    <li key={tool}>
                      <code>{tool}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="loop-tools loop-tools-none">No tools yet. Only your words.</p>
              )}
            </div>
          ))}
        </div>
        <div className="loop-screen">
          <canvas
            ref={canvasRef}
            className="scene-canvas"
            role="img"
            aria-label={LOOP_LABELS[step]}
          />
        </div>
      </div>

      <ol className="loop-track">
        {LOOP.map((item, i) => (
          <li key={item.step}>
            <button
              type="button"
              className="loop-clip"
              data-state={i === step ? "now" : i < step ? "done" : "next"}
              aria-current={i === step ? "step" : undefined}
              onClick={() => choose(i)}
            >
              <span className="loop-bar" aria-hidden="true">
                {i === step && <span ref={fill} className="loop-bar-fill" />}
              </span>
              <span className="loop-label">{item.step}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
