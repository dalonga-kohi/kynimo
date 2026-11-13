import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointFile } from "../shared/paths.js";
import type { HostEvent } from "../shared/protocol.js";
import { Host } from "./host.js";

let dir: string;
let hosts: Host[] = [];
let blockers: Server[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kynimo-host-"));
});
afterEach(async () => {
  await Promise.all(hosts.map((h) => h.close()));
  await Promise.all(blockers.map((s) => new Promise((r) => s.close(r))));
  hosts = [];
  blockers = [];
  await rm(dir, { recursive: true, force: true });
});

function start(options: { ports?: number[]; env?: Record<string, string | undefined> } = {}) {
  const events: HostEvent[] = [];
  const host = new Host({ type: "init", dataDir: dir, media: {} }, (e) => events.push(e), {
    ports: options.ports ?? [0],
    env: options.env ?? {},
    log: () => undefined,
  });
  hosts.push(host);
  return { host, events };
}

describe("Host", { timeout: 30_000 }, () => {
  it("starts the server, writes endpoint.json and answers requests", async () => {
    const { host, events } = start();
    expect(host.status().server).toBe("starting");
    await host.ready;
    const status = host.status();
    expect(status.server).toBe("running");
    expect(status.endpoint).toBe(`http://127.0.0.1:${status.port}/mcp`);
    expect(JSON.parse(await readFile(endpointFile(dir), "utf8"))).toEqual({
      endpoint: status.endpoint,
      port: status.port,
      pid: process.pid,
    });
    expect(events).toContainEqual({ event: "changed" });

    expect(await host.dispatch({ id: 1, method: "status" })).toMatchObject({
      id: 1,
      result: { server: "running" },
    });
    expect(await host.dispatch({ id: 2, method: "listAnimations" })).toEqual({
      id: 2,
      result: [],
    });
  });

  it("removes endpoint.json on close, and close is idempotent", async () => {
    const { host } = start();
    await host.ready;
    expect(await host.dispatch({ id: 1, method: "close" })).toEqual({ id: 1, result: null });
    await host.close();
    await expect(readFile(endpointFile(dir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back to the next port when one is in use", async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const taken = (blocker.address() as { port: number }).port;
    const { host } = start({ ports: [taken, 0] });
    await host.ready;
    expect(host.status().server).toBe("running");
    expect(host.status().port).not.toBe(taken);
  });

  it("reports failed with the message when no port can be bound, and stays usable", async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const taken = (blocker.address() as { port: number }).port;
    const { host, events } = start({ ports: [taken] });
    await host.ready;
    expect(host.status()).toMatchObject({
      server: "failed",
      error: expect.stringContaining("EADDRINUSE"),
    });
    expect(events.at(-1)).toEqual({ event: "changed" });
    expect(
      await host.dispatch({ id: 1, method: "thumbnail", params: { id: `p-${"a".repeat(32)}` } }),
    ).toMatchObject({ id: 1, error: expect.stringContaining("not running") });
    expect(await host.dispatch({ id: 2, method: "listAnimations" })).toEqual({ id: 2, result: [] });
  });

  it("reports failed for a start error that is not a busy port", async () => {
    const { host } = start({ env: { KYNIMO_GPU: "cuda" } });
    await host.ready;
    expect(host.status()).toMatchObject({
      server: "failed",
      error: expect.stringContaining("KYNIMO_GPU"),
    });
  });

  it("applies the media paths main passes in", async () => {
    const env: Record<string, string | undefined> = {};
    const host = new Host(
      {
        type: "init",
        dataDir: dir,
        media: {
          ffmpeg: "C:\\k\\ffmpeg.exe",
          ffprobe: "C:\\k\\ffprobe.exe",
          browsers: "C:\\k\\browsers",
        },
      },
      () => undefined,
      { ports: [0], env, log: () => undefined },
    );
    hosts.push(host);
    await host.ready;
    expect(env).toMatchObject({
      KYNIMO_FFMPEG: "C:\\k\\ffmpeg.exe",
      KYNIMO_FFPROBE: "C:\\k\\ffprobe.exe",
      PLAYWRIGHT_BROWSERS_PATH: "C:\\k\\browsers",
    });
  });

  it("leaves the media environment alone in development", async () => {
    const env: Record<string, string | undefined> = {};
    const { host } = start({ env });
    await host.ready;
    expect(env).toEqual({});
  });

  it("rejects ids and formats that are not valid", async () => {
    const { host } = start();
    await host.ready;
    const bad = await host.dispatch({ id: 1, method: "thumbnail", params: { id: "../../x" } });
    expect(bad).toMatchObject({ error: "invalid animation id" });
    const id = `p-${"a".repeat(32)}`;
    expect(
      await host.dispatch({ id: 2, method: "exportVideo", params: { id, format: "avi" } }),
    ).toMatchObject({ error: "invalid export format" });
  });

  it("persists the welcome flag in settings.json", async () => {
    const { host } = start();
    await host.ready;
    expect(await host.dispatch({ id: 1, method: "welcomeSeen" })).toEqual({ id: 1, result: false });
    await host.dispatch({ id: 2, method: "markWelcomeSeen" });
    expect(await host.dispatch({ id: 3, method: "welcomeSeen" })).toEqual({ id: 3, result: true });
    expect(JSON.parse(await readFile(join(dir, "desktop", "settings.json"), "utf8"))).toEqual({
      welcomeSeen: true,
    });
  });
});
