"use client";

import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_CAPTION,
  DEFAULT_TITLE,
  KYNIMO_LOOK,
  LOOP_FRAMES,
  OUT_FRAME,
  SCENE,
  type SceneState,
  timecode,
} from "@/lib/scene";
import { SceneCanvas, type SceneCanvasHandle } from "./SceneCanvas";
import { usePlayback } from "./usePlayback";

type Check = "idle" | "fail" | "pass";

interface Step {
  /** Milliseconds into the session. */
  at: number;
  tool?: string;
  say?: string;
  detail: string;
  layers: number;
  animated: boolean;
  fixed: boolean;
  checks: Check;
}

const STEPS: readonly Step[] = [
  {
    at: 0,
    say: "Brief",
    detail: "A five-second launch teaser. Calm, confident.",
    layers: 0,
    animated: false,
    fixed: false,
    checks: "idle",
  },
  {
    at: 1100,
    tool: "create_project",
    detail: "1920 × 1080 · 30 fps",
    layers: 0,
    animated: false,
    fixed: false,
    checks: "idle",
  },
  {
    at: 1900,
    tool: "add_layer",
    detail: "mark",
    layers: 1,
    animated: false,
    fixed: false,
    checks: "idle",
  },
  {
    at: 2500,
    tool: "add_layer",
    detail: "title",
    layers: 2,
    animated: false,
    fixed: false,
    checks: "idle",
  },
  {
    at: 3100,
    tool: "apply_ops",
    detail: "rule, caption",
    layers: 4,
    animated: false,
    fixed: false,
    checks: "idle",
  },
  {
    at: 4000,
    tool: "set_keyframes",
    detail: "11 keyframes · spring",
    layers: 4,
    animated: true,
    fixed: false,
    checks: "idle",
  },
  {
    at: 8200,
    tool: "render_contact_sheet",
    detail: "6 frames, looked at",
    layers: 4,
    animated: true,
    fixed: false,
    checks: "idle",
  },
  {
    at: 9100,
    say: "Quality report",
    detail: "2 findings",
    layers: 4,
    animated: true,
    fixed: false,
    checks: "fail",
  },
  {
    at: 11200,
    tool: "apply_ops",
    detail: "2 fixes",
    layers: 4,
    animated: true,
    fixed: true,
    checks: "fail",
  },
  {
    at: 12000,
    say: "Quality report",
    detail: "All clear",
    layers: 4,
    animated: true,
    fixed: true,
    checks: "pass",
  },
];
const LAST = STEPS.length - 1;
const LOOP_MS = 21000;

const CHECKS = [
  {
    id: "readable-hold",
    open: "5 words held 0.9 s. Needs 2.0 s.",
    done: "5 words held 2.5 s",
    fails: true,
  },
  {
    id: "safe-area",
    open: "Caption 22 px from the edge. Minimum 54.",
    done: "Inside the 5% margin",
    fails: true,
  },
  { id: "text-contrast", open: "", done: "16.1 : 1", fails: false },
  { id: "token-easing", open: "", done: "11 of 11 keyframes on tokens", fails: false },
] as const;

const TRACKS = [
  { name: "mark", start: 6 },
  { name: "title", start: 30 },
  { name: "rule", start: 46 },
  { name: "caption", start: 54 },
] as const;

const pct = (frame: number) => `${(frame / SCENE.frames) * 100}%`;

/** The hero: an assistant builds the scene, checks it and fixes it. Illustrative, drawn live. */
export function Session() {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<SceneCanvasHandle>(null);
  const track = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLOutputElement>(null);

  const [step, setStep] = useState(0);
  const clock = useRef(0);
  const frameClock = useRef(0);
  const scrubbing = useRef(false);
  const stepRef = useRef(0);

  const current = STEPS[step] as Step;
  const state = useMemo<SceneState>(
    () => ({
      look: KYNIMO_LOOK,
      title: DEFAULT_TITLE,
      caption: DEFAULT_CAPTION,
      layers: current.layers,
      animated: current.animated,
      fixed: current.fixed,
      echoes: true,
    }),
    [current.layers, current.animated, current.fixed],
  );

  const show = useCallback((frame: number) => {
    canvas.current?.draw(frame);
    if (playhead.current)
      playhead.current.style.transform = `translateX(${track.current ? (frame / SCENE.frames) * track.current.clientWidth : 0}px)`;
    if (readout.current)
      readout.current.textContent = `${timecode(frame)}  f${String(Math.round(frame)).padStart(3, "0")}`;
  }, []);

  const goTo = useCallback((next: number) => {
    if (next === stepRef.current) return;
    // Playback starts from frame 0 when keyframes land, and again when the fixes do.
    const was = STEPS[stepRef.current] as Step;
    const now = STEPS[next] as Step;
    if ((now.animated && !was.animated) || (now.fixed && !was.fixed)) frameClock.current = 0;
    stepRef.current = next;
    setStep(next);
  }, []);

  const moving = usePlayback(root, (delta) => {
    if (scrubbing.current) return;
    clock.current += delta;
    if (clock.current >= LOOP_MS) {
      clock.current = 0;
      goTo(0);
    }
    let next = 0;
    for (let i = 0; i <= LAST; i++) if (clock.current >= (STEPS[i] as Step).at) next = i;
    goTo(next);
    if ((STEPS[next] as Step).animated) {
      frameClock.current += delta;
      const loop = (STEPS[next] as Step).fixed ? LOOP_FRAMES.fixed : LOOP_FRAMES.open;
      show(Math.floor((frameClock.current / 1000) * SCENE.fps) % loop);
    }
  });

  // Without motion the session is shown finished; the timeline still scrubs.
  useEffect(() => {
    if (!moving) show(100);
  }, [moving, show]);
  const shown = moving ? step : LAST;
  const view = STEPS[shown] as Step;
  const viewState = moving ? state : { ...state, layers: 4, animated: true, fixed: true };

  const scrubTo = (event: PointerEvent<HTMLDivElement>) => {
    const el = track.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const frame = Math.round(ratio * (SCENE.frames - 1));
    frameClock.current = (frame / SCENE.fps) * 1000;
    show(frame);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubbing.current = true;
    // Scrubbing shows the finished scene: jump the session to its end.
    clock.current = Math.max(clock.current, (STEPS[LAST] as Step).at);
    stepRef.current = LAST;
    setStep(LAST);
    scrubTo(event);
  };

  const out = view.fixed ? OUT_FRAME.fixed : OUT_FRAME.open;

  return (
    <div className="session" ref={root}>
      <div className="session-bar">
        <span className="session-name">launch-teaser</span>
        <span className="session-note">Illustrative session, drawn live in your browser</span>
      </div>

      <div className="session-body">
        <ol className="log" aria-label="What the assistant did">
          {STEPS.map((s, i) => (
            <li key={s.at} className="log-line" data-on={i <= shown} data-now={i === shown}>
              {s.tool ? <code>{s.tool}</code> : <span className="log-say">{s.say}</span>}
              <span className="log-detail">{s.detail}</span>
            </li>
          ))}
        </ol>

        <div className="stage">
          <div className="viewer">
            <SceneCanvas
              ref={canvas}
              state={viewState}
              label="A launch teaser being built: the Kynimo mark slides in, then the title Every frame, on purpose."
            />
          </div>

          <ul className="checks" aria-label="Quality checks">
            {CHECKS.map((c) => {
              const status: Check =
                view.checks === "idle" ? "idle" : c.fails ? view.checks : "pass";
              return (
                <li key={c.id} className="check" data-status={status}>
                  <span className="check-dot" aria-hidden="true" />
                  <code>{c.id}</code>
                  <span className="check-msg">
                    {status === "idle" ? "Waiting" : status === "fail" ? c.open : c.done}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="timeline" data-ready={view.animated}>
            <div className="timeline-head">
              <span>Timeline</span>
              <output ref={readout}>00:03:10 f100</output>
            </div>
            <div
              className="timeline-track"
              ref={track}
              onPointerDown={onPointerDown}
              onPointerMove={(e) => scrubbing.current && scrubTo(e)}
              onPointerUp={() => {
                scrubbing.current = false;
              }}
              onPointerCancel={() => {
                scrubbing.current = false;
              }}
              role="slider"
              tabIndex={0}
              aria-label="Scrub the scene"
              aria-valuemin={0}
              aria-valuemax={SCENE.frames - 1}
              aria-valuenow={Math.round((frameClock.current / 1000) * SCENE.fps) % SCENE.frames}
              onKeyDown={(e) => {
                const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (!dir) return;
                e.preventDefault();
                const frame = Math.round((frameClock.current / 1000) * SCENE.fps) % SCENE.frames;
                const next = Math.min(
                  SCENE.frames - 1,
                  Math.max(0, frame + dir * (e.shiftKey ? 10 : 1)),
                );
                clock.current = Math.max(clock.current, (STEPS[LAST] as Step).at);
                stepRef.current = LAST;
                setStep(LAST);
                frameClock.current = (next / SCENE.fps) * 1000;
                show(next);
              }}
            >
              {TRACKS.map((t, i) => (
                <div key={t.name} className="clip-row" data-on={i < view.layers}>
                  <span className="clip-name">{t.name}</span>
                  <span
                    className="clip"
                    style={{
                      left: pct(t.start),
                      width: pct((view.animated ? out + 10 : SCENE.frames) - t.start),
                    }}
                  >
                    {view.animated && <i className="key" />}
                    {view.animated && <i className="key" style={{ left: "auto", right: -3 }} />}
                  </span>
                </div>
              ))}
              <div className="playhead" ref={playhead} aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
