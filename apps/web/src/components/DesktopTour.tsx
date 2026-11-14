"use client";

import Image from "next/image";
import { useState } from "react";

/** Screenshots of the desktop app's own screens (apps/desktop, demo content), 2560 × 1600. */
const SCREENS = [
  {
    id: "connect",
    tab: "Connect",
    src: "/desktop/connect.png",
    alt: "Kynimo's Connect screen: the local MCP address with a ready command for Claude Code, Codex, Cursor and Claude Desktop, and a panel waiting for an agent.",
  },
  {
    id: "animations",
    tab: "Animations",
    src: "/desktop/animations.png",
    alt: "Kynimo's Animations screen: six scenes made by different agents, one of them still rendering.",
  },
  {
    id: "player",
    tab: "Player",
    src: "/desktop/player.png",
    alt: "Kynimo's player: a product reveal playing above its timeline of four layers, with an Export MP4 button.",
  },
] as const;

/** The desktop app, shown as it is: three of its screens behind a small switcher. */
export function DesktopTour() {
  const [current, setCurrent] = useState(0);

  return (
    <div className="desktop-tour">
      <div className="tour-tabs" role="tablist" aria-label="Screens of the desktop app">
        {SCREENS.map((screen, i) => (
          <button
            key={screen.id}
            type="button"
            role="tab"
            id={`tour-tab-${screen.id}`}
            aria-selected={i === current}
            aria-controls="tour-panel"
            tabIndex={i === current ? 0 : -1}
            className="tour-tab"
            onClick={() => setCurrent(i)}
            onKeyDown={(event) => {
              const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (move === 0) return;
              event.preventDefault();
              const next = (i + move + SCREENS.length) % SCREENS.length;
              setCurrent(next);
              document.getElementById(`tour-tab-${SCREENS[next]?.id}`)?.focus();
            }}
          >
            {screen.tab}
          </button>
        ))}
      </div>
      <div
        className="tour-window"
        role="tabpanel"
        id="tour-panel"
        aria-labelledby={`tour-tab-${SCREENS[current]?.id}`}
      >
        {SCREENS.map((screen, i) => (
          <Image
            key={screen.id}
            className="tour-shot"
            data-current={i === current}
            src={screen.src}
            alt={i === current ? screen.alt : ""}
            aria-hidden={i === current ? undefined : true}
            width={2560}
            height={1600}
            sizes="(max-width: 1240px) 100vw, 1144px"
            priority={false}
          />
        ))}
      </div>
    </div>
  );
}
