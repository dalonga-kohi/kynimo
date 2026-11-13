import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { NOT_RUNNING, runBridge } from "./bridge.js";

interface Seen {
  headers: IncomingMessage["headers"];
  body: string;
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

async function fakeMcp(
  respond: (body: string, status: (code: number) => void) => string | undefined,
  contentType = "application/json",
) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      seen.push({ headers: req.headers, body });
      let code = 200;
      const reply = respond(body, (c) => {
        code = c;
      });
      res.writeHead(code, { "content-type": contentType });
      res.end(reply ?? "");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { endpoint: `http://127.0.0.1:${port}/mcp`, seen };
}

async function* lines(...items: string[]) {
  for (const item of items) yield item;
}

async function run(
  input: string[],
  options: {
    endpoint?: () => Promise<string | undefined>;
    launch?: () => void;
    waitMs?: number;
  },
) {
  const out: string[] = [];
  const logs: string[] = [];
  await runBridge({
    lines: lines(...input),
    write: (l) => out.push(l),
    log: (l) => logs.push(l),
    readEndpoint: options.endpoint ?? (async () => undefined),
    launchApp: options.launch ?? (() => undefined),
    waitMs: options.waitMs ?? 200,
    retryMs: 10,
  });
  return { out, logs };
}

const request = (id: number, method = "tools/list") =>
  JSON.stringify({ jsonrpc: "2.0", id, method });

describe("runBridge", () => {
  it("posts each line and writes each JSON response as one line", async () => {
    const mcp = await fakeMcp((body) =>
      JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: { ok: true } }, null, 2),
    );
    const { out } = await run([request(1), request(2)], { endpoint: async () => mcp.endpoint });
    expect(out.map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", id: 2, result: { ok: true } },
    ]);
    expect(out.every((l) => !l.includes("\n"))).toBe(true);
    expect(mcp.seen[0]?.headers["content-type"]).toBe("application/json");
    expect(mcp.seen[0]?.headers.accept).toBe("application/json, text/event-stream");
    expect(JSON.parse(mcp.seen[0]?.body ?? "")).toMatchObject({ method: "tools/list" });
  });

  it("writes nothing for a 202 or an empty body", async () => {
    const accepted = await fakeMcp((_, status) => {
      status(202);
      return undefined;
    });
    const a = await run([JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })], {
      endpoint: async () => accepted.endpoint,
    });
    expect(a.out).toEqual([]);
    expect(accepted.seen).toHaveLength(1);

    const empty = await fakeMcp(() => "");
    const b = await run([request(1)], { endpoint: async () => empty.endpoint });
    expect(b.out).toEqual([]);
  });

  it("reads the data lines of an event stream", async () => {
    const mcp = await fakeMcp(
      () => `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`,
      "text/event-stream",
    );
    const { out } = await run([request(1)], { endpoint: async () => mcp.endpoint });
    expect(out.map((l) => JSON.parse(l))).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("passes an error response body through", async () => {
    const mcp = await fakeMcp((_, status) => {
      status(400);
      return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "bad" } });
    });
    const { out } = await run([request(1)], { endpoint: async () => mcp.endpoint });
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ error: { code: -32600 } });
  });

  it("answers a parse error for a line that is not JSON and carries on", async () => {
    const mcp = await fakeMcp(() => JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    const { out } = await run(["not json", "", request(1)], { endpoint: async () => mcp.endpoint });
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ error: { code: -32700 } });
  });

  it("starts the app once and answers 'not running' when there is no endpoint", async () => {
    let launches = 0;
    const { out } = await run(
      [request(1), request(2), JSON.stringify({ jsonrpc: "2.0", method: "n" })],
      {
        launch: () => launches++,
        waitMs: 60,
      },
    );
    expect(launches).toBe(1);
    const replies = out.map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id);
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: NOT_RUNNING } },
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: NOT_RUNNING } },
    ]);
  });

  it("waits for the app to come up and then forwards", async () => {
    const mcp = await fakeMcp(() => JSON.stringify({ jsonrpc: "2.0", id: 1, result: "late" }));
    let reads = 0;
    let launches = 0;
    const { out } = await run([request(1)], {
      endpoint: async () => (++reads > 3 ? mcp.endpoint : undefined),
      launch: () => launches++,
      waitMs: 5000,
    });
    expect(launches).toBe(1);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ result: "late" });
  });

  it("starts the app when the endpoint refuses the connection", async () => {
    const dead = await fakeMcp(() => "");
    const refused = dead.endpoint;
    await new Promise((r) => servers[0]?.close(r));
    servers = [];
    const live = await fakeMcp(() => JSON.stringify({ jsonrpc: "2.0", id: 1, result: "up" }));
    let launched = false;
    const { out } = await run([request(1)], {
      // The stale file points at a dead port until the app starts and rewrites it.
      endpoint: async () => (launched ? live.endpoint : refused),
      launch: () => {
        launched = true;
      },
      waitMs: 5000,
    });
    expect(launched).toBe(true);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ result: "up" });
  });
});
