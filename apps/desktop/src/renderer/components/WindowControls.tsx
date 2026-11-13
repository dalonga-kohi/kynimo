import { useEffect, useState } from "react";
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from "./Icons.js";

/** Minimize, maximize or restore, close: 46 px slots the height of the bar. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => window.kynimo.window.onMaximizedChange(setMaximized), []);
  const win = window.kynimo.window;
  return (
    <div className="winctl no-drag">
      <button
        type="button"
        className="winctl__btn"
        aria-label="Minimize"
        onClick={() => win.minimize()}
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        className="winctl__btn"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => win.toggleMaximize()}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className="winctl__btn winctl__btn--close"
        aria-label="Close"
        onClick={() => win.close()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
