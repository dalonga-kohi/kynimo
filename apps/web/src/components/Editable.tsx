"use client";

import { useMemo, useRef, useState } from "react";
import { DEFAULT_CAPTION, DEFAULT_TITLE, KYNIMO_LOOK, SCENE, type SceneState } from "@/lib/scene";
import { SceneCanvas, type SceneCanvasHandle } from "./SceneCanvas";
import { usePlayback } from "./usePlayback";

const ACCENTS = [
  ["Marquee yellow", "#f5c842"],
  ["Signal red", "#ef6a4c"],
  ["Leaf green", "#8dc48a"],
  ["Sky blue", "#8ec1ff"],
  ["Screen white", "#ede8df"],
] as const;

const MS_PER_FRAME = 1000 / SCENE.fps;

/** Type in the scene, recolour it, retime it. Each change is shown as the operation it is. */
export function Editable() {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<SceneCanvasHandle>(null);
  const clock = useRef(0);
  const [title, setTitle] = useState<string>(DEFAULT_TITLE);
  const [accent, setAccent] = useState<string>(ACCENTS[0][1]);
  const [stagger, setStagger] = useState<number>(KYNIMO_LOOK.stagger);

  const state = useMemo<SceneState>(
    () => ({
      look: KYNIMO_LOOK,
      title,
      caption: DEFAULT_CAPTION,
      accent,
      stagger,
      layers: 4,
      animated: true,
      fixed: true,
      echoes: true,
    }),
    [title, accent, stagger],
  );

  const moving = usePlayback(root, (delta) => {
    clock.current += delta;
    canvas.current?.draw(Math.floor((clock.current / 1000) * SCENE.fps) % SCENE.frames);
  });

  /** Replay from just before the edited layer comes in. */
  const replay = (frame: number) => {
    clock.current = frame * MS_PER_FRAME;
  };

  const ops = [
    { changed: title !== DEFAULT_TITLE, layer: "title", set: `"text": ${JSON.stringify(title)}` },
    { changed: accent !== ACCENTS[0][1], layer: "mark", set: `"fill": "${accent}"` },
    {
      changed: stagger !== KYNIMO_LOOK.stagger,
      layer: "title",
      set: `"stagger": ${Math.round(stagger * MS_PER_FRAME)}`,
    },
  ];
  const changed = ops.filter((op) => op.changed);

  return (
    <div className="edit" ref={root}>
      <div className="edit-view">
        <div className="viewer">
          <SceneCanvas
            ref={canvas}
            state={moving ? state : { ...state, animated: false }}
            label={`The scene with the title ${title}`}
          />
        </div>
      </div>

      <div className="edit-panel">
        <label className="field-row">
          <span>Title</span>
          <input
            type="text"
            value={title}
            maxLength={40}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setTitle(e.target.value);
              replay(26);
            }}
          />
        </label>

        <fieldset className="field-row">
          <legend>Accent</legend>
          <div className="swatches">
            {ACCENTS.map(([name, value]) => (
              <label key={value} className="swatch" style={{ color: value }}>
                <input
                  type="radio"
                  name="accent"
                  value={value}
                  checked={accent === value}
                  onChange={() => {
                    setAccent(value);
                    replay(0);
                  }}
                />
                <span className="sr-only">{name}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="field-row">
          <span>
            Stagger <output>{Math.round(stagger * MS_PER_FRAME)} ms</output>
          </span>
          <input
            type="range"
            min={0}
            max={9}
            step={1}
            value={stagger}
            onChange={(e) => {
              setStagger(Number(e.target.value));
              replay(0);
            }}
          />
        </label>

        <div className="ops" aria-live="polite">
          <div className="ops-head">
            <code>apply_ops</code>
            <span>
              {changed.length === 0
                ? "No changes yet"
                : `${changed.length} ${changed.length === 1 ? "operation" : "operations"} · 0 frames regenerated`}
            </span>
          </div>
          <pre>
            <code>
              {changed.length === 0
                ? "[ ]"
                : `[\n${changed
                    .map(
                      (op) =>
                        `  { "op": "updateLayer", "layer": "${op.layer}",\n    "set": { ${op.set} } }`,
                    )
                    .join(",\n")}\n]`}
            </code>
          </pre>
          <p className="fineprint">Simplified. The real operations carry versions and ids.</p>
        </div>
      </div>
    </div>
  );
}
