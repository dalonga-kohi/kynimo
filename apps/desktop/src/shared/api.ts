/** The typed surface the renderer sees as `window.kynimo`. Plain JSON only. */

export type ServerState = "starting" | "running" | "failed";

export interface StudioStatus {
  server: ServerState;
  error?: string;
  endpoint?: string;
  port?: number;
  dataDir: string;
  /** For display: "%LOCALAPPDATA%\\Kynimo" when it is the default folder, else the real path. */
  projectsDir: string;
  /** The client with the most recent request since the server started. */
  client?: { name: string; lastSeenAt: number };
  firstRequestAt?: number;
  startedAt: number;
}

export type AnimationActivity =
  | { kind: "rendering"; progress: number }
  | { kind: "checking"; client: string };

export interface AnimationSummary {
  id: string;
  name: string;
  version: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  layerCount: number;
  style?: string;
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
  activity?: AnimationActivity;
}

/** One top-level layer, in seconds. */
export interface AnimationLayerRow {
  id: string;
  name: string;
  start: number;
  end: number;
  keyTimes: number[];
}

export interface AnimationDetail extends AnimationSummary {
  /** The id of the main composition. */
  compositionId: string;
  layers: AnimationLayerRow[];
}

export type ExportFormat = "mp4" | "webm" | "gif";

export type ExportOutcome =
  | { status: "saved"; file: string }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

export interface KynimoApi {
  app: { version: string; platform: string };
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    /** Called with the current state right away and on every change. Returns an unsubscribe. */
    onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  };
  studio: {
    status(): Promise<StudioStatus>;
    listAnimations(): Promise<AnimationSummary[]>;
    animation(id: string): Promise<AnimationDetail | null>;
    /** `kynimo-media://thumb/<id>/<version>`; the file is rendered on first request. */
    thumbnailUrl(id: string, version: number): string;
    /** `kynimo-media://preview/<id>/<version>`; the clip is rendered on first request. */
    previewUrl(id: string, version: number): string;
    /** Renders, asks where to save, copies. */
    exportVideo(id: string, format: ExportFormat): Promise<ExportOutcome>;
    /** Progress (0 to 1) of an export this app started for the animation; undefined when none runs. */
    exportProgress(id: string): Promise<{ progress: number } | undefined>;
    openProjectsFolder(): Promise<void>;
    /** What a stdio MCP client launches: the bridge in this app. */
    stdioConfig(): Promise<StdioServerConfig>;
    markWelcomeSeen(): Promise<void>;
    welcomeSeen(): Promise<boolean>;
    /** Returns an unsubscribe. */
    onChanged(callback: () => void): () => void;
  };
  clipboard: { writeText(text: string): void };
  openFeedback(): Promise<void>;
  openStdioHelp(): Promise<void>;
}

/** The `kynimo` entry of an MCP client config that starts the stdio bridge. */
export interface StdioServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** IPC channel names shared by preload and main. */
export const CHANNELS = {
  minimize: "window:minimize",
  toggleMaximize: "window:toggle-maximize",
  close: "window:close",
  maximized: "window:maximized",
  isMaximized: "window:is-maximized",
  status: "studio:status",
  listAnimations: "studio:list-animations",
  animation: "studio:animation",
  exportVideo: "studio:export-video",
  exportProgress: "studio:export-progress",
  stdioConfig: "studio:stdio-config",
  openProjectsFolder: "studio:open-projects-folder",
  markWelcomeSeen: "studio:mark-welcome-seen",
  welcomeSeen: "studio:welcome-seen",
  changed: "studio:changed",
  writeText: "clipboard:write-text",
  openFeedback: "app:open-feedback",
  openStdioHelp: "app:open-stdio-help",
  appInfo: "app:info",
} as const;
