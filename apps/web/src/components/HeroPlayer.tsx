"use client";

import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_CAPTION,
  DEFAULT_TITLE,
  KYNIMO_LOOK,
  OUT_FRAME,
  SCENE,
  type SceneState,
  timecode,
} from "@/lib/scene";
import { SceneCanvas, type SceneCanvasHandle } from "./SceneCanvas";
import { usePlayback } from "./usePlayback";

const STATE: SceneState = {
  look: KYNIMO_LOOK,
  title: DEFAULT_TITLE,
  caption: DEFAULT_CAPTION,
  layers: 4,
  animated: true,
  fixed: true,
  echoes: true,
};

const TRACKS = [
  { name: "mark", kind: "shape", start: 6 },
  { name: "title", kind: "text", start: 30 },
  { name: "rule", kind: "shape", start: 46 },
  { name: "caption", kind: "text", start: 54 },
] as const;

const END = OUT_FRAME.fixed + 10;
const REST = 100;
const pct = (frame: number) => `${(frame / SCENE.frames) * 100}%`;

/** The hero: one finished scene, playing, with the timeline it is made of. Drawn live. */
export function HeroPlayer() {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<SceneCanvasHandle>(null);
  const track = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLOutputElement>(null);
  const clock = useRef(0);
  const frameNow = useRef(REST);
  const scrubbing = useRef(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  const show = useCallback((frame: number) => {
    frameNow.current = frame;
    canvas.current?.draw(frame);
    const el = track.current;
    if (el) {
      el.setAttribute("aria-valuenow", String(Math.round(frame)));
      el.setAttribute("aria-valuetext", `Frame ${Math.round(frame)}, ${timecode(frame)}`);
    }
    if (playhead.current) playhead.current.style.left = pct(frame);
    if (readout.current)
      readout.current.textContent = `${timecode(frame)}  f${String(Math.round(frame)).padStart(3, "0")}`;
  }, []);

  const pause = (value: boolean) => {
    pausedRef.current = value;
    setPaused(value);
  };

  const moving = usePlayback(root, (delta) => {
    if (scrubbing.current || pausedRef.current) return;
    clock.current += delta;
    show(Math.floor((clock.current / 1000) * SCENE.fps) % SCENE.frames);
  });

  // Without motion the finished frame is shown; the timeline still scrubs.
  useEffect(() => {
    if (!moving) show(REST);
  }, [moving, show]);

  const scrubTo = (event: PointerEvent<HTMLDivElement>) => {
    const el = track.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const frame = Math.round(ratio * (SCENE.frames - 1));
    clock.current = (frame / SCENE.fps) * 1000;
    show(frame);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const dir = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    event.preventDefault();
    pause(true);
    const next = Math.min(
      SCENE.frames - 1,
      Math.max(0, Math.round(frameNow.current) + dir * (event.shiftKey ? 10 : 1)),
    );
    clock.current = (next / SCENE.fps) * 1000;
    show(next);
  };

  return (
    <div className="player" ref={root}>
      <div className="player-screen">
        <SceneCanvas
          ref={canvas}
          state={STATE}
          frame={REST}
          label="A five second launch teaser: the Kynimo mark slides in, then the title Every frame, on purpose, a yellow rule and a caption."
        />
      </div>

      <div className="player-deck">
        <div className="player-bar">
          {moving && (
            <button
              type="button"
              className="play"
              aria-label={paused ? "Play" : "Pause"}
              onClick={() => pause(!paused)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                {paused ? (
                  <path d="M5 3.2v9.6L12.6 8z" fill="currentColor" />
                ) : (
                  <path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z" fill="currentColor" />
                )}
              </svg>
            </button>
          )}
          <span className="player-name">launch-teaser</span>
          <span className="player-meta">1920 × 1080 · 30 fps · 4 layers</span>
          <output ref={readout} className="player-time" aria-live="off">
            00:03:10 f100
          </output>
        </div>

        <div
          className="tracks"
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label="Scrub the scene"
          aria-valuemin={0}
          aria-valuemax={SCENE.frames - 1}
          aria-valuenow={REST}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            scrubbing.current = true;
            scrubTo(e);
          }}
          onPointerMove={(e) => scrubbing.current && scrubTo(e)}
          onPointerUp={() => {
            scrubbing.current = false;
          }}
          onPointerCancel={() => {
            scrubbing.current = false;
          }}
          onKeyDown={onKeyDown}
        >
          {TRACKS.map((t) => (
            <div key={t.name} className="track">
              <span className="track-name">
                {t.name}
                <i>{t.kind}</i>
              </span>
              <span className="track-lane">
                <span className="clip" style={{ left: pct(t.start), width: pct(END - t.start) }}>
                  <i className="key" />
                  <i className="key key-out" />
                </span>
              </span>
            </div>
          ))}
          <div className="track-lanes-overlay" aria-hidden="true">
            <div className="playhead" ref={playhead} style={{ left: pct(REST) }} />
          </div>
        </div>
      </div>
    </div>
  );
}
