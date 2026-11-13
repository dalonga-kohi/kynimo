import { useCallback, useEffect, useState } from "react";
import { BuildNotes } from "./components/BuildNotes.js";
import { type Tab, TitleBar } from "./components/TitleBar.js";
import { useStudio } from "./hooks/useStudio.js";
import { Animations } from "./screens/Animations.js";
import { Connect } from "./screens/Connect.js";
import { Player } from "./screens/Player.js";
import { Welcome } from "./screens/Welcome.js";

export type Screen = "welcome" | "connect" | "animations" | "player";

/** Where the app starts, when something (the browser mock) decides it. */
export interface Initial {
  screen: Screen;
  animationId?: string;
}

export function App({ initial }: { initial?: Initial }) {
  const { status, animations, refresh } = useStudio();
  const [screen, setScreen] = useState<Screen | undefined>(initial?.screen);
  const [playerId, setPlayerId] = useState<string | undefined>(initial?.animationId);
  const [notesOpen, setNotesOpen] = useState(false);

  // First launch decides the starting screen, once the animations are known. While the server
  // is still starting it cannot say whether the welcome was seen: ask again when its state changes.
  const server = status?.server;
  useEffect(() => {
    if (screen !== undefined || animations === undefined) return;
    let live = true;
    window.kynimo.studio.welcomeSeen().then(
      (seen) => {
        if (live) setScreen(!seen ? "welcome" : animations.length > 0 ? "animations" : "connect");
      },
      () => {
        if (live && server === "failed") setScreen("connect");
      },
    );
    return () => {
      live = false;
    };
  }, [screen, animations, server]);

  // Entering a screen shows fresh data.
  // biome-ignore lint/correctness/useExhaustiveDependencies: screen is the trigger
  useEffect(() => refresh(), [screen, refresh]);

  const closeNotes = useCallback(() => setNotesOpen(false), []);
  const go = (next: Screen) => setScreen(next);
  const openPlayer = (id: string) => {
    setPlayerId(id);
    setScreen("player");
  };
  const tab: Tab = screen === "connect" ? "connect" : "animations";

  const bar = (
    <TitleBar
      variant={screen === "welcome" || screen === undefined ? "slim" : "full"}
      tab={tab}
      onTab={go}
      status={status}
      onAbout={() => go("welcome")}
      onBuildNotes={() => setNotesOpen(true)}
    />
  );

  return (
    <>
      {bar}
      {screen === undefined ? null : (
        <main className="view" key={screen === "player" ? `player-${playerId}` : screen}>
          {screen === "welcome" ? (
            <Welcome
              status={status}
              onBuildNotes={() => setNotesOpen(true)}
              onConnect={() => {
                void window.kynimo.studio.markWelcomeSeen().catch(() => undefined);
                go("connect");
              }}
            />
          ) : screen === "connect" ? (
            <Connect
              status={status}
              animations={animations}
              onOpenAnimations={() => go("animations")}
            />
          ) : screen === "animations" ? (
            <Animations
              animations={animations}
              status={status}
              onOpen={openPlayer}
              onConnect={() => go("connect")}
            />
          ) : playerId === undefined ? null : (
            <Player id={playerId} onBack={() => go("animations")} />
          )}
        </main>
      )}
      {notesOpen ? <BuildNotes version={window.kynimo.app.version} onClose={closeNotes} /> : null}
    </>
  );
}
