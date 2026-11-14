import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type McpRequestEvent, type RunningServer, startServer } from "./local-server.js";

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "user-agent": "kynimo-test/1.0",
};

let dir: string;
const running: RunningServer[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kynimo-local-server-"));
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

async function start(extra: { port?: number; onRequest?: (e: McpRequestEvent) => void } = {}) {
  const server = await startServer({
    dir,
    http: { host: "127.0.0.1", port: extra.port ?? 0, noAuth: true },
    env: {},
    log: () => undefined,
    ...(extra.onRequest ? { onRequest: extra.onRequest } : {}),
  });
  running.push(server);
  return server;
}

interface RpcReply {
  result?: { isError?: boolean; serverInfo?: unknown };
}

async function rpc(endpoint: string, body: unknown) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as RpcReply };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-agent", version: "9.9" },
  },
};
const call = (id: number, name: string, args: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

// A cold server start is slow when the whole workspace tests at once.
describe("startServer over HTTP", { timeout: 30_000 }, () => {
  it("serves MCP and reports the requests it receives", async () => {
    const events: McpRequestEvent[] = [];
    const server = await start({ onRequest: (e) => events.push(e) });
    expect(server.port).toBeGreaterThan(0);
    expect(server.endpoint).toBe(`http://127.0.0.1:${server.port}/mcp`);

    const init = await rpc(server.endpoint as string, initialize);
    expect(init.status).toBe(200);
    expect(events[0]?.userAgent).toBe("kynimo-test/1.0");
    expect(events[0]?.messages).toEqual([
      { method: "initialize", clientName: "test-agent", clientVersion: "9.9" },
    ]);

    await rpc(server.endpoint as string, call(2, "list_projects", {}));
    expect(events[1]?.messages).toEqual([{ method: "tools/call", tool: "list_projects" }]);

    await rpc(server.endpoint as string, call(3, "get_project", { project_id: "p-abc" }));
    expect(events[2]?.messages).toEqual([
      { method: "tools/call", tool: "get_project", projectId: "p-abc" },
    ]);
    expect(typeof events[2]?.at).toBe("number");
  });

  it("is not affected by an observer that throws", async () => {
    const server = await start({
      onRequest: () => {
        throw new Error("observer broke");
      },
    });
    const init = await rpc(server.endpoint as string, initialize);
    expect(init.status).toBe(200);
    expect(init.json.result?.serverInfo).toBeDefined();
  });

  it("frees the port on close, and close is idempotent", async () => {
    const first = await start();
    const { port } = first;
    await first.close();
    await first.close();
    const second = await start({ port: port as number });
    expect(second.port).toBe(port);
  });

  it("rejects with the listen error code when the port is taken, leaving the dir usable", async () => {
    const first = await start();
    await expect(start({ port: first.port as number })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await first.close();
    // Nothing from the failed start is left holding the folder.
    const again = await start();
    expect(again.exportDir).toBe(join(dir, "exports"));
  });

  it("gives an in-process host a service on the same store", async () => {
    const server = await start();
    const created = await rpc(
      server.endpoint as string,
      call(4, "create_project", {
        name: "From HTTP",
        idempotency_key: "k-1",
      }),
    );
    expect(created.json.result?.isError).not.toBe(true);
    const projects = await server.service("desktop").listProjects();
    expect(JSON.stringify(projects)).toContain("From HTTP");
    expect(server.activeJobs()).toEqual([]);
  });

  it("rejects a configuration that cannot work before opening anything", async () => {
    await expect(
      startServer({ http: { host: "0.0.0.0", port: 0, noAuth: true }, env: {}, log: () => {} }),
    ).rejects.toThrow("--no-auth serves everyone as one account: listen on a loopback --host only");
    await expect(startServer({ env: { KYNIMO_GPU: "cuda" }, log: () => {} })).rejects.toThrow(
      "KYNIMO_GPU must be 'swiftshader' or 'hardware' (got 'cuda')",
    );
  });
});
