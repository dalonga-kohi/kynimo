import type {
  AnimationDetail,
  AnimationSummary,
  ExportFormat,
  KynimoApi,
  StudioStatus,
} from "../../shared/api.js";
import type { Initial } from "../App.js";

/** The mock's "now": the demo content never ages. 2026-11-13 12:00 UTC. */
export const MOCK_NOW = Date.UTC(2026, 10, 13, 12, 0, 0);

export interface MockScenario {
  screen: "welcome" | "connect" | "animations" | "player" | "empty";
  /** Whether an agent has already connected. */
  client: "none" | "claude";
  maximized: boolean;
}

const SCREENS: readonly MockScenario["screen"][] = [
  "welcome",
  "connect",
  "animations",
  "player",
  "empty",
];

/** `?screen=…&client=none|claude&maximized=1`. */
export function parseScenario(search: string): MockScenario {
  const q = new URLSearchParams(search);
  const screen = SCREENS.find((s) => s === q.get("screen")) ?? "animations";
  return {
    screen,
    client: q.get("client") === "claude" ? "claude" : "none",
    maximized: q.get("maximized") === "1",
  };
}

/** Where the app starts for a scenario. */
export function initialFor(scenario: MockScenario): Initial {
  if (scenario.screen === "player") return { screen: "player", animationId: NIMBUS_ID };
  return { screen: scenario.screen === "empty" ? "animations" : scenario.screen };
}

const id = (n: number): string => `p-${n.toString(16).padStart(32, "0")}`;
const MIN = 60_000;
const HOUR = 3_600_000;

export const NIMBUS_ID = id(2);

/** The six animations of the Animations board, newest first. */
export const MOCK_ANIMATIONS: AnimationSummary[] = [
  {
    id: id(1),
    name: "Launch week title card",
    version: 3,
    durationSec: 6,
    width: 1920,
    height: 1080,
    fps: 30,
    layerCount: 3,
    style: "keynote",
    createdBy: "Claude Code",
    createdAt: MOCK_NOW - 20 * MIN,
    updatedAt: MOCK_NOW - 10_000,
    activity: { kind: "rendering", progress: 0.62 },
  },
  {
    id: NIMBUS_ID,
    name: "Nimbus 2 product reveal",
    version: 5,
    durationSec: 12,
    width: 1920,
    height: 1080,
    fps: 30,
    layerCount: 4,
    style: "keynote",
    createdBy: "Codex",
    createdAt: MOCK_NOW - 3 * HOUR,
    updatedAt: MOCK_NOW - 2 * HOUR - 5 * MIN,
  },
  {
    id: id(3),
    name: "Friday deploys promo",
    version: 2,
    durationSec: 8,
    width: 1920,
    height: 1080,
    fps: 30,
    layerCount: 5,
    style: "neon",
    createdBy: "Claude Code",
    createdAt: MOCK_NOW - 31 * HOUR,
    updatedAt: MOCK_NOW - 30 * HOUR,
  },
  {
    id: id(4),
    name: "Essay opener, issue 14",
    version: 4,
    durationSec: 15,
    width: 1920,
    height: 1080,
    fps: 30,
    layerCount: 4,
    style: "editorial",
    createdBy: "Cursor",
    createdAt: Date.UTC(2026, 10, 11, 12),
    updatedAt: Date.UTC(2026, 10, 11, 12),
  },
  {
    id: id(5),
    name: "Black Friday bumper",
    version: 1,
    durationSec: 6,
    width: 1920,
    height: 1080,
    fps: 30,
    layerCount: 3,
    style: "brutalist",
    createdBy: "Claude Code",
    createdAt: Date.UTC(2026, 10, 10, 12),
    updatedAt: Date.UTC(2026, 10, 10, 12),
  },
  {
    id: id(6),
    name: "Q3 numbers for the all-hands",
    version: 2,
    durationSec: 17,
    width: 1920,
    height: 1080,
    fps: 30,
    layerCount: 6,
    style: "swiss",
    createdBy: "Codex",
    createdAt: Date.UTC(2026, 10, 8, 12),
    updatedAt: Date.UTC(2026, 10, 8, 12),
  },
];

/** Bars and keys of the Player board, in seconds of a 12 s animation. */
const NIMBUS_LAYERS: AnimationDetail["layers"] = [
  { id: "l-background", name: "background", start: 0, end: 12, keyTimes: [] },
  { id: "l-glow", name: "glow", start: 0.5, end: 7.6, keyTimes: [0.5, 7.6] },
  { id: "l-title", name: "title", start: 1.95, end: 11.65, keyTimes: [1.95, 3.25] },
  { id: "l-subtitle", name: "subtitle", start: 3.55, end: 11.65, keyTimes: [3.55] },
];

function detailOf(a: AnimationSummary): AnimationDetail {
  const layers =
    a.id === NIMBUS_ID
      ? NIMBUS_LAYERS
      : ["background", "title", "subtitle"].map((name, i) => ({
          id: `l-${name}`,
          name,
          start: i * 0.5,
          end: a.durationSec,
          keyTimes: [i * 0.5, i * 0.5 + 1],
        }));
  const { activity: _activity, ...rest } = a;
  return {
    ...rest,
    compositionId: a.id === NIMBUS_ID ? "nimbus-reveal" : "main",
    layerCount: layers.length,
    layers: [...layers],
  };
}

/** A `window.kynimo` that answers with the design's demo content. No Electron needed. */
export function createMockApi(scenario: MockScenario): KynimoApi {
  let maximized = scenario.maximized;
  let welcomeSeen = scenario.screen !== "welcome";
  const maxListeners = new Set<(m: boolean) => void>();
  const changed = new Set<() => void>();
  const connected =
    scenario.client === "claude" ||
    scenario.screen === "animations" ||
    scenario.screen === "player";
  // Nothing built yet: first launch, and the Connect board while it waits.
  const empty =
    scenario.screen === "empty" ||
    scenario.screen === "welcome" ||
    (scenario.screen === "connect" && !connected);
  const animations = empty ? [] : MOCK_ANIMATIONS;
  const exportStarts = new Map<string, number>();

  const status = (): StudioStatus => ({
    server: "running",
    endpoint: "http://127.0.0.1:8787/mcp",
    port: 8787,
    dataDir: "C:\\Users\\you\\AppData\\Local\\Kynimo",
    projectsDir: "%LOCALAPPDATA%\\Kynimo",
    startedAt: MOCK_NOW - (connected ? 3 * MIN : 14_000),
    ...(connected
      ? {
          client: { name: "Claude Code", lastSeenAt: MOCK_NOW - 5_000 },
          firstRequestAt: MOCK_NOW - 2 * MIN,
        }
      : {}),
  });

  const noop = () => undefined;
  return {
    app: { version: "0.1.0", platform: "win32" },
    window: {
      minimize: noop,
      close: noop,
      toggleMaximize: () => {
        maximized = !maximized;
        for (const l of maxListeners) l(maximized);
      },
      onMaximizedChange: (callback) => {
        maxListeners.add(callback);
        callback(maximized);
        return () => void maxListeners.delete(callback);
      },
    },
    studio: {
      status: async () => status(),
      listAnimations: async () => animations,
      animation: async (animationId) => {
        const found = MOCK_ANIMATIONS.find((a) => a.id === animationId);
        return found === undefined ? null : detailOf(found);
      },
      thumbnailUrl: (animationId, version) => `mock://thumb/${animationId}/${version}`,
      previewUrl: (animationId, version) => `mock://preview/${animationId}/${version}`,
      exportVideo: async (animationId: string, _format: ExportFormat) => {
        exportStarts.set(animationId, Date.now());
        await new Promise((resolve) => setTimeout(resolve, 2500));
        exportStarts.delete(animationId);
        return { status: "saved", file: "C:\\Users\\you\\Videos\\export.mp4" };
      },
      exportProgress: async (animationId) => {
        const started = exportStarts.get(animationId);
        return started === undefined
          ? undefined
          : { progress: Math.min(1, (Date.now() - started) / 2400) };
      },
      openProjectsFolder: async () => undefined,
      stdioConfig: async () => ({
        command: "C:\\Users\\you\\AppData\\Local\\Programs\\Kynimo\\Kynimo.exe",
        args: ["C:\\Users\\you\\AppData\\Local\\Programs\\Kynimo\\resources\\bridge.mjs"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      }),
      markWelcomeSeen: async () => {
        welcomeSeen = true;
      },
      welcomeSeen: async () => welcomeSeen,
      onChanged: (callback) => {
        changed.add(callback);
        return () => void changed.delete(callback);
      },
    },
    clipboard: { writeText: (text) => void navigator.clipboard?.writeText(text).catch(noop) },
    openFeedback: async () => undefined,
    openStdioHelp: async () => undefined,
  };
}
