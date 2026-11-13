import { join } from "node:path";
import type { MediaPaths } from "../shared/protocol.js";

/**
 * Where the host finds FFmpeg and Chromium. In development, nothing: the server uses the PATH's
 * FFmpeg and Playwright's default browsers. A packaged app carries its own, next to the app
 * (the layout scripts/local/launch.mjs uses); the installer step decides the final names.
 */
export function mediaPaths(
  app: { isPackaged: boolean },
  resourcesPath: string = process.resourcesPath,
  platform: NodeJS.Platform = process.platform,
): MediaPaths {
  if (!app.isPackaged) return {};
  const suffix = platform === "win32" ? ".exe" : "";
  return {
    ffmpeg: join(resourcesPath, "media", `ffmpeg${suffix}`),
    ffprobe: join(resourcesPath, "media", `ffprobe${suffix}`),
    browsers: join(resourcesPath, "browsers"),
  };
}
