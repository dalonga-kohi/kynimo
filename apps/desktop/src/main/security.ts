import { pathToFileURL } from "node:url";

/** The page the window shows: the dev server in development, the built file otherwise. */
export interface AppLocation {
  /** `ELECTRON_RENDERER_URL` in development. */
  devUrl: string | undefined;
  /** The built `index.html`. */
  indexFile: string;
}

/** Whether `url` is the app's own page (any hash or query), so navigation may stay there. */
export function isAppUrl(url: string, location: AppLocation): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (location.devUrl !== undefined) {
    const dev = new URL(location.devUrl);
    return parsed.origin === dev.origin;
  }
  const index = pathToFileURL(location.indexFile);
  return parsed.protocol === "file:" && parsed.pathname === index.pathname;
}
