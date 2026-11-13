import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export interface PathEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}

export const currentPathEnv = (): PathEnv => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
});

/** The per-user folder for projects, assets and exports; the same as scripts/local/launch.mjs. */
export function dataDir({ platform, home, env }: PathEnv = currentPathEnv()): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return win32.join(
      local && win32.isAbsolute(local) ? local : win32.join(home, "AppData", "Local"),
      "Kynimo",
    );
  }
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Kynimo");
  const xdg = env.XDG_DATA_HOME;
  return posix.join(
    xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".local", "share"),
    "kynimo",
  );
}

/** Where the desktop app keeps its own files inside the data folder. */
export const desktopDir = (dir: string): string => join(dir, "desktop");

/** The file the bridge reads to find the running app: `{ endpoint, port, pid }`. */
export const endpointFile = (dir: string): string => join(desktopDir(dir), "endpoint.json");

/** The data folder as shown to people: the Windows default reads as %LOCALAPPDATA%\Kynimo. */
export function displayDir(dir: string, pathEnv: PathEnv = currentPathEnv()): string {
  if (pathEnv.platform === "win32" && dir === dataDir(pathEnv)) return "%LOCALAPPDATA%\\Kynimo";
  return dir;
}
