"use client";

import { type Ref, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { drawScene, SCENE, type SceneState } from "@/lib/scene";

export interface SceneCanvasHandle {
  /** Paint one frame now, outside React's render cycle. */
  draw: (frame: number) => void;
}

interface Props {
  state: SceneState;
  /** Frame shown until something calls `draw`. */
  frame?: number;
  label: string;
  ref?: Ref<SceneCanvasHandle>;
}

/** A 16:9 canvas that draws the demo scene crisp at any size. */
export function SceneCanvas({ state, frame = 100, label, ref }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ state, frame });

  const paint = useCallback((f: number) => {
    latest.current.frame = f;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || canvas.width === 0) return;
    drawScene(ctx, canvas.width, canvas.height, f, latest.current.state);
  }, []);

  useImperativeHandle(ref, () => ({ draw: paint }), [paint]);

  useEffect(() => {
    latest.current.state = state;
    paint(latest.current.frame);
  }, [state, paint]);

  useEffect(() => {
    paint(frame);
  }, [frame, paint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * dpr);
      if (width === 0 || width === canvas.width) return;
      canvas.width = width;
      canvas.height = Math.round((width * SCENE.height) / SCENE.width);
      paint(latest.current.frame);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    // Canvas text falls back to a system face until the webfont is in.
    let alive = true;
    const repaint = () => alive && paint(latest.current.frame);
    document.fonts.load('800 expanded 48px "Mona Sans Variable"').then(repaint, repaint);
    document.fonts.ready.then(repaint, repaint);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [paint]);

  return <canvas ref={canvasRef} className="scene-canvas" role="img" aria-label={label} />;
}
