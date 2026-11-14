import { useCallback, useEffect, useRef, useState } from "react";
import type { AnimationDetail, ExportFormat } from "../../shared/api.js";
import { Dropdown } from "../components/Dropdown.js";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  PauseIcon,
  PlayIcon,
} from "../components/Icons.js";
import { Pill } from "../components/Pill.js";
import { now } from "../lib/clock.js";
import {
  formatTimecode,
  lengthLabel,
  packColor,
  prettyPack,
  relativeTime,
  sizeLabel,
} from "../lib/format.js";
import { overrides } from "../lib/overrides.js";
import "./Player.css";
import { Timeline } from "./Timeline.js";

interface PlayerProps {
  id: string;
  onBack: () => void;
}

type ExportState =
  | { kind: "idle" }
  | { kind: "exporting"; progress: number }
  | { kind: "saved" }
  | { kind: "failed"; message: string };

/** Keys that belong to a text field or a menu are not the player's. */
const ownsKeys = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, select, [role="menu"], [contenteditable="true"]') !== null;

/** The quote in "Want a change?": it names the second layer when there is one. */
const quote = (detail: AnimationDetail): string => {
  const second = detail.layers[1]?.name;
  return `“Bring the ${second ?? "subtitle"} in half a second later.”`;
};

export function Player({ id, onBack }: PlayerProps) {
  const [detail, setDetail] = useState<AnimationDetail | null>();
  const preset = overrides().player;
  const artwork = overrides().artwork?.(id, "player");
  const [playing, setPlaying] = useState(preset?.playing ?? false);
  const [time, setTime] = useState(preset?.time ?? 0);
  const [ready, setReady] = useState(false);
  const [broken, setBroken] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(preset?.selectedLayer);
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const video = useRef<HTMLVideoElement>(null);
  const mounted = useRef(true);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(() => {
    window.kynimo.studio.animation(id).then(
      (d) => mounted.current && setDetail(d),
      () => mounted.current && setDetail((old) => old ?? null),
    );
  }, [id]);

  useEffect(() => {
    mounted.current = true;
    load();
    const off = window.kynimo.studio.onChanged(load);
    return () => {
      mounted.current = false;
      off();
      clearTimeout(savedTimer.current);
    };
  }, [load]);

  // A new version is a new file: wait for it again.
  const version = detail?.version;
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the trigger
  useEffect(() => {
    setReady(false);
    setBroken(false);
  }, [version]);

  const fps = detail?.fps ?? 30;
  const duration = detail?.durationSec ?? 0;

  const seek = useCallback(
    (seconds: number) => {
      const at = Math.min(duration, Math.max(0, seconds));
      if (video.current !== null) video.current.currentTime = at;
      setTime(at);
    },
    [duration],
  );

  const toggle = useCallback(() => {
    const el = video.current;
    if (el === null) {
      setPlaying((p) => !p);
      return;
    }
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, []);

  // While playing, the playhead follows the video frame by frame.
  useEffect(() => {
    if (!playing || video.current === null) return;
    let frame = 0;
    const tick = () => {
      if (video.current !== null) setTime(video.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || ownsKeys(e.target)) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (e.key === " ") {
        // A focused button turns Space into its own click.
        if (target?.closest("button, a")) return;
        e.preventDefault();
        toggle();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !playing) {
        e.preventDefault();
        const current = video.current?.currentTime ?? time;
        seek(current + (e.key === "ArrowRight" ? 1 : -1) / fps);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seek, playing, time, fps]);

  const startExport = (format: ExportFormat) => {
    clearTimeout(savedTimer.current);
    setExportState({ kind: "exporting", progress: 0 });
    const poll = setInterval(() => {
      window.kynimo.studio.exportProgress(id).then(
        (p) => {
          if (p !== undefined && mounted.current)
            setExportState((s) =>
              s.kind === "exporting" ? { kind: "exporting", progress: p.progress } : s,
            );
        },
        () => undefined,
      );
    }, 500);
    window.kynimo.studio.exportVideo(id, format).then(
      (outcome) => {
        clearInterval(poll);
        if (!mounted.current) return;
        if (outcome.status === "saved") {
          setExportState({ kind: "saved" });
          savedTimer.current = setTimeout(() => setExportState({ kind: "idle" }), 2000);
        } else if (outcome.status === "failed") {
          setExportState({ kind: "failed", message: outcome.error });
        } else {
          setExportState({ kind: "idle" });
        }
      },
      (e: unknown) => {
        clearInterval(poll);
        if (mounted.current)
          setExportState({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
      },
    );
  };

  if (detail === undefined) return <div className="player" aria-busy="true" />;
  if (detail === null)
    return (
      <div className="player">
        <Breadcrumb name="Not found" onBack={onBack} />
        <p className="player__missing">This animation is no longer available.</p>
      </div>
    );

  const { studio } = window.kynimo;
  const exporting = exportState.kind === "exporting";
  const made = [
    detail.createdBy === undefined ? undefined : `Made by ${detail.createdBy}`,
    relativeTime(detail.updatedAt, now()),
  ]
    .filter((p) => p !== undefined)
    .join(" · ");

  return (
    <div className="player">
      <Breadcrumb name={detail.name} onBack={onBack} />
      <div className="player__body">
        <section className="stage" aria-label="Preview">
          <div className="stage__screen">
            {artwork !== undefined ? (
              artwork
            ) : (
              <>
                {ready ? null : (
                  <img
                    className="stage__poster"
                    src={studio.thumbnailUrl(id, detail.version)}
                    alt=""
                  />
                )}
                {/* biome-ignore lint/a11y/useMediaCaption: the preview has no audio */}
                <video
                  key={detail.version}
                  ref={video}
                  className="stage__video"
                  data-ready={ready}
                  src={studio.previewUrl(id, detail.version)}
                  preload="auto"
                  playsInline
                  onCanPlay={() => setReady(true)}
                  onError={() => setBroken(true)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                  onSeeked={(e) => setTime(e.currentTarget.currentTime)}
                />
                {ready ? null : (
                  <Pill className="stage__pill">
                    {broken ? "Preview unavailable" : "Preparing preview…"}
                  </Pill>
                )}
              </>
            )}
          </div>
          <div className="stage__controls">
            <div className="transport">
              <button
                type="button"
                className="transport__play"
                aria-label={playing ? "Pause" : "Play"}
                onClick={toggle}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <span className="transport__id mono selectable">{detail.compositionId}</span>
              <span className="transport__spacer" />
              <span className="transport__time mono">
                <span className="transport__now">{formatTimecode(time, fps)}</span> /{" "}
                {formatTimecode(duration, fps)}
              </span>
            </div>
            <Timeline
              layers={detail.layers}
              duration={duration}
              time={time}
              selected={selected}
              onSelect={setSelected}
              onSeek={seek}
            />
          </div>
        </section>

        <aside className="side">
          <h1 className="side__title display">{detail.name}</h1>
          {made === "" ? null : <p className="side__made">{made}</p>}
          <div className="side__actions">
            <button
              type="button"
              className={`btn btn--primary export${exporting ? " export--busy" : ""}`}
              disabled={exporting}
              onClick={() => startExport("mp4")}
            >
              {exportState.kind === "exporting" ? (
                <span
                  className="export__fill"
                  style={{ width: `${Math.round(exportState.progress * 100)}%` }}
                />
              ) : null}
              {exportState.kind === "saved" ? <CheckIcon /> : exporting ? null : <DownloadIcon />}
              <span className="export__label">
                {exporting ? "Exporting…" : exportState.kind === "saved" ? "Saved" : "Export MP4"}
              </span>
            </button>
            <Dropdown
              label="More formats"
              align="right"
              disabled={exporting}
              triggerClassName="more"
              trigger={
                <>
                  WebM, GIF
                  <ChevronDownIcon />
                </>
              }
              items={[
                { key: "webm", label: "WebM", onSelect: () => startExport("webm") },
                { key: "gif", label: "GIF", onSelect: () => startExport("gif") },
              ]}
            />
          </div>
          {exportState.kind === "failed" ? (
            <p className="side__error" role="alert">
              {exportState.message}
            </p>
          ) : null}

          <dl className="info">
            <div className="info__row">
              <dt>Style</dt>
              <dd className="info__style">
                <span className="info__dot" style={{ background: packColor(detail.style) }} />
                {prettyPack(detail.style)}
              </dd>
            </div>
            <div className="info__row">
              <dt>Length</dt>
              <dd className="mono">{lengthLabel(detail.durationSec)}</dd>
            </div>
            <div className="info__row">
              <dt>Size</dt>
              <dd className="mono">{sizeLabel(detail.width, detail.height, detail.fps)}</dd>
            </div>
            <div className="info__row">
              <dt>Layers</dt>
              <dd className="info__count">{detail.layerCount}</dd>
            </div>
          </dl>

          <section className="change" aria-labelledby="change-title">
            <h2 id="change-title" className="change__title">
              Want a change?
            </h2>
            <p className="change__body">
              Ask your agent. Every layer and key stays editable, so only what you name moves.
            </p>
            <p className="change__quote selectable">{quote(detail)}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Breadcrumb({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <nav className="crumb" aria-label="Breadcrumb">
      <button
        type="button"
        className="crumb__back"
        aria-label="Back to Animations"
        onClick={onBack}
      >
        <ArrowLeftIcon />
      </button>
      <button type="button" className="crumb__link" onClick={onBack}>
        Animations
      </button>
      <span className="crumb__sep" aria-hidden="true">
        /
      </span>
      <span className="crumb__current" aria-current="page">
        {name}
      </span>
    </nav>
  );
}
