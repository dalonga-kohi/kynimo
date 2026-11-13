/** biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Packaging runs outside Turborepo. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtempDisposable, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import runtimes from "./runtime-lock.json" with { type: "json" };

const root = fileURLToPath(new URL("../..", import.meta.url));
const platform = `${process.platform}-${process.arch}`;
const windows = process.platform === "win32";
const suffix = windows ? ".exe" : "";
const label = `kynimo-${platform}`;
const out = join(root, "build", "local");
const pnpm = process.env.npm_execpath;

function run(command, args, env = process.env) {
  execFileSync(command, args, { cwd: root, env, stdio: "inherit" });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function download(url, file, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(response.body, createWriteStream(file, { flags: "wx" }));
  const actual = await sha256(file);
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${url}: ${actual}`);
}

async function packageLocal() {
  if (!runtimes.node[platform] || !runtimes.ffmpeg[platform])
    throw new Error(`Unsupported platform: ${platform}`);
  if (!pnpm) throw new Error("Run this script with pnpm local:package");

  await mkdir(out, { recursive: true });
  await using staging = await mkdtempDisposable(join(out, "stage-"));
  const scratch = staging.path;
  const bundle = join(scratch, label);
  const app = join(bundle, "app");
  const runtime = join(bundle, "runtime");
  const media = join(bundle, "media");
  const browsers = join(bundle, "browsers");
  await Promise.all([mkdir(runtime, { recursive: true }), mkdir(media, { recursive: true })]);

  const runPnpm = (args) =>
    /\.[cm]?js$/i.test(pnpm) ? run(process.execPath, [pnpm, ...args]) : run(pnpm, args);
  runPnpm(["turbo", "run", "build", "--filter=@kynimo/mcp"]);
  // A flat production install is portable across archive tools, including Windows Explorer.
  runPnpm([
    "--filter",
    "@kynimo/mcp",
    "deploy",
    "--legacy",
    "--prod",
    "--node-linker=hoisted",
    app,
  ]);
  const requireApp = createRequire(join(app, "package.json"));
  const requireCapture = createRequire(requireApp.resolve("@kynimo/capture"));
  const playwright = join(dirname(requireCapture.resolve("playwright/package.json")), "cli.js");
  run(process.execPath, [playwright, "install", "--only-shell", "chromium"], {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsers,
  });

  const version = runtimes.node.version;
  const distribution = `node-v${version}-${windows ? "win-x64" : platform}`;
  const nodeArchive = `${distribution}.${windows ? "zip" : "tar.gz"}`;
  const nodeBinary = join(runtime, `node${suffix}`);
  const nodePath = windows ? "node.exe" : "bin/node";
  const ffmpegUrl = `https://github.com/eugeneware/ffmpeg-static/releases/download/${runtimes.ffmpeg.tag}`;
  const mediaFiles = [
    [`ffmpeg-${platform}.gz`, `ffmpeg${suffix}`, true],
    [`ffprobe-${platform}.gz`, `ffprobe${suffix}`, true],
    [`${platform}.LICENSE`, "LICENSE.txt", false],
    [`${platform}.README`, "UPSTREAM.txt", false],
  ];
  // Wait for every writer before disposing of the staging directory on a failed download.
  const downloads = await Promise.allSettled([
    (async () => {
      const archive = join(scratch, nodeArchive);
      await download(
        `https://nodejs.org/dist/v${version}/${nodeArchive}`,
        archive,
        runtimes.node[platform],
      );
      run("tar", [
        "-xf",
        archive,
        "-C",
        scratch,
        `${distribution}/${nodePath}`,
        `${distribution}/LICENSE`,
      ]);
      await rename(join(scratch, distribution, nodePath), nodeBinary);
      await rename(join(scratch, distribution, "LICENSE"), join(runtime, "LICENSE.txt"));
    })(),
    ...mediaFiles.map(async ([asset, name, compressed], index) => {
      const target = join(media, name);
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
  ]);
  const failed = downloads.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;

  const launcher = windows ? "kynimo.cmd" : "kynimo";
  for (const name of [launcher, "launch.mjs", "README.md"])
    await copyFile(fileURLToPath(new URL(name, import.meta.url)), join(bundle, name));
  if (!windows) await chmod(join(bundle, launcher), 0o755);

  const archiveName = `${label}.${windows ? "zip" : "tar.gz"}`;
  const archive = join(scratch, archiveName);
  run("tar", ["-a", "-cf", archive, "-C", scratch, label]);
  const result = join(out, archiveName);
  await rename(archive, result);
  process.stdout.write(`${result}\nSHA-256 ${await sha256(result)}\n`);
}

await packageLocal();
