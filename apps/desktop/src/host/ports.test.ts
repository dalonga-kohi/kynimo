import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PORTS, startOnFirstFreePort } from "./ports.js";

const held: Server[] = [];
afterEach(async () => {
  await Promise.all(held.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function occupy(): Promise<number> {
  const server = createServer();
  held.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return address.port;
}

const listen = (port: number) =>
  new Promise<{ port: number; close(): void }>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      held.push(server);
      resolve({ port: bound, close: () => server.close() });
    });
  });

describe("startOnFirstFreePort", () => {
  it("tries 8787 first, then 8788 to 8797, then any port", () => {
    expect(DEFAULT_PORTS.slice(0, 3)).toEqual([8787, 8788, 8789]);
    expect(DEFAULT_PORTS.at(-2)).toBe(8797);
    expect(DEFAULT_PORTS.at(-1)).toBe(0);
  });

  it("uses the first port when it is free", async () => {
    const started = await startOnFirstFreePort([0], listen);
    expect(started.port).toBeGreaterThan(0);
  });

  it("moves on from ports in use", async () => {
    const taken = await occupy();
    const tried: number[] = [];
    const started = await startOnFirstFreePort([taken, 0], (port) => {
      tried.push(port);
      return listen(port);
    });
    expect(tried).toEqual([taken, 0]);
    expect(started.port).not.toBe(taken);
  });

  it("rejects with the last in-use error when every port is taken", async () => {
    const a = await occupy();
    const b = await occupy();
    await expect(startOnFirstFreePort([a, b], listen)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });

  it("stops at an error that is not a port in use", async () => {
    const tried: number[] = [];
    await expect(
      startOnFirstFreePort([1, 2, 3], async (port) => {
        tried.push(port);
        throw new Error("--no-auth serves everyone as one account");
      }),
    ).rejects.toThrow("--no-auth");
    expect(tried).toEqual([1]);
  });
});
