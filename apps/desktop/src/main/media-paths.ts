import { join } from "node:path";
import type { MediaPaths } from "../shared/protocol.js";

/**
 * Where the host finds FFmpeg and Chromium. In development, nothing: the server uses the PATH's
 * FFmpeg and Playwright's default browsers. A packaged app carries its own in its resources
 * folder (media/ffmpeg.exe, media/ffprobe.exe, browsers/), put there by the installer build.
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

/** The folder with the third-party licence notices; only a packaged app has one. */
export function noticesDir(
  app: { isPackaged: boolean },
  resourcesPath: string = process.resourcesPath,
): string | undefined {
  return app.isPackaged ? join(resourcesPath, "notices") : undefined;
}

/**
 * The server settings that point at those files. Main puts them in the server process' own
 * environment, so they are in place before Playwright is loaded (it reads its browsers folder
 * once, at load) and win over whatever the launching environment says.
 */
export function mediaEnv(media: MediaPaths): Record<string, string> {
  const env: Record<string, string> = {};
  if (media.ffmpeg !== undefined) env.KYNIMO_FFMPEG = media.ffmpeg;
  if (media.ffprobe !== undefined) env.KYNIMO_FFPROBE = media.ffprobe;
  if (media.browsers !== undefined) env.PLAYWRIGHT_BROWSERS_PATH = media.browsers;
  return env;
}
