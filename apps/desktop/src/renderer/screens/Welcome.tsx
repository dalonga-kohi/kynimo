import type { StudioStatus } from "../../shared/api.js";
import { ArrowRightIcon, K_PATH } from "../components/Icons.js";
import "./Welcome.css";

interface WelcomeProps {
  status: StudioStatus | undefined;
  onConnect: () => void;
  onBuildNotes: () => void;
}

const NOTES = [
  {
    frame: "f000",
    title: "Runs on this machine",
    body: "No account, no cloud. Your projects stay on your disk.",
  },
  {
    frame: "f030",
    title: "Your agent does the work",
    body: "Connect Claude, Codex or Cursor. Ask for a video.",
  },
  {
    frame: "f060",
    title: "Tell us what breaks",
    body: "Every report shapes the next build. Send feedback from the menu.",
  },
] as const;

/** Left offsets and opacities of the five copies of the K that make the bars. */
const BARS = [
  { left: 0, opacity: 0.1, color: "var(--color-text)" },
  { left: 72, opacity: 0.18, color: "var(--color-text)" },
  { left: 128, opacity: 0.3, color: "var(--color-text)" },
  { left: 168, opacity: 0.5, color: "var(--color-text)" },
  { left: 196, opacity: 1, color: "var(--color-accent)" },
] as const;

/** First launch: thank-you, three notes, and the way on to Connect. */
export function Welcome({ status, onConnect, onBuildNotes }: WelcomeProps) {
  const version = window.kynimo.app.version;
  return (
    <div className="welcome">
      <div className="welcome__body">
        <div className="welcome__copy">
          <p className="welcome__eyebrow mono">
            <span className="welcome__dot" />
            <span>PRIVATE BETA · BUILD {version}</span>
          </p>
          <h1 className="welcome__title display">
            You're early.
            <br />
            Thank you.
          </h1>
          <p className="welcome__lede">
            Kynimo is in private beta, and you're one of the first people to run it. It works, it's
            fast, and some edges are still rough. Things will change every week.
          </p>
          <ul className="welcome__notes">
            {NOTES.map((note) => (
              <li key={note.frame} className="welcome__note">
                <span className="welcome__frame mono">{note.frame}</span>
                <h2 className="welcome__note-title">{note.title}</h2>
                <p className="welcome__note-body">{note.body}</p>
              </li>
            ))}
          </ul>
          <div className="welcome__actions">
            <button type="button" className="btn btn--primary" onClick={onConnect}>
              Connect your agent
              <ArrowRightIcon />
            </button>
            <button type="button" className="welcome__secondary" onClick={onBuildNotes}>
              What's in this build
            </button>
          </div>
        </div>
        <div className="welcome__hero" aria-hidden="true">
          {BARS.map((bar, i) => (
            <div
              key={bar.left}
              className="welcome__bar"
              style={{ left: bar.left, animationDelay: `${i * 40}ms` }}
            >
              <svg
                aria-hidden="true"
                width="220"
                height="200"
                viewBox="0 0 132 120"
                style={{ opacity: bar.opacity }}
              >
                <path d={K_PATH} fill={bar.color} />
              </svg>
            </div>
          ))}
          <span className="welcome__hero-label mono" style={{ left: 0 }}>
            f000
          </span>
          <span
            className="welcome__hero-label welcome__hero-label--focus mono"
            style={{ left: 196 }}
          >
            f120 · in focus
          </span>
        </div>
      </div>
      <footer className="welcome__footer">
        <span className="welcome__path mono selectable">
          Projects live in {status?.projectsDir ?? "%LOCALAPPDATA%\\Kynimo"}
        </span>
        <span className="welcome__once">
          This note shows once. Find it again under Help → About the beta.
        </span>
      </footer>
    </div>
  );
}
