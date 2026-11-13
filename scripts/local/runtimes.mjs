/** biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Packaging runs outside Turborepo. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtempDisposable } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import runtimes from "./runtime-lock.json" with { type: "json" };

export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Downloads `url` to `file` (which must not exist) and checks its SHA-256. */
export async function download(url, file, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(response.body, createWriteStream(file, { flags: "wx" }));
  const actual = await sha256(file);
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${url}: ${actual}`);
}

/**
 * Downloads FFmpeg and FFprobe for `platform` ("win32-x64", ...) into `destDir`, with the
 * upstream licence and notice files (LICENSE.txt, UPSTREAM.txt). Each file is checked against
 * runtime-lock.json. `scratchDir` holds the compressed downloads; default: a temporary folder
 * that is removed afterwards.
 */
export async function fetchMedia(destDir, platform, scratchDir) {
  if (!runtimes.ffmpeg[platform]) throw new Error(`Unsupported platform: ${platform}`);
  const suffix = platform.startsWith("win32") ? ".exe" : "";
  const ffmpegUrl = `https://github.com/eugeneware/ffmpeg-static/releases/download/${runtimes.ffmpeg.tag}`;
  const mediaFiles = [
    [`ffmpeg-${platform}.gz`, `ffmpeg${suffix}`, true],
    [`ffprobe-${platform}.gz`, `ffprobe${suffix}`, true],
    [`${platform}.LICENSE`, "LICENSE.txt", false],
    [`${platform}.README`, "UPSTREAM.txt", false],
  ];
  await mkdir(destDir, { recursive: true });
  await using own = scratchDir
    ? undefined
    : await mkdtempDisposable(join(tmpdir(), "kynimo-media-"));
  const scratch = scratchDir ?? own.path;
  // Wait for every writer before the caller disposes of the scratch directory on a failure.
  const downloads = await Promise.allSettled(
    mediaFiles.map(async ([asset, name, compressed], index) => {
      const target = join(destDir, name);
      const file = compressed ? join(scratch, asset) : target;
      await download(`${ffmpegUrl}/${asset}`, file, runtimes.ffmpeg[platform][index]);
      if (compressed) {
        await pipeline(
          createReadStream(file),
          createGunzip(),
          createWriteStream(target, { mode: 0o755 }),
        );
      }
    }),
  );
  const failed = downloads.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

/** playwright's cli.js as the workspace resolves it (through @kynimo/capture). */
function workspacePlaywrightCli() {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const requireMcp = createRequire(join(root, "apps", "mcp", "package.json"));
  const requireCapture = createRequire(requireMcp.resolve("@kynimo/capture"));
  return join(dirname(requireCapture.resolve("playwright/package.json")), "cli.js");
}

/**
 * Installs the headless Chromium shell Playwright uses into `browsersDir`. `playwrightCli` is
 * the path of playwright's cli.js; default: the workspace's own.
 */
export function installChromium(browsersDir, env = process.env, playwrightCli) {
  execFileSync(
    process.execPath,
    [playwrightCli ?? workspacePlaywrightCli(), "install", "--only-shell", "chromium"],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...env, PLAYWRIGHT_BROWSERS_PATH: browsersDir },
      stdio: "inherit",
    },
  );
}
