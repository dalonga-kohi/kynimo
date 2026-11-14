/** biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Packaging runs outside Turborepo. */
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtempDisposable, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import runtimes from "./runtime-lock.json" with { type: "json" };
import { download, fetchMedia, installChromium, sha256 } from "./runtimes.mjs";

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
  installChromium(browsers, process.env, playwright);

  const version = runtimes.node.version;
  const distribution = `node-v${version}-${windows ? "win-x64" : platform}`;
  const nodeArchive = `${distribution}.${windows ? "zip" : "tar.gz"}`;
  const nodeBinary = join(runtime, `node${suffix}`);
  const nodePath = windows ? "node.exe" : "bin/node";
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
    fetchMedia(media, platform, scratch),
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
