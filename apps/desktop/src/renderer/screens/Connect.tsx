import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AnimationSummary, StdioServerConfig, StudioStatus } from "../../shared/api.js";
import { CheckIcon, CopyIcon } from "../components/Icons.js";
import { Segmented } from "../components/Segmented.js";
import { useNow } from "../hooks/useNow.js";
import { type ClientId, clientSnippets } from "../lib/commands.js";
import { formatClock } from "../lib/format.js";
import "./Connect.css";

/** Cells in the waiting strip; one fills per second, then it starts over. */
export const STRIP_CELLS = 10;

interface ConnectProps {
  status: StudioStatus | undefined;
  animations: AnimationSummary[] | undefined;
  onOpenAnimations: () => void;
}

type StepState = "success" | "accent" | "danger" | "outline";

function Step({
  state,
  title,
  muted,
  children,
}: {
  state: StepState;
  title: string;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="step">
      <span className="step__mark">
        <span className={`step__diamond step__diamond--${state}`} />
      </span>
      <div className="step__text">
        <h3 className={`step__title${muted ? " step__title--muted" : ""}`}>{title}</h3>
        <p className={`step__sub${muted ? " step__sub--muted" : ""}`}>{children}</p>
      </div>
    </li>
  );
}

/** "One line to connect": the command for each client, and a live look at who has connected. */
export function Connect({ status, animations, onOpenAnimations }: ConnectProps) {
  const [clientId, setClientId] = useState<ClientId>("claude-code");
  const [copied, setCopied] = useState(false);
  const [stdio, setStdio] = useState<StdioServerConfig>();
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const now = useNow(1000);

  useEffect(() => {
    let live = true;
    window.kynimo.studio.stdioConfig().then(
      (config) => live && setStdio(config),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const endpoint = status?.endpoint ?? "";
  const snippets = clientSnippets(endpoint === "" ? "—" : endpoint, stdio);
  const snippet = snippets.find((s) => s.id === clientId) ?? snippets[0];
  const client = status?.client;
  const failed = status?.server === "failed";
  const running = status?.server === "running";
  const animationCount = animations?.length ?? 0;

  const copy = () => {
    if (snippet === undefined || snippet.code === "") return;
    window.kynimo.clipboard.writeText(snippet.code);
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const startedAt = status?.startedAt ?? now;
  const elapsedMs =
    client !== undefined && status?.firstRequestAt !== undefined
      ? status.firstRequestAt - startedAt
      : now - startedAt;
  const filled =
    client === undefined ? Math.floor(Math.max(0, elapsedMs) / 1000) % STRIP_CELLS : STRIP_CELLS;
  const percent = (filled / STRIP_CELLS) * 100;

  const step3: StepState =
    animationCount > 0 ? "success" : client === undefined ? "outline" : "accent";

  return (
    <div className="connect">
      <section className="connect__intro" aria-labelledby="connect-title">
        <h1 id="connect-title" className="connect__title display">
          One line to connect.
        </h1>
        <p className="connect__lede">
          Kynimo is already running on this machine. Add it to your MCP client, then ask for a video
          in plain words.
        </p>
        <ol className="connect__steps">
          <Step state={failed ? "danger" : running ? "success" : "outline"} title="Server running">
            {failed
              ? `Server stopped: ${status?.error ?? "it failed to start"}`
              : "Starts with the app. Nothing to install."}
          </Step>
          <Step
            state={client === undefined ? "accent" : "success"}
            title="Add Kynimo to your client"
          >
            Copy the line for your app on the right.
          </Step>
          <Step state={step3} title="Ask for a video" muted={step3 === "outline"}>
            {animationCount > 0 ? (
              <button type="button" className="step__link" onClick={onOpenAnimations}>
                Open Animations
              </button>
            ) : (
              "It shows up under Animations as soon as it's built."
            )}
          </Step>
        </ol>
      </section>

      <section className="connect__panel" aria-label="Connect a client">
        <Segmented
          kind="tabs"
          size="lg"
          label="Client"
          items={snippets.map((s) => ({ value: s.id, label: s.label }))}
          value={clientId}
          onChange={(id) => {
            setClientId(id);
            setCopied(false);
          }}
        />
        <div className="code">
          <p className="code__label">{snippet?.codeLabel}</p>
          <div className="code__row">
            <pre className="code__text selectable">{snippet?.code}</pre>
            <button type="button" className="code__copy" onClick={copy}>
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </div>

        <div className="listening">
          <div className="listening__head">
            <span
              className={`listening__dot${client === undefined ? " listening__dot--waiting" : ""}`}
            />
            <h2 className="listening__title">
              {client === undefined ? "Waiting for your agent" : `${client.name} connected`}
            </h2>
            <span className="listening__clock mono">{formatClock(elapsedMs)}</span>
          </div>
          <div className="listening__lane" data-testid="strip">
            <div className="listening__fill" style={{ width: `round(${percent}%, 1px)` }} />
            {client === undefined ? (
              <div className="listening__playhead" style={{ left: `${percent}%` }} />
            ) : null}
          </div>
          <div className="listening__try">
            <p className="listening__try-label">Once it connects, try</p>
            <p className="listening__prompt">
              “Make a ten-second title card that says{" "}
              <span className="listening__accent">Launch week</span>, in the Keynote style. Check
              the frames before you export.”
            </p>
          </div>
        </div>

        <dl className="facts">
          <div className="facts__cell facts__cell--endpoint">
            <dt>Endpoint</dt>
            <dd className="mono selectable">{endpoint === "" ? "—" : endpoint}</dd>
          </div>
          <div className="facts__cell facts__cell--projects">
            <dt>Projects</dt>
            <dd className="mono selectable">{status?.projectsDir ?? "—"}</dd>
          </div>
          <div className="facts__cell facts__cell--stdio">
            <dt>Client launches servers itself?</dt>
            <dd>
              <button
                type="button"
                className="link facts__link"
                onClick={() => void window.kynimo.openStdioHelp()}
              >
                Use stdio instead
              </button>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
