"use client";

import { useCallback, useEffect, useRef } from "react";
import { drawStudy, PACKS, STUDY, STUDY_POSTER, type StudyId } from "@/lib/studies";
import { usePlayback } from "./usePlayback";

type Pack = (typeof PACKS)[number];

const LABELS: Record<StudyId, string> = {
  keynote:
    "Keynote study: a globe of points turns slowly while a blue wave passes over it, an orbit draws itself, then the line Every frame.",
  "playful-saas":
    "Playful SaaS study: shapes bounce in, a card pops up, a cursor clicks Ship it and confetti bursts out.",
  editorial:
    "Editorial study: a column grid draws down a magazine page, a large numeral 04 fades in, then the headline Motion, set like type.",
  brutalist:
    "Brutalist study: hard cuts through MAKE IT LOUD, a black slab, a grid of red squares and the name KYNIMO running across the frame.",
};

function Study({ pack }: { pack: Pack }) {
  const { id } = pack;
  const root = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clock = useRef(0);
  const frame = useRef(0);

  const paint = useCallback(
    (f: number) => {
      frame.current = f;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx || canvas.width === 0) return;
      drawStudy(ctx, canvas.width, canvas.height, id, f);
    },
    [id],
  );

  const moving = usePlayback(root, (delta) => {
    clock.current += delta;
    paint(Math.floor((clock.current / 1000) * STUDY.fps) % STUDY.frames);
  });

  useEffect(() => {
    if (!moving) paint(STUDY_POSTER[id]);
  }, [moving, paint, id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * dpr);
      if (width === 0 || width === canvas.width) return;
      canvas.width = width;
      canvas.height = Math.round((width * STUDY.height) / STUDY.width);
      paint(frame.current);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    // Canvas text falls back to a system face until the webfonts are in.
    let alive = true;
    const repaint = () => alive && paint(frame.current);
    document.fonts.ready.then(repaint, repaint);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [paint]);

  return (
    <figure
      className="pack"
      ref={root}
      style={{ "--pack-accent": pack.accent } as React.CSSProperties}
    >
      <div className="pack-screen">
        <canvas ref={canvasRef} className="scene-canvas" role="img" aria-label={LABELS[id]} />
      </div>
      <figcaption>
        <span className="pack-name">
          <i aria-hidden="true" />
          {pack.name}
        </span>
        <code>{pack.tokens}</code>
        <p>{pack.summary}</p>
      </figcaption>
    </figure>
  );
}

/** One ten-second study per draft pack, each in that pack's own palette and motion. */
export function Packs() {
  return (
    <div className="packs">
      {PACKS.map((pack) => (
        <Study key={pack.id} pack={pack} />
      ))}
    </div>
  );
}
