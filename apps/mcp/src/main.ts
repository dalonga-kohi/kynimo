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
} else {
  const store = values.dir ? new FileStore(resolve(values.dir)) : new MemoryStore();
  const server = createServer(new KynimoService(store, values.actor));
  await server.connect(new StdioServerTransport());
  // Logs go to stderr: stdout carries the protocol.
  process.stderr.write(
    `kynimo-mcp ready (${values.dir ? `projects in ${resolve(values.dir)}` : "in-memory projects"})\n`,
  );
}
