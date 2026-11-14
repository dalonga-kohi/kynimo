import type { Initial } from "../App.js";
import { setClock } from "../lib/clock.js";
import { setOverrides } from "../lib/overrides.js";
import {
  createMockApi,
  initialFor,
  MOCK_ANIMATIONS,
  MOCK_NOW,
  NIMBUS_ID,
  parseScenario,
} from "./api.js";
import {
  BlackFridayArt,
  EssayArt,
  FridayArt,
  LaunchWeekArt,
  NimbusPlayerArt,
  NimbusThumbArt,
  Q3Art,
} from "./artworks.js";

/** The artwork of each animation, in the order of `MOCK_ANIMATIONS`. */
const THUMBS = [LaunchWeekArt, NimbusThumbArt, FridayArt, EssayArt, BlackFridayArt, Q3Art];

/** Puts the mock in place of the missing `window.kynimo`; returns where the app starts. */
export function installMock(search: string): Initial {
  const scenario = parseScenario(search);
  window.kynimo = createMockApi(scenario);
  setClock(() => MOCK_NOW);
  setOverrides({
    artwork: (animationId, kind) => {
      if (kind === "player") return animationId === NIMBUS_ID ? <NimbusPlayerArt /> : undefined;
      const Art = THUMBS[MOCK_ANIMATIONS.findIndex((a) => a.id === animationId)];
      return Art === undefined ? undefined : <Art />;
    },
    player: { time: 4.4, playing: true, selectedLayer: "l-title" },
  });
  return initialFor(scenario);
}
