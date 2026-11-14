// Run as `Kynimo.exe <resources>/bridge.mjs` with ELECTRON_RUN_AS_NODE=1: a stdio MCP server
// that forwards to the running app, and starts the app when it is not running.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dataDir, endpointFile } from "../shared/paths.js";
import { runBridge } from "./bridge.js";

async function readEndpoint(): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(endpointFile(dataDir()), "utf8"));
    const endpoint = (parsed as { endpoint?: unknown } | null)?.endpoint;
    return typeof endpoint === "string" ? endpoint : undefined;
  } catch {
    return undefined;
  }
}

function launchApp(): void {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(process.execPath, [], { detached: true, stdio: "ignore", env }).unref();
}

await runBridge({
  lines: createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }),
  write: (line) => void process.stdout.write(`${line}\n`),
  log: (line) => void process.stderr.write(`kynimo bridge: ${line}\n`),
  readEndpoint,
  launchApp,
});
// Exit once the last reply is flushed; idle keep-alive connections would hold the process open.
process.stdout.write("", () => process.exit(0));
