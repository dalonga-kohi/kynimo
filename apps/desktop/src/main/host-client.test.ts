import { describe, expect, it, vi } from "vitest";
import type { HostMessage, HostRequest } from "../shared/protocol.js";
import { type HostChannel, HostClient } from "./host-client.js";

function fakeChannel() {
  const sent: HostRequest[] = [];
  let message: (m: HostMessage) => void = () => undefined;
  let exit: () => void = () => undefined;
  const kill = vi.fn();
  const channel: HostChannel = {
    postMessage: (m) => void sent.push(m as HostRequest),
    onMessage: (l) => {
      message = l;
    },
    onExit: (l) => {
      exit = l;
    },
    kill,
  };
  return { channel, sent, kill, receive: (m: HostMessage) => message(m), exit: () => exit() };
}

describe("HostClient", () => {
  it("matches responses to requests by id", async () => {
    const { channel, sent, receive } = fakeChannel();
    const client = new HostClient(channel);
    const a = client.request("thumbnail", { id: "p-1" });
    const b = client.request("listAnimations");
    expect(sent.map((r) => [r.id, r.method, r.params])).toEqual([
      [1, "thumbnail", { id: "p-1" }],
      [2, "listAnimations", undefined],
    ]);
    receive({ id: 2, result: [] });
    receive({ id: 1, result: { path: "x.png" } });
    expect(await a).toEqual({ path: "x.png" });
    expect(await b).toEqual([]);
  });

  it("rejects with the host's error message", async () => {
    const { channel, receive } = fakeChannel();
    const client = new HostClient(channel);
    const reply = client.request("status");
    receive({ id: 1, error: "boom" });
    await expect(reply).rejects.toThrow("boom");
  });

  it("passes events to listeners until they unsubscribe", () => {
    const { channel, receive } = fakeChannel();
    const client = new HostClient(channel);
    const seen = vi.fn();
    const off = client.onEvent(seen);
    receive({ event: "changed" });
    off();
    receive({ event: "changed" });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("fails pending and later requests when the host exits", async () => {
    const { channel, exit } = fakeChannel();
    const client = new HostClient(channel);
    const pending = client.request("status");
    exit();
    await expect(pending).rejects.toThrow("the server stopped");
    await expect(client.request("status")).rejects.toThrow("the server stopped");
  });

  it("stop asks the host to close, then kills it", async () => {
    const { channel, sent, kill, receive } = fakeChannel();
    const client = new HostClient(channel);
    const stopped = client.stop();
    expect(sent[0]?.method).toBe("close");
    receive({ id: 1, result: null });
    await stopped;
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("stop kills a host that does not answer in time", async () => {
    const { channel, kill } = fakeChannel();
    const client = new HostClient(channel, { closeTimeoutMs: 20 });
    await client.stop();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
