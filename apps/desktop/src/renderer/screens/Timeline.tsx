import { type PointerEvent, useRef } from "react";
import type { AnimationLayerRow } from "../../shared/api.js";

/** Width of the layer-name column, in px: the lane starts after it. */
export const LABEL_WIDTH = 128;

interface TimelineProps {
  layers: readonly AnimationLayerRow[];
  duration: number;
  time: number;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  /** Called with a position in seconds while the pointer is down in the track area. */
  onSeek: (seconds: number) => void;
}

const pct = (value: number, total: number): number =>
  total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;

/** One row per layer: its span as a bar, its keyframes as diamonds, one playhead across all. */
export function Timeline({ layers, duration, time, selected, onSelect, onSeek }: TimelineProps) {
  const rows = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const seekFrom = (e: PointerEvent<HTMLDivElement>): boolean => {
    const box = rows.current?.getBoundingClientRect();
    if (box === undefined) return false;
    const x = e.clientX - box.left - LABEL_WIDTH;
    if (x < 0 && !dragging.current) return false;
    const width = box.width - LABEL_WIDTH;
    if (width <= 0) return false;
    onSeek(Math.min(1, Math.max(0, x / width)) * duration);
    return true;
  };

  const playhead = pct(time, duration) / 100;

  return (
    <div
      ref={rows}
      className="timeline"
      onPointerDown={(e) => {
        if (e.button !== 0 || !seekFrom(e)) return;
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragging.current) seekFrom(e);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      {layers.map((layer) => (
        <div key={layer.id} className="row" data-selected={layer.id === selected}>
          <button
            type="button"
            className="row__label mono"
            aria-pressed={layer.id === selected}
            title={layer.name}
            onClick={() => onSelect(layer.id === selected ? undefined : layer.id)}
          >
            {layer.name}
          </button>
          <div className="row__lane">
            <span
              className="row__bar"
              style={{
                left: `${pct(layer.start, duration)}%`,
                width: `${pct(layer.end, duration) - pct(layer.start, duration)}%`,
              }}
            />
            {layer.keyTimes.map((t) => (
              <span
                key={t}
                className="row__key"
                style={{ left: `calc(${pct(t, duration)}% - 3px)` }}
              />
            ))}
          </div>
        </div>
      ))}
      <div
        className="timeline__playhead"
        data-testid="playhead"
        style={{ left: `calc(${LABEL_WIDTH}px + (100% - ${LABEL_WIDTH}px) * ${playhead})` }}
      >
        <span className="timeline__flag" />
      </div>
    </div>
  );
}
