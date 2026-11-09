import { LayerSchema } from "@kynimo/scene";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import { KynimoService } from "./service.js";
import { MemoryStore } from "./store.js";

/** A real MCP client over an in-memory pair, so schemas, listing and output validation are exercised. */
async function connect(): Promise<Client> {
  const server = createServer(new KynimoService(new MemoryStore(), "agent"));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  // Listing caches the client's output validators, so every call below is checked against the
  // (compacted) output schemas the way an SDK-based client checks it.
  await client.listTools();
  return client;
}

type Structured = Record<string, unknown>;

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

describe("MCP server", () => {
  let client: Client;
  beforeEach(async () => {
    client = await connect();
  });

  it("lists the M3 project, read and precise tools with input and output schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_layer",
      "add_mask",
      "apply_ops",
      "create_project",
      "describe_motion",
      "find_layers",
      "get_capabilities",
      "get_layer",
      "get_layer_schema",
      "get_project",
      "get_scene",
      "get_write_outcome",
      "list_assets",
      "list_projects",
      "precompose",
      "redo",
      "render_contact_sheet",
      "render_frames",
      "set_keyframes",
      "set_matte",
      "undo",
      "update_layer",
      "upload_asset",
    ]);
    for (const t of tools) expect(t.outputSchema, t.name).toBeDefined();
    const writes = [
      "upload_asset",
      "add_layer",
      "add_mask",
      "apply_ops",
      "precompose",
      "set_keyframes",
      "set_matte",
      "update_layer",
      "undo",
      "redo",
    ];
    for (const t of tools.filter((t) => writes.includes(t.name)))
      expect(t.inputSchema.required, t.name).toEqual(
        expect.arrayContaining(["project_id", "base_version", "idempotency_key"]),
      );
  });

  it("keeps the tool listing compact enough for a model's context", async () => {
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools).length).toBeLessThan(60_000);
  });

  it("describes motion with output the client validates", async () => {
    const { id: project_id } = await call(client, "create_project", {
      name: "P",
      idempotency_key: "c",
    });
    await call(client, "add_layer", {
      project_id,
      base_version: 1,
      idempotency_key: "a",
      composition: "main",
      layer: { type: "solid", name: "Box", width: 10, height: 10, color: "#ffffff" },
      id: "box",
    });
    await call(client, "set_keyframes", {
      project_id,
      base_version: 2,
      idempotency_key: "k",
      layer: "box",
      property: "position",
      track: {
        keyframes: [
          {
            frame: 0,
            value: [0, 0],
            interpolation: { type: "spring", damping: 0.5, response: 0.5 },
          },
          { frame: 60, value: [100, 50], interpolation: { type: "linear" } },
        ],
      },
    });
    const d = await call(client, "describe_motion", { project_id });
    const [layer] = d.layers as { properties: { segments: { easing: { type: string } }[] }[] }[];
    expect(layer?.properties[0]?.segments[0]?.easing.type).toBe("spring");
    expect(d.truncated_segments).toBe(0);
  });

  it("masks, mattes and precomposes layers, then undoes the precompose", async () => {
    const { id: project_id } = await call(client, "create_project", {
      name: "P",
      idempotency_key: "c",
    });
    const meta = (v: number, key: string) => ({
      project_id,
      base_version: v,
      idempotency_key: key,
    });
    const square = {
      closed: true,
      vertices: [
        [0, 0],
        [200, 0],
        [200, 200],
        [0, 200],
      ].map((point) => ({ point, inTangent: [0, 0], outTangent: [0, 0] })),
    };
    const solid = (id: string) => ({
      composition: "main",
      id,
      layer: { type: "solid", name: id, width: 400, height: 400, color: "#ffffff" },
    });
    await call(client, "add_layer", { ...solid("card"), ...meta(1, "w1") });
    await call(client, "add_layer", { ...solid("wipe"), ...meta(2, "w2") });

    const masked = await call(client, "add_mask", {
      ...meta(3, "w3"),
      layer: "card",
      path: { value: square },
      feather: { value: [8, 8] },
    });
    expect(masked).toMatchObject({ version: 4, layers_changed: ["card"] });
    const card = await call(client, "get_layer", { project_id, layer: "card" });
    expect(card.layer).toMatchObject({
      masks: [{ id: "mask-1", name: "Mask", mode: "add", inverted: false, opacity: { value: 1 } }],
    });

    const matted = await call(client, "set_matte", {
      ...meta(4, "w4"),
      layer: "card",
      matte: { layer: { name: "wipe" }, mode: "alpha" },
    });
    expect(matted).toMatchObject({ version: 5, layers_changed: ["card"] });

    const crossing = await callError(client, "precompose", { ...meta(5, "w5"), layers: ["card"] });
    expect(crossing).toMatchObject({ error: "invalid" });
    expect(JSON.stringify(crossing.errors)).toContain("track matte 'wipe'");

    const pre = await call(client, "precompose", {
      ...meta(5, "w6"),
      layers: ["card", "wipe"],
      name: "Card group",
      composition_id: "card-group",
    });
    expect(pre).toMatchObject({
      version: 6,
      compositions_added: ["card-group"],
      layers_changed: ["wipe", "card"],
    });
    expect((pre.layers_added as string[]).length).toBe(1);
    const scene = (await call(client, "get_project", { project_id })) as {
      compositions: { id: string; layers: number }[];
    };
    expect(scene.compositions.map((c) => [c.id, c.layers])).toEqual([
      ["main", 1],
      ["card-group", 2],
    ]);

    const outcome = await call(client, "get_write_outcome", { project_id, idempotency_key: "w6" });
    expect(outcome).toMatchObject({
      status: "applied",
      result: { compositions_added: ["card-group"] },
    });

    const undone = await call(client, "undo", meta(6, "u1"));
    expect(undone).toMatchObject({ version: 7, compositions_removed: ["card-group"] });
  });

  it("validates mask bodies in apply_ops on the server", async () => {
    const { id: project_id } = await call(client, "create_project", {
      name: "P",
      idempotency_key: "c",
    });
    await call(client, "add_layer", {
      project_id,
      base_version: 1,
      idempotency_key: "w1",
      composition: "main",
      id: "s",
      layer: { type: "solid", name: "s", width: 10, height: 10, color: "#ffffff" },
    });
    const bad = await callError(client, "apply_ops", {
      project_id,
      base_version: 2,
      idempotency_key: "w2",
      ops: [{ op: "addMask", layer: "s", mask: { name: "m", mode: "add" } }],
    });
    expect(JSON.stringify(bad.errors)).toContain('"ops",0,"mask","inverted"');
  });

  it("builds and animates a layer end to end", async () => {
    const created = await call(client, "create_project", { name: "Promo", idempotency_key: "c1" });
    const project_id = created.id as string;
    expect(created.version).toBe(1);

    const added = await call(client, "add_layer", {
      project_id,
      base_version: 1,
      idempotency_key: "w1",
      composition: "main",
      id: "card",
      layer: { type: "solid", name: "card", width: 400, height: 200, color: "#3366ff" },
    });
    expect(added).toMatchObject({ version: 2, layers_added: ["card"] });

    const keyed = await call(client, "set_keyframes", {
      project_id,
      base_version: 2,
      idempotency_key: "w2",
      layer: { name: "card" },
      property: "position",
      track: {
        keyframes: [
          {
            frame: 0,
            value: [960, 700],
            interpolation: { type: "bezier", x1: 0.2, y1: 0, x2: 0, y2: 1 },
          },
          { frame: 20, value: [960, 540], interpolation: { type: "linear" } },
        ],
      },
    });
    expect(keyed).toMatchObject({ version: 3, layers_changed: ["card"] });

    const scene = await call(client, "get_scene", { project_id });
    expect(scene).toMatchObject({ version: 3, detail: "summary" });
    expect(JSON.stringify(scene)).toContain('"property":"transform.position"');

    const layer = await call(client, "get_layer", { project_id, layer: "card" });
    expect(layer.layer).toMatchObject({
      transform: { position: { keyframes: expect.any(Array) } },
    });

    const undone = await call(client, "undo", {
      project_id,
      base_version: 3,
      idempotency_key: "u1",
    });
    expect(undone).toMatchObject({ version: 4, layers_changed: ["card"] });
  });

  it("applies a batch through apply_ops and validates op bodies on the server", async () => {
    const { id: project_id } = await call(client, "create_project", {
      name: "P",
      idempotency_key: "c",
    });
    const bad = await callError(client, "apply_ops", {
      project_id,
      base_version: 1,
      idempotency_key: "w1",
      ops: [{ op: "addLayer", composition: "main", layer: { type: "solid", name: "x" } }],
    });
    expect(bad).toMatchObject({ error: "invalid" });
    expect(JSON.stringify(bad.errors)).toContain('"ops",0,"layer"');

    const outcome = await call(client, "get_write_outcome", { project_id, idempotency_key: "w1" });
    expect(outcome).toMatchObject({ status: "rejected", kind: "invalid" });
  });

  it("returns a stale-version conflict with the current version", async () => {
    const { id: project_id } = await call(client, "create_project", {
      name: "P",
      idempotency_key: "c",
    });
    const stale = await callError(client, "update_layer", {
      project_id,
      base_version: 7,
      idempotency_key: "w1",
      layer: "x",
      set: { hidden: true },
    });
    expect(stale).toMatchObject({ error: "conflict", current_version: 1 });
  });

  it("serves the exact JSON Schema of every layer type", async () => {
    for (const option of LayerSchema.options) {
      const type = option.shape.type.value;
      const r = await call(client, "get_layer_schema", { type });
      const schema = r.schema as { properties: Record<string, unknown> };
      expect(schema.properties.type, type).toBeDefined();
      expect(schema.properties.id, type).toBeUndefined();
    }
  });

  it("reports capabilities as a tool and as the same resource", async () => {
    const tool = await call(client, "get_capabilities", {});
    const layerTypes = tool.layer_types as Record<string, { status: string; reason?: string }>;
    expect(layerTypes.adjustment).toMatchObject({ status: "accepted" });
    expect(layerTypes.shape).toEqual({ status: "renders" });
    const read = await client.readResource({ uri: "kynimo://capabilities" });
    const first = read.contents[0];
    if (first === undefined || !("text" in first)) throw new Error("expected text contents");
    expect(JSON.parse(first.text)).toEqual(tool);
  });

  it("lists the schema resources, including one per layer type", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        "kynimo://capabilities",
        "kynimo://schema/scene",
        "kynimo://schema/ops",
        ...LayerSchema.options.map((o) => `kynimo://schema/layer/${o.shape.type.value}`),
      ]),
    );
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["kynimo://schema/layer/{type}"]);
  });

  it("serves the scene, op and layer schemas as JSON Schema", async () => {
    const text = async (uri: string) => {
      const first = (await client.readResource({ uri })).contents[0];
      if (first === undefined || !("text" in first)) throw new Error("expected text contents");
      return JSON.parse(first.text) as Record<string, unknown>;
    };
    const scene = (await text("kynimo://schema/scene")) as { properties: Record<string, unknown> };
    expect(scene.properties.formatVersion).toBeDefined();
    expect(await text("kynimo://schema/ops")).toHaveProperty("oneOf");
    const text_ = await call(client, "get_layer_schema", { type: "text" });
    expect(await text("kynimo://schema/layer/text")).toEqual(text_.schema);
    await expect(client.readResource({ uri: "kynimo://schema/layer/video" })).rejects.toMatchObject(
      {
        code: ErrorCode.InvalidParams,
        message: expect.stringMatching(/unknown layer type 'video'/),
      },
    );
  });

  it("finds layers and lists projects", async () => {
    const { id: project_id } = await call(client, "create_project", {
      name: "P",
      idempotency_key: "c",
    });
    await call(client, "apply_ops", {
      project_id,
      base_version: 1,
      idempotency_key: "w1",
      ops: ["a", "b"].map((name) => ({
        op: "addLayer",
        composition: "main",
        layer: {
          type: "null",
          name,
          inFrame: 0,
          outFrame: 150,
          startFrame: 0,
          hidden: false,
          solo: false,
          editor: { locked: false, shy: false, label: null },
          markers: [],
          parent: null,
          transform: {
            anchorPoint: { value: [0, 0] },
            position: { value: [0, 0] },
            scale: { value: [1, 1] },
            rotation: { value: 0 },
            skew: { value: 0 },
            opacity: { value: 1 },
          },
        },
      })),
    });
    expect(
      await call(client, "find_layers", { project_id, selector: { type: "null" } }),
    ).toMatchObject({ total: 2 });
    expect(await call(client, "list_projects", {})).toEqual({
      projects: [{ id: project_id, name: "P", version: 2 }],
    });
    expect(await call(client, "get_project", { project_id })).toMatchObject({ version: 2 });
  });

  it("reports an unknown project as an error result, not a protocol error", async () => {
    expect(await callError(client, "get_scene", { project_id: "p-nope" })).toMatchObject({
      error: "not_found",
    });
  });

  it("replays an add_layer retry with the same key instead of adding twice", async () => {
    const { id: project_id } = await call(client, "create_project", {
      name: "P",
      idempotency_key: "c",
    });
    const args = {
      project_id,
      base_version: 1,
      idempotency_key: "w1",
      composition: "main",
      layer: { type: "solid", name: "s", width: 10, height: 10, color: "#ffffff" },
    };
    const first = await call(client, "add_layer", args);
    const retry = await call(client, "add_layer", args);
    expect(retry).toEqual({ ...first, replayed: true });
    expect(await call(client, "get_project", { project_id })).toMatchObject({ version: 2 });
  });

  it("marks writes that can remove work as destructive", async () => {
    const { tools } = await client.listTools();
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive.sort()).toEqual(["apply_ops", "redo", "undo"]);
  });
});
