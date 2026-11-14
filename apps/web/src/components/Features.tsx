"use client";

import { useCallback, useEffect, useRef } from "react";
import { drawFeature, FEATURE, FEATURES } from "@/lib/features";
import { usePlayback } from "./usePlayback";

type Feature = (typeof FEATURES)[number];

function Study({ feature }: { feature: Feature }) {
  const { id, poster } = feature;
  const root = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clock = useRef(0);
  const frame = useRef<number>(poster);

  const paint = useCallback(
    (f: number) => {
      frame.current = f;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx || canvas.width === 0) return;
      drawFeature(ctx, canvas.width, canvas.height, id, f);
    },
    [id],
  );

  const moving = usePlayback(root, (delta) => {
    clock.current += delta;
    paint(Math.floor((clock.current / 1000) * FEATURE.fps) % FEATURE.frames);
  });

  useEffect(() => {
    if (!moving) paint(poster);
  }, [moving, paint, poster]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * dpr);
      if (width === 0 || width === canvas.width) return;
      canvas.width = width;
      canvas.height = Math.round((width * FEATURE.height) / FEATURE.width);
      paint(frame.current);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    // Canvas text falls back to a system face until the webfonts are in.
    let alive = true;
    const repaint = () => alive && paint(frame.current);
    document.fonts.load('800 expanded 48px "Mona Sans Variable"').then(repaint, repaint);
    document.fonts.ready.then(repaint, repaint);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [paint]);

  return (
    <figure className="feature" ref={root}>
      <div className="feature-screen">
        <canvas ref={canvasRef} className="scene-canvas" role="img" aria-label={feature.label} />
      </div>
      <figcaption>
        <h3>{feature.name}</h3>
        <p>{feature.body}</p>
      </figcaption>
    </figure>
  );
}

/** One six-second study per engine feature, each drawn live in the page's palette. */
export function Features() {
  return (
    <div className="features">
      {FEATURES.map((feature) => (
        <Study key={feature.id} feature={feature} />
      ))}
    </div>
  );
}
