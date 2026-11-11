import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import { KynimoService } from "./service.js";
import { MemoryStore } from "./store.js";

type Structured = Record<string, unknown>;

async function connect(): Promise<Client> {
  const server = createServer(new KynimoService(new MemoryStore(), "agent"));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  await client.listTools();
  return client;
}

async function call(client: Client, name: string, args: Structured): Promise<Structured> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r.structuredContent as Structured;
}

async function callError(client: Client, name: string, args: Structured): Promise<Structured> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(r.isError).toBe(true);
  const first = r.content[0];
  if (first?.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Structured;
}

const WIGGLE = {
  type: "wiggle",
  property: "position",
  frequency: { value: 2 },
  amplitude: { value: [20, 0] },
  octaves: 2,
  seed: 7,
  linked: false,
};

describe("intent tools", () => {
  let client: Client;
  let project_id: string;
  const meta = (v: number, key: string) => ({ project_id, base_version: v, idempotency_key: key });

  /** A project with two solids, `a` and `b`, at version 3. */
  beforeEach(async () => {
    client = await connect();
    ({ id: project_id } = (await call(client, "create_project", {
      name: "P",
      idempotency_key: "c",
    })) as { id: string });
    for (const [i, id] of ["a", "b"].entries())
      await call(client, "add_layer", {
        ...meta(i + 1, `add-${id}`),
        composition: "main",
        id,
        layer: { type: "solid", name: id, width: 100, height: 100, color: "#ffffff" },
      });
  });

  const opacityTrack = async (id: string) => {
    const r = (await call(client, "get_layer", { project_id, layer: id })) as {
      layer: { transform: { opacity: unknown } };
    };
    return r.layer.transform.opacity;
  };
  const version = async () =>
    ((await call(client, "get_project", { project_id })) as { version: number }).version;

  it("animate writes keyframes and returns the ops and what the tokens resolved to", async () => {
    const r = await call(client, "animate", {
      ...meta(3, "k1"),
      layers: "a",
      property: "opacity",
      from: 0,
      to: 1,
      duration: "base",
    });
    expect(r).toMatchObject({ version: 4, changed: true, replayed: false, layers_changed: ["a"] });
    expect(r.ops).toMatchObject([{ op: "setTransformTrack", property: "opacity" }]);
    expect(r.resolved).toMatchObject({
      start_frames: [0],
      style: { packId: "keynote", pinned: false },
    });
    expect(await opacityTrack("a")).toMatchObject({
      keyframes: [
        { frame: 0, value: 0 },
        { frame: expect.any(Number), value: 1 },
      ],
    });
  });

  it("dry_run returns the ops and writes nothing", async () => {
    const before = await opacityTrack("a");
    const r = await call(client, "animate", {
      ...meta(3, "k1"),
      layers: "a",
      property: "opacity",
      from: 0,
      to: 1,
      dry_run: true,
    });
    expect(r).toMatchObject({ version: 3, dry_run: true, changed: true });
    expect((r.ops as unknown[]).length).toBe(1);
    expect(await version()).toBe(3);
    expect(await opacityTrack("a")).toEqual(before);
    // Nothing was recorded either: the same key still writes.
    const written = await call(client, "animate", {
      ...meta(3, "k1"),
      layers: "a",
      property: "opacity",
      from: 0,
      to: 1,
    });
    expect(written).toMatchObject({ version: 4, replayed: false });
  });

  it("dry_run still reports expansion refusals and stale versions", async () => {
    const refused = await callError(client, "animate", {
      ...meta(3, "k"),
      layers: "a",
      property: "opacity",
      from: 1,
      to: 1,
      dry_run: true,
    });
    expect(refused).toMatchObject({ error: "invalid" });
    const stale = await callError(client, "animate", {
      ...meta(2, "k"),
      layers: "a",
      property: "opacity",
      from: 0,
      to: 1,
      dry_run: true,
    });
    expect(stale).toMatchObject({ error: "conflict", current_version: 3 });
  });

  it("replays a retry with the same key even after the document moved", async () => {
    const args = { ...meta(3, "k1"), layers: "a", property: "opacity", from: 0, to: 1 };
    const first = await call(client, "animate", args);
    await call(client, "update_layer", { ...meta(4, "u"), layer: "b", set: { name: "bb" } });
    const retry = await call(client, "animate", args);
    expect(retry).toMatchObject({ version: first.version, replayed: true });
    expect(await version()).toBe(5);
    // The same key with a different request is refused.
    const reused = await callError(client, "animate", { ...args, to: 0.5 });
    expect(reused).toMatchObject({ error: "key_reused" });
  });

  it("refuses a stale base_version like apply_ops", async () => {
    const e = await callError(client, "animate", {
      ...meta(1, "k"),
      layers: "a",
      property: "opacity",
      from: 0,
      to: 1,
    });
    expect(e).toMatchObject({ error: "conflict", current_version: 3 });
    expect(e.errors).toEqual([{ path: ["base_version"], message: "expected 3" }]);
    const outcome = await call(client, "get_write_outcome", { project_id, idempotency_key: "k" });
    expect(outcome.status).toBe("rejected");
  });

  it("maps refusals to the invalid error shape with a path into the input", async () => {
    const e = await callError(client, "animate", {
      ...meta(3, "k"),
      layers: ["a", "nope"],
      property: "opacity",
      to: 1,
    });
    expect(e).toMatchObject({ error: "invalid", errors: [{ path: ["layers", 1] }] });
    const bad = await callError(client, "animate", {
      ...meta(3, "k2"),
      layers: "a",
      property: "opacity",
      from: [0, 1],
      to: 1,
    });
    expect(bad).toMatchObject({ error: "invalid", errors: [{ path: ["from"] }] });
    expect(await version()).toBe(3);
  });

  it("apply_preset applies a preset to layers, staggered", async () => {
    const r = await call(client, "apply_preset", {
      ...meta(3, "p1"),
      layers: ["a", "b"],
      preset: "fade-in",
      stagger: { offset: "base" },
    });
    expect(r).toMatchObject({ version: 4, layers_changed: ["a", "b"] });
    const starts = (r.resolved as { start_frames: number[] }).start_frames;
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeGreaterThan(0);

    const e = await callError(client, "apply_preset", {
      ...meta(4, "p2"),
      layers: ["a"],
      preset: "typewriter",
    });
    expect(e).toMatchObject({ error: "invalid", errors: [{ path: ["layers", 0] }] });
    const unknown = await callError(client, "apply_preset", {
      ...meta(4, "p3"),
      layers: "a",
      preset: "nope",
    });
    expect(unknown).toMatchObject({ errors: [{ path: ["preset"] }] });
  });

  it("stagger and retime move existing keyframes", async () => {
    await call(client, "apply_preset", {
      ...meta(3, "p1"),
      layers: ["a", "b"],
      preset: "fade-in",
    });
    const staggered = await call(client, "stagger", {
      ...meta(4, "s1"),
      layers: ["a", "b"],
      offset: 100,
    });
    expect(staggered).toMatchObject({ version: 5 });
    expect((staggered.resolved as { delays_frames: number[] }).delays_frames).toEqual([0, 3]);
    const retimed = await call(client, "retime", {
      ...meta(5, "r1"),
      layers: ["a", "b"],
      scale: 2,
    });
    expect(retimed).toMatchObject({ version: 6, resolved: { scale: 2 } });
    const refused = await callError(client, "retime", { ...meta(6, "r2"), layers: "a" });
    expect(refused).toMatchObject({ error: "invalid" });
  });

  it("add_behavior fills name and enabled and validates the rest", async () => {
    const r = await call(client, "add_behavior", {
      ...meta(3, "b1"),
      layer: "a",
      behavior: WIGGLE,
    });
    expect(r).toMatchObject({ version: 4 });
    const layer = (await call(client, "get_layer", { project_id, layer: "a" })) as {
      layer: { behaviors: { name: string; enabled: boolean; type: string }[] };
    };
    expect(layer.layer.behaviors[0]).toMatchObject({ name: "wiggle", enabled: true });

    const bad = await callError(client, "add_behavior", {
      ...meta(4, "b2"),
      layer: "a",
      behavior: { type: "wiggle", property: "nope" },
    });
    expect(bad).toMatchObject({ error: "invalid" });
    expect(await version()).toBe(4);

    const dry = await call(client, "add_behavior", {
      ...meta(4, "b3"),
      layer: "a",
      dry_run: true,
      behavior: WIGGLE,
    });
    expect(dry).toMatchObject({ dry_run: true, version: 4 });
    expect(await version()).toBe(4);
  });

  it("lists presets as a tool and as the same resource", async () => {
    const tool = await call(client, "list_presets", {});
    const presets = tool.presets as { id: string; params: unknown }[];
    expect(presets.map((p) => p.id)).toContain("fade-in");
    const first = (await client.readResource({ uri: "kynimo://presets" })).contents[0];
    if (first === undefined || !("text" in first)) throw new Error("expected text contents");
    expect(JSON.parse(first.text)).toEqual(tool);
  });
});
