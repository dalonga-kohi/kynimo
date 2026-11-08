#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { KynimoService } from "./service.js";
import { FileStore, MemoryStore } from "./store.js";

const USAGE = `kynimo-mcp — Kynimo MCP server over stdio

  --dir <path>    Keep projects as JSON files in this folder (default: in memory, lost on exit)
  --actor <id>    Actor id for undo history and idempotency keys (default: "local")
  --help          Show this help`;

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    actor: { type: "string", default: "local" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  // stdout is the MCP channel only when serving; --help never serves.
  process.stdout.write(`${USAGE}\n`);
} else if (values.actor.length < 1 || values.actor.length > 100) {
  process.stderr.write("--actor must be 1 to 100 characters\n");
  process.exitCode = 2;
} else {
  const fileStore = values.dir
    ? await FileStore.open(resolve(values.dir)).catch((e: unknown) => {
        process.stderr.write(`kynimo-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
      })
    : undefined;
  const store = fileStore ?? new MemoryStore();
  if (fileStore) {
    const release = () => {
      void fileStore.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", release);
    process.once("SIGTERM", release);
    process.stdin.once("end", release);
  }
  const server = createServer(new KynimoService(store, values.actor));
  await server.connect(new StdioServerTransport());
  // Logs go to stderr: stdout carries the protocol.
  process.stderr.write(
    `kynimo-mcp ready (${values.dir ? `projects in ${resolve(values.dir)}` : "in-memory projects"})\n`,
  );
}
