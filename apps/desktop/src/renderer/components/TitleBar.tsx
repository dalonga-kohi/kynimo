import type { StudioStatus } from "../../shared/api.js";
import { HelpMenu } from "./HelpMenu.js";
import { Logo } from "./Icons.js";
import { Segmented } from "./Segmented.js";
import { ServerStatus } from "./ServerStatus.js";
import { WindowControls } from "./WindowControls.js";
import "./TitleBar.css";

export type Tab = "animations" | "connect";

const TABS = [
  { value: "animations", label: "Animations" },
  { value: "connect", label: "Connect" },
] as const;

interface TitleBarProps {
  /** `slim`: 40 px, no border (Welcome). `full`: the 52 px app bar with tabs and status. */
  variant: "slim" | "full";
  tab?: Tab;
  onTab?: (tab: Tab) => void;
  status?: StudioStatus | undefined;
  onAbout: () => void;
  onBuildNotes: () => void;
}

/** The custom title bar; the whole bar drags the window, controls and menus do not. */
export function TitleBar({ variant, tab, onTab, status, onAbout, onBuildNotes }: TitleBarProps) {
  const help = <HelpMenu onAbout={onAbout} onBuildNotes={onBuildNotes} />;
  if (variant === "slim")
    return (
      <header className="titlebar titlebar--slim drag">
        <div className="titlebar__lockup">
          <Logo width={15} height={14} style={{ color: "var(--color-text)" }} />
          <span className="titlebar__name">Kynimo</span>
        </div>
        <div className="titlebar__help">{help}</div>
        <div className="titlebar__spacer" />
        <WindowControls />
      </header>
    );
  return (
    <header className="titlebar titlebar--full drag">
      <div className="titlebar__side">
        <Logo width={18} height={16} style={{ color: "var(--color-text)" }} />
        <span className="titlebar__wordmark display">Kynimo</span>
        <span className="titlebar__beta">beta</span>
        <div className="titlebar__help titlebar__help--full">{help}</div>
      </div>
      <div className="titlebar__center">
        <Segmented
          kind="nav"
          label="Main"
          items={TABS}
          value={tab ?? "animations"}
          onChange={(t) => onTab?.(t)}
        />
      </div>
      <div className="titlebar__side titlebar__side--status">
        <ServerStatus status={status} />
      </div>
      <WindowControls />
    </header>
  );
}
