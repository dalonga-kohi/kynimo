import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type KynimoApi } from "../shared/api.js";
import { mediaUrl } from "../shared/media-url.js";

const { version } = ipcRenderer.sendSync(CHANNELS.appInfo) as { version: string };

const subscribe = (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
  const listener = (_event: unknown, ...args: unknown[]) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.removeListener(channel, listener);
};

const api: KynimoApi = {
  app: { version, platform: process.platform },
  window: {
    minimize: () => void ipcRenderer.invoke(CHANNELS.minimize),
    toggleMaximize: () => void ipcRenderer.invoke(CHANNELS.toggleMaximize),
    close: () => void ipcRenderer.invoke(CHANNELS.close),
    onMaximizedChange: (callback) => {
      void ipcRenderer.invoke(CHANNELS.isMaximized).then((value) => callback(value === true));
      return subscribe(CHANNELS.maximized, (value) => callback(value === true));
    },
  },
  studio: {
    status: () => ipcRenderer.invoke(CHANNELS.status),
    listAnimations: () => ipcRenderer.invoke(CHANNELS.listAnimations),
    animation: (id) => ipcRenderer.invoke(CHANNELS.animation, id),
    thumbnailUrl: (id, v) => mediaUrl("thumb", id, v),
    previewUrl: (id, v) => mediaUrl("preview", id, v),
    exportVideo: (id, format) => ipcRenderer.invoke(CHANNELS.exportVideo, id, format),
    exportProgress: async (id) =>
      ((await ipcRenderer.invoke(CHANNELS.exportProgress, id)) as { progress: number } | null) ??
      undefined,
    stdioConfig: () => ipcRenderer.invoke(CHANNELS.stdioConfig),
    openProjectsFolder: () => ipcRenderer.invoke(CHANNELS.openProjectsFolder),
    markWelcomeSeen: () => ipcRenderer.invoke(CHANNELS.markWelcomeSeen),
    welcomeSeen: () => ipcRenderer.invoke(CHANNELS.welcomeSeen),
    onChanged: (callback) => subscribe(CHANNELS.changed, () => callback()),
  },
  clipboard: { writeText: (text) => ipcRenderer.send(CHANNELS.writeText, text) },
  openFeedback: () => ipcRenderer.invoke(CHANNELS.openFeedback),
  openStdioHelp: () => ipcRenderer.invoke(CHANNELS.openStdioHelp),
  openNotices: () => ipcRenderer.invoke(CHANNELS.openNotices),
};

contextBridge.exposeInMainWorld("kynimo", api);
