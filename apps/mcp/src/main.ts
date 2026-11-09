#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CaptureRenderer } from "./render.js";
import { createServer } from "./server.js";
import { KynimoService } from "./service.js";
import { FileStore, MemoryStore, type ProjectStore } from "./store.js";
import { connectPostgres, type Database, PostgresStore } from "./store-postgres.js";

const USAGE = `kynimo-mcp — Kynimo MCP server over stdio

  --dir <path>    Keep projects as JSON files in this folder (default: in memory, lost on exit)
  --actor <id>    Actor id for undo history and idempotency keys (default: "local")
  --help          Show this help

Environment:
  KYNIMO_DATABASE_URL   Keep projects in Postgres (postgres://…), shared by any number of
                        server processes. Not combinable with --dir.`;

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
  const fail = (e: unknown): never => {
    process.stderr.write(`kynimo-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  };
  const databaseUrl = process.env.KYNIMO_DATABASE_URL || undefined;
  if (databaseUrl && values.dir) fail("use either --dir or KYNIMO_DATABASE_URL, not both");
  let store: ProjectStore;
  let where: string;
  let close: () => Promise<void> = async () => undefined;
  if (databaseUrl) {
    // The URL holds the password: never echo it, and report pool errors by message only.
    const db: Database = connectPostgres(databaseUrl, (e) =>
      process.stderr.write(`kynimo-mcp: database connection error: ${e.message}\n`),
    );
    store = await PostgresStore.open(db).catch(fail);
    close = () => db.close();
    where = "projects in Postgres";
  } else if (values.dir) {
    const fileStore = await FileStore.open(resolve(values.dir)).catch(fail);
    store = fileStore;
    close = () => fileStore.close();
    where = `projects in ${resolve(values.dir)}`;
  } else {
    store = new MemoryStore();
    where = "in-memory projects";
  }
  // Chromium starts on the first render, not here.
  const renderer = new CaptureRenderer();
  const release = () => {
    void Promise.allSettled([renderer.close(), close()]).finally(() => process.exit(0));
  };
  process.once("SIGINT", release);
  process.once("SIGTERM", release);
  process.stdin.once("end", release);
  const server = createServer(new KynimoService(store, values.actor, { renderer }));
  await server.connect(new StdioServerTransport());
  // Logs go to stderr: stdout carries the protocol.
  process.stderr.write(`kynimo-mcp ready (${where})\n`);
}
