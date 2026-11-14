/** biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This entry point runs outside Turborepo. */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL(".", import.meta.url));
const usage = `Kynimo local MCP server

  Start the server and connect a local client to http://127.0.0.1:8787/mcp.

  --stdio       Use stdin/stdout for a client that starts its own server.
  --port <n>    Change the loopback HTTP port (default: 8787).
  --dir <path>  Override the per-user directory for projects, assets and exports.
  --help        Show this help.`;

function dataDir() {
  const home = homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return join(local && isAbsolute(local) ? local : join(home, "AppData", "Local"), "Kynimo");
  }
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Kynimo");
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "kynimo");
}

async function launch() {
  const { values } = parseArgs({
    options: {
      stdio: { type: "boolean" },
      port: { type: "string" },
      dir: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (values.stdio && values.port !== undefined) throw new Error("--port requires HTTP mode");
  if (values.dir === "") throw new Error("--dir must be a path");
  if (values.port !== undefined && !/^\d+$/.test(values.port))
    throw new Error("--port must be an integer from 0 to 65535");

  // The bundle supplies its own cloud settings (none), media paths and HTTP port.
  for (const key of Object.keys(process.env)) {
    const name = key.toUpperCase();
    if (name.startsWith("KYNIMO_") || name === "PORT" || name === "PLAYWRIGHT_BROWSERS_PATH")
      delete process.env[key];
  }
  const suffix = process.platform === "win32" ? ".exe" : "";
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(root, "browsers");
  process.env.KYNIMO_FFMPEG = join(root, "media", `ffmpeg${suffix}`);
  process.env.KYNIMO_FFPROBE = join(root, "media", `ffprobe${suffix}`);

  const args = ["--dir", resolve(values.dir ?? dataDir())];
  if (!values.stdio)
    args.push("--http", "--no-auth", "--host", "127.0.0.1", "--port", values.port ?? "8787");
  process.argv.splice(2, process.argv.length, ...args);
  await import(new URL("./app/dist/main.js", import.meta.url).href);
}

try {
  await launch();
} catch (error) {
  process.stderr.write(`kynimo: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
