import { type CSSProperties, useEffect, useState } from "react";
import type { AnimationSummary, StudioStatus } from "../shared/api.js";

// A placeholder: plain text only. The real screens replace it.
const dragRegion = { WebkitAppRegion: "drag" } as CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties;

export function App() {
  const [status, setStatus] = useState<StudioStatus>();
  const [animations, setAnimations] = useState<AnimationSummary[]>([]);
  const [maximized, setMaximized] = useState(false);
  const { kynimo } = window;

  useEffect(() => window.kynimo.window.onMaximizedChange(setMaximized), []);
  useEffect(() => {
    const { studio } = window.kynimo;
    const load = () => {
      void studio.status().then(setStatus);
      void studio.listAnimations().then(setAnimations, () => setAnimations([]));
    };
    load();
    return studio.onChanged(load);
  }, []);

  return (
    <div style={{ color: "#eee", fontFamily: "sans-serif", padding: 0 }}>
      <div style={{ ...dragRegion, display: "flex", justifyContent: "space-between", padding: 8 }}>
        <span>
          Kynimo {kynimo.app.version} ({kynimo.app.platform})
        </span>
        <span style={noDrag}>
          <button type="button" onClick={() => kynimo.window.minimize()}>
            Minimize
          </button>
          <button type="button" onClick={() => kynimo.window.toggleMaximize()}>
            {maximized ? "Restore" : "Maximize"}
          </button>
          <button type="button" onClick={() => kynimo.window.close()}>
            Close
          </button>
        </span>
      </div>
      <pre style={{ padding: 8 }}>
        {status ? `server: ${status.server}` : "loading"}
        {status?.endpoint ? `\nendpoint: ${status.endpoint}` : ""}
        {status?.error ? `\nerror: ${status.error}` : ""}
        {status ? `\nprojects: ${status.projectsDir}` : ""}
        {status?.client ? `\nclient: ${status.client.name}` : ""}
        {`\n\nanimations: ${animations.length}`}
        {animations.map(
          (a) =>
            `\n${a.name} v${a.version} ${a.durationSec}s ${a.width}x${a.height} ${a.fps}fps ${a.layerCount} layers${a.createdBy ? ` by ${a.createdBy}` : ""}${a.activity ? ` [${a.activity.kind}]` : ""}`,
        )}
      </pre>
    </div>
  );
}
