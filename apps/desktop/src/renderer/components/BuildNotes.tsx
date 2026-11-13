import { useEffect, useId, useRef } from "react";
import { BUILD_NOTES } from "../build-notes.js";
import { CloseIcon } from "./Icons.js";
import "./BuildNotes.css";

/** The modal behind "What's in this build". Esc, the close button and the backdrop close it. */
export function BuildNotes({ version, onClose }: { version: string; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        // The close button is the only control: keep focus on it.
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="notes__backdrop"
      role="presentation"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="notes selectable" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button
          ref={closeRef}
          type="button"
          className="notes__close"
          aria-label="Close"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        <p className="notes__eyebrow mono">BUILD {version}</p>
        <h2 id={titleId} className="notes__title display">
          What's in this build
        </h2>
        <ul className="notes__list">
          {BUILD_NOTES.highlights.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <h3 className="notes__sub">Known rough edges</h3>
        <ul className="notes__list">
          {BUILD_NOTES.roughEdges.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
