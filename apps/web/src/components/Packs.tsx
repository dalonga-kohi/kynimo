"use client";

import { useMemo, useRef } from "react";
import { DEFAULT_CAPTION, DEFAULT_TITLE, PACK_LOOKS, SCENE, type SceneState } from "@/lib/scene";
import { SceneCanvas, type SceneCanvasHandle } from "./SceneCanvas";
import { usePlayback } from "./usePlayback";

type Pack = (typeof PACK_LOOKS)[number];

function PackScene({ pack, offset }: { pack: Pack; offset: number }) {
  const root = useRef<HTMLElement>(null);
  const canvas = useRef<SceneCanvasHandle>(null);
  // Each pack starts a little later than the one before, so the four never move in lockstep.
  const clock = useRef(-offset);

  const state = useMemo<SceneState>(
    () => ({
      look: pack,
      title: DEFAULT_TITLE,
      caption: DEFAULT_CAPTION,
      layers: 4,
      animated: true,
      fixed: true,
      echoes: false,
    }),
    [pack],
  );

  const moving = usePlayback(root, (delta) => {
    clock.current += delta;
    const frame = Math.floor((Math.max(0, clock.current) / 1000) * SCENE.fps) % SCENE.frames;
    canvas.current?.draw(frame);
  });

  return (
    <figure
      className="pack"
      ref={root}
      style={{ "--pack-accent": pack.accent } as React.CSSProperties}
    >
      <div className="pack-screen">
        <SceneCanvas
          ref={canvas}
          state={moving ? state : { ...state, animated: false }}
          label={`The same scene in the ${pack.name} pack.`}
        />
      </div>
      <figcaption>
        <span className="pack-name">
          <i aria-hidden="true" />
          {pack.name}
        </span>
        <p>{pack.summary}</p>
        <code>{pack.tokens}</code>
      </figcaption>
    </figure>
  );
}

/** The same scene in all four draft packs at once. */
export function Packs() {
  return (
    <div className="packs">
      {PACK_LOOKS.map((pack, i) => (
        <PackScene key={pack.id} pack={pack} offset={i * 260} />
      ))}
    </div>
  );
}
