import { copyFile, mkdir } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  shell,
  utilityProcess,
} from "electron";
import { CHANNELS, type ExportFormat, type ExportOutcome } from "../shared/api.js";
import { MEDIA_SCHEME, parseMediaUrl } from "../shared/media-url.js";
import { dataDir, desktopDir } from "../shared/paths.js";
import type { HostInit } from "../shared/protocol.js";
import { feedbackUrl, isFeedbackUrl, sanitizeFileName, stdioConfig } from "./external.js";
import { HostClient } from "./host-client.js";
import { mediaPaths } from "./media-paths.js";
import { type AppLocation, isAppUrl } from "./security.js";
import { loadWindowState, MIN_SIZE, saveWindowState, type WindowState } from "./window-state.js";

app.setName("Kynimo");
// Before ready: the scheme the renderer loads thumbnails and previews through.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

const DATA_DIR = dataDir();
const FEEDBACK_ERROR = "Kynimo could not open the page.";
const location: AppLocation = {
  devUrl: process.env.ELECTRON_RENDERER_URL,
  indexFile: join(import.meta.dirname, "../renderer/index.html"),
};

let window: BrowserWindow | undefined;
let host: HostClient | undefined;
let quitting = false;

/** Starts the utility process that runs the server, and resolves once it is up. */
async function startHost(): Promise<HostClient> {
  const child = utilityProcess.fork(join(import.meta.dirname, "host.mjs"), [], {
    serviceName: "Kynimo server",
    env: { ...process.env },
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("exit", (code) => reject(new Error(`the server process exited (${code})`)));
  });
  const init: HostInit = { type: "init", dataDir: DATA_DIR, media: mediaPaths(app) };
  child.postMessage(init);
  const client = new HostClient({
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on("message", listener),
    onExit: (listener) => void child.once("exit", () => listener()),
    kill: () => void child.kill(),
  });
  client.onEvent(() => window?.webContents.send(CHANNELS.changed));
  return client;
}

function createWindow(state: WindowState): BrowserWindow {
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x === undefined || state.y === undefined ? {} : { x: state.x, y: state.y }),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    frame: false,
    backgroundColor: "#0C0B0A",
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.once("ready-to-show", () => {
    if (state.maximized) win.maximize();
    win.show();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url, location)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const tell = () => win.webContents.send(CHANNELS.maximized, win.isMaximized());
  win.on("maximize", tell);
  win.on("unmaximize", tell);
  if (location.devUrl !== undefined) void win.loadURL(location.devUrl);
  else void win.loadFile(location.indexFile);
  return win;
}

/** Remembers the window's bounds and maximized state in `window.json`. */
function rememberWindow(win: BrowserWindow, file: string): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    if (win.isDestroyed()) return;
    const { x, y, width, height } = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    void saveWindowState(file, { x, y, width, height, maximized: win.isMaximized() }).catch(
      () => undefined,
    );
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on("resize", later);
  win.on("move", later);
  win.on("maximize", later);
  win.on("unmaximize", later);
  win.on("close", save);
}

/** The window a trusted message came from; messages from any other page are ignored. */
function senderWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | undefined {
  const url = event.senderFrame?.url;
  if (url === undefined || !isAppUrl(url, location)) return undefined;
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

function requireHost(): HostClient {
  if (host === undefined) throw new Error("the server is not available");
  return host;
}

/** Renders the animation, asks where to put it, copies it there. */
async function exportVideo(win: BrowserWindow, id: string, format: ExportFormat) {
  const client = requireHost();
  const started = await client.request("exportVideo", { id, format });
  if ("error" in started) return { status: "failed", error: started.error } as const;
  for (;;) {
    const result = await client.request("exportResult", { jobId: started.jobId });
    if (result.state === "failed" || result.state === "cancelled")
      return { status: "failed", error: result.error ?? "the export was cancelled" } as const;
    if (result.state === "succeeded" && result.file !== undefined) {
      const detail = await client.request("animation", { id });
      const choice = await dialog.showSaveDialog(win, {
        title: "Save video",
        defaultPath: join(
          app.getPath("videos"),
          `${sanitizeFileName(detail?.name ?? "animation")}.${format}`,
        ),
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (choice.canceled || choice.filePath === "") return { status: "cancelled" } as const;
      await copyFile(result.file, choice.filePath);
      return { status: "saved", file: choice.filePath } as const;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function registerIpc(): void {
  const trusted =
    <A extends unknown[], R>(fn: (win: BrowserWindow, ...args: A) => R) =>
    (event: IpcMainInvokeEvent, ...args: A): R => {
      const win = senderWindow(event);
      if (win === undefined) throw new Error("untrusted sender");
      return fn(win, ...args);
    };

  ipcMain.handle(
    CHANNELS.minimize,
    trusted((win) => win.minimize()),
  );
  ipcMain.handle(
    CHANNELS.toggleMaximize,
    trusted((win) => (win.isMaximized() ? win.unmaximize() : win.maximize())),
  );
  ipcMain.handle(
    CHANNELS.close,
    trusted((win) => win.close()),
  );
  ipcMain.handle(
    CHANNELS.isMaximized,
    trusted((win) => win.isMaximized()),
  );

  ipcMain.handle(
    CHANNELS.status,
    trusted(() => requireHost().request("status")),
  );
  ipcMain.handle(
    CHANNELS.listAnimations,
    trusted(() => requireHost().request("listAnimations")),
  );
  ipcMain.handle(
    CHANNELS.animation,
    trusted((_win, id: unknown) => requireHost().request("animation", { id: String(id) })),
  );
  ipcMain.handle(
    CHANNELS.exportVideo,
    trusted(async (win, id: unknown, format: unknown): Promise<ExportOutcome> => {
      if (format !== "mp4" && format !== "webm" && format !== "gif")
        return { status: "failed", error: "unknown format" };
      try {
        return await exportVideo(win, String(id), format);
      } catch (e) {
        return { status: "failed", error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  ipcMain.handle(
    CHANNELS.openProjectsFolder,
    trusted(async () => {
      await shell.openPath(DATA_DIR);
    }),
  );
  ipcMain.handle(
    CHANNELS.markWelcomeSeen,
    trusted(async () => {
      await requireHost().request("markWelcomeSeen");
    }),
  );
  ipcMain.handle(
    CHANNELS.welcomeSeen,
    trusted(() => requireHost().request("welcomeSeen")),
  );
  ipcMain.handle(
    CHANNELS.openFeedback,
    trusted(async () => {
      const status = await requireHost()
        .request("status")
        .catch(() => ({ server: "failed" as const, error: "the server is not available" }));
      const url = feedbackUrl({
        appVersion: app.getVersion(),
        osVersion: release(),
        status,
      });
      // Only the new-issue page of this project is ever opened outside the app.
      if (isFeedbackUrl(url)) await shell.openExternal(url);
      else throw new Error(FEEDBACK_ERROR);
    }),
  );
  ipcMain.handle(
    CHANNELS.openStdioHelp,
    trusted(async (win) => {
      const bridge = app.isPackaged
        ? join(process.resourcesPath, "bridge.mjs")
        : join(import.meta.dirname, "bridge.mjs");
      const config = stdioConfig(process.execPath, bridge);
      const { response } = await dialog.showMessageBox(win, {
        type: "info",
        title: "Use stdio instead",
        message: "For clients that start their own MCP server",
        detail: `Add this to the client's MCP settings. It launches a bridge that connects to this app (and starts it when it is closed).\n\n${config}`,
        buttons: ["Copy config", "Close"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) clipboard.writeText(config);
    }),
  );
  ipcMain.on(CHANNELS.writeText, (event, text: unknown) => {
    if (senderWindow(event) !== undefined && typeof text === "string")
      clipboard.writeText(text.slice(0, 100_000));
  });
  ipcMain.on(CHANNELS.appInfo, (event) => {
    event.returnValue = senderWindow(event) ? { version: app.getVersion() } : { version: "" };
  });
}

/** `kynimo-media://thumb|preview/<id>/<version>`: asks the host for the file; never reads a path from the URL. */
function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const media = parseMediaUrl(request.url);
    if (media === undefined) return new Response("Not found", { status: 404 });
    try {
      const result = await requireHost().request(media.kind === "thumb" ? "thumbnail" : "preview", {
        id: media.id,
      });
      if ("error" in result) return new Response(result.error, { status: 500 });
      // net.fetch serves the file with Range support, which video playback needs.
      return await net.fetch(pathToFileURL(result.path).toString(), {
        headers: request.headers,
        bypassCustomProtocolHandlers: true,
      });
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
    }
  });
}

async function boot(): Promise<void> {
  app.setAppUserModelId("app.kynimo.desktop");
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  const own = desktopDir(DATA_DIR);
  await mkdir(own, { recursive: true });
  const stateFile = join(own, "window.json");
  const state = await loadWindowState(
    stateFile,
    screen.getAllDisplays().map((d) => d.workArea),
  );
  registerIpc();
  registerMediaProtocol();
  try {
    host = await startHost();
  } catch (e) {
    process.stderr.write(`kynimo: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  window = createWindow(state);
  rememberWindow(window, stateFile);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    // Ask the host to close its server (5 s at most), then kill it.
    void (host?.stop() ?? Promise.resolve()).finally(() => app.exit(0));
  });
  void app.whenReady().then(boot);
}
