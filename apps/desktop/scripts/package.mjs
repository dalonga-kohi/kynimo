/** biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Packaging runs outside Turborepo. */
// Builds the Windows installer: apps/desktop/dist/Kynimo-Setup-<version>.exe, and the exact
// files it installs in dist/win-unpacked/. Run with: pnpm desktop:package
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, build, Platform } from "electron-builder";
import runtimes from "../../../scripts/local/runtime-lock.json" with { type: "json" };
import { fetchMedia, installChromium } from "../../../scripts/local/runtimes.mjs";
import config from "../electron-builder.config.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = join(desktop, "..", "..");
const stage = join(desktop, "build", "stage");
const cache = join(desktop, "build", "cache");
const platform = "win32-x64";
const pnpm = process.env.npm_execpath;

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
}
const runPnpm = (args) =>
  /\.[cm]?js$/i.test(pnpm) ? run(process.execPath, [pnpm, ...args]) : run(pnpm, args);

const exists = (file) =>
  readFile(file).then(
    () => true,
    () => false,
  );

/** FFmpeg and FFprobe with their notices, downloaded once per pinned release (SHA-verified). */
async function cachedMedia() {
  const dir = join(cache, "media");
  const marker = join(dir, ".complete");
  const tag = runtimes.ffmpeg.tag;
  const current = (await exists(marker)) && (await readFile(marker, "utf8")) === tag;
  if (!current) {
    const downloads = join(cache, "downloads");
    await rm(dir, { recursive: true, force: true });
    await rm(downloads, { recursive: true, force: true });
    await mkdir(downloads, { recursive: true });
    await fetchMedia(dir, platform, downloads);
    await rm(downloads, { recursive: true, force: true });
    await writeFile(marker, tag);
  }
  return dir;
}

/** The headless Chromium shell Playwright pins; the install is a no-op when it is already there. */
function cachedBrowsers(playwrightCli) {
  const dir = join(cache, "browsers");
  installChromium(dir, process.env, playwrightCli);
  return dir;
}

async function copyNotices(app, media, electronDist, browsers) {
  const notices = join(stage, "resources", "notices");
  const requireApp = createRequire(join(app, "package.json"));
  const playwrightCore = dirname(
    createRequire(requireApp.resolve("playwright/package.json")).resolve(
      "playwright-core/package.json",
    ),
  );
  const shell = (await readdir(browsers)).find((name) =>
    name.startsWith("chromium_headless_shell-"),
  );
  if (!shell) throw new Error(`No headless Chromium in ${browsers}`);
  const chromium = join(browsers, shell, "chrome-headless-shell-win64", "LICENSE.headless_shell");
  const files = [
    [join(media, "LICENSE.txt"), "FFmpeg-LICENSE.txt"],
    [join(media, "UPSTREAM.txt"), "FFmpeg-UPSTREAM.txt"],
    [join(playwrightCore, "LICENSE"), "Playwright-LICENSE.txt"],
    [join(playwrightCore, "NOTICE"), "Playwright-NOTICE.txt"],
    [chromium, "Chromium-headless-shell-LICENSE.txt"],
    [join(electronDist, "LICENSE"), "Electron-LICENSE.txt"],
    [join(electronDist, "LICENSES.chromium.html"), "Electron-Chromium-LICENSES.html"],
  ];
  await mkdir(notices, { recursive: true });
  for (const [from, name] of files) await cp(from, join(notices, name));
}

async function packageDesktop() {
  if (!pnpm) throw new Error("Run this script with pnpm desktop:package");
  const own = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  const electronVersion = own.devDependencies.electron;

  runPnpm(["turbo", "run", "build", "--filter=@kynimo/desktop..."]);

  await rm(stage, { recursive: true, force: true });
  await rm(join(desktop, "dist"), { recursive: true, force: true });
  await mkdir(join(stage, "resources"), { recursive: true });
  const app = join(stage, "app");
  // A flat production install: the files the installer ships, with no symlinks.
  runPnpm([
    "--filter",
    "@kynimo/desktop",
    "deploy",
    "--legacy",
    "--prod",
    "--node-linker=hoisted",
    app,
  ]);

  const requireApp = createRequire(join(app, "package.json"));
  const requireCapture = createRequire(requireApp.resolve("@kynimo/capture"));
  const playwrightCli = join(dirname(requireCapture.resolve("playwright/package.json")), "cli.js");

  const media = await cachedMedia();
  const browsers = cachedBrowsers(playwrightCli);
  await cp(media, join(stage, "resources", "media"), { recursive: true });
  await cp(browsers, join(stage, "resources", "browsers"), { recursive: true });
  const electronPackage = dirname(
    createRequire(join(desktop, "package.json")).resolve("electron/package.json"),
  );
  // Electron 45+ has no postinstall: install.js fetches the binary on demand (a no-op once present).
  run(process.execPath, [join(electronPackage, "install.js")]);
  const electronDist = join(electronPackage, "dist");
  await copyNotices(app, media, electronDist, browsers);

  await build({
    targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
    config: { ...config, electronVersion, electronDist },
    publish: "never",
  });
  process.stdout.write(`Installer: ${join(desktop, "dist", `Kynimo-Setup-${own.version}.exe`)}\n`);
}

await packageDesktop();
