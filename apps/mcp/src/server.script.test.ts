import { sdkDeclarations } from "@kynimo/script";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { TITLE_CARD_SCRIPT, titleCardReference } from "./script.test-util.js";
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

const TWO_LAYERS = `
const comp = kynimo.composition();
const a = comp.add("solid", { name: "A", width: 100, height: 100, color: "#ff0000" }, { id: "a" });
const b = comp.add("solid", { name: "B", width: 100, height: 100, color: "#00ff00" }, { id: "b" });
a.animate({ property: "opacity", from: 0, to: 1, duration: 300 });
b.keyframes("position", [
  { frame: 0, value: [100, 100], interpolation: { type: "linear" } },
  { frame: 30, value: [kynimo.random() * 100 + 200, 100], interpolation: { type: "linear" } },
]);
`;

describe("run_script", () => {
  let client: Client;
  let project_id: string;
  const meta = (v: number, key: string) => ({ project_id, base_version: v, idempotency_key: key });
  const run = (v: number, key: string, source: string, extra: Structured = {}) =>
    call(client, "run_script", { ...meta(v, key), source, ...extra });
  const runError = (v: number, key: string, source: string, extra: Structured = {}) =>
    callError(client, "run_script", { ...meta(v, key), source, ...extra });
  const version = async () =>
    ((await call(client, "get_project", { project_id })) as { version: number }).version;
  const layerIds = async () =>
    (
      (await call(client, "find_layers", { project_id, selector: { name: "*" } })) as {
        layers: { id: string }[];
      }
    ).layers.map((l) => l.id);

  beforeEach(async () => {
    client = await connect();
    ({ id: project_id } = (await call(client, "create_project", {
      name: "P",
      idempotency_key: "c",
    })) as { id: string });
  });

  it("applies a script as one version, and undo reverts all of it", async () => {
    const r = await run(1, "s1", TWO_LAYERS);
    expect(r).toMatchObject({
      version: 2,
      changed: true,
      replayed: false,
      layers_added: ["a", "b"],
      op_count: 4,
      resolved: { entries: 4, layers_created: ["a", "b"], seed: 0 },
    });
    expect(r.ops).toBeUndefined();
    expect(await layerIds()).toEqual(["b", "a"]);

    const undone = await call(client, "undo", meta(2, "u1"));
    expect(undone).toMatchObject({ version: 3, layers_removed: ["b", "a"] });
    expect(await layerIds()).toEqual([]);
  });

  it("is deterministic in the seed", async () => {
    const dry = (key: string, seed?: number) =>
      run(1, key, TWO_LAYERS, { dry_run: true, ...(seed === undefined ? {} : { seed }) });
    const a = await dry("k1");
    expect((await dry("k2")).ops).toEqual(a.ops);
    expect((await dry("k3", 7)).ops).not.toEqual(a.ops);
  });

  it("dry_run returns the ops and the motion, and writes nothing; the real run gives the same ops", async () => {
    const dry = await run(1, "s1", TWO_LAYERS, { dry_run: true });
    expect(dry).toMatchObject({ version: 1, dry_run: true, changed: true, op_count: 4 });
    expect((dry.ops as unknown[]).length).toBe(4);
    expect(dry.motion).toMatchObject({
      composition: "main",
      layers: expect.arrayContaining([expect.objectContaining({ id: "a" })]),
    });
    expect(await version()).toBe(1);
    expect(await layerIds()).toEqual([]);

    // Nothing was recorded: the same key writes.
    const written = await run(1, "s1", TWO_LAYERS);
    expect(written).toMatchObject({ version: 2, replayed: false });
    expect(written.motion).toBeUndefined();

    // The dry run's ops, applied through apply_ops on a twin project, give the same layers.
    const twin = (await call(client, "create_project", {
      name: "Twin",
      idempotency_key: "c2",
    })) as { id: string };
    await call(client, "apply_ops", {
      project_id: twin.id,
      base_version: 1,
      idempotency_key: "t",
      ops: dry.ops,
    });
    const layersOf = async (id: string) =>
      Promise.all(
        ["a", "b"].map(async (layer) => {
          const r = (await call(client, "get_layer", { project_id: id, layer })) as {
            layer: unknown;
          };
          return r.layer;
        }),
      );
    expect(await layersOf(twin.id)).toEqual(await layersOf(project_id));
  });

  it("replays the same key and input, rejects a different source, and conflicts on a stale base", async () => {
    const first = await run(1, "s1", TWO_LAYERS);
    const again = await run(1, "s1", TWO_LAYERS);
    expect(again).toMatchObject({ version: 2, replayed: true });
    expect(again.ops).toBeUndefined();
    expect(await version()).toBe(2);

    const reused = await runError(1, "s1", `${TWO_LAYERS}\n// changed`);
    expect(reused).toMatchObject({ error: "key_reused" });

    const stale = await runError(1, "s2", TWO_LAYERS);
    expect(stale).toMatchObject({ error: "conflict", current_version: 2 });
    expect(first.version).toBe(2);
    expect(await version()).toBe(2);
  });

  it("reports script faults with where they happened, and writes nothing", async () => {
    const syntax = await runError(1, "e1", "const a = 1;\nexport const b = 2;");
    expect(syntax).toMatchObject({
      error: "invalid",
      script_error: { kind: "syntax", line: 2 },
      errors: [{ path: ["source"] }],
    });

    const runtime = await runError(1, "e2", "const x = 1;\n\nthrow new Error('boom');\n");
    expect(runtime).toMatchObject({
      error: "invalid",
      script_error: { kind: "runtime", line: 3 },
    });
    expect(String(runtime.message)).toContain("boom");

    const cpu = await runError(1, "e3", "while (true) {}");
    expect(cpu).toMatchObject({ error: "invalid", script_error: { kind: "cpu_limit" } });

    const rejected = await runError(
      1,
      "e4",
      `const c = kynimo.composition();
c.add("solid", { name: "A", width: 10, height: 10, color: "#ff0000" }, { id: "a" });
kynimo.op({ op: "removeLayer", layer: "missing" });
`,
    );
    expect(rejected).toMatchObject({
      error: "invalid",
      script_error: { kind: "invalid", entry: 1, line: 3 },
      expanded_ops: [{ op: "removeLayer", layer: "missing" }],
      errors: [{ path: expect.arrayContaining(["entries", 1]) }],
    });

    const many = await runError(
      1,
      "e5",
      `const c = kynimo.composition();
for (let i = 0; i < 600; i++) c.add("null", { name: "n" + i });`,
    );
    expect(many).toMatchObject({ error: "invalid", script_error: { kind: "too_many_ops" } });

    expect(await version()).toBe(1);
    // A fault is not recorded against its key: the corrected script writes with the same key.
    expect(await run(1, "e1", TWO_LAYERS)).toMatchObject({ version: 2 });
  });

  it("checks the input before running anything", async () => {
    const r = (await client.callTool({
      name: "run_script",
      arguments: { ...meta(1, "bad"), source: "", seed: -1 },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    const missing = (await client.callTool({
      name: "run_script",
      arguments: meta(1, "m"),
    })) as CallToolResult;
    expect(missing.isError).toBe(true);
  });

  it("rebuilds the title-card reference scene from one script", async () => {
    const reference = titleCardReference();
    const main = reference.compositions[0];
    if (main === undefined) throw new Error("no composition");
    const created = (await call(client, "create_project", {
      name: reference.name,
      idempotency_key: "tc",
      width: main.width,
      height: main.height,
      fps: main.fps,
      duration_frames: main.durationFrames,
      background: main.background,
    })) as { id: string };
    project_id = created.id;
    const r = await run(1, "tc-script", TITLE_CARD_SCRIPT);
    expect(r).toMatchObject({ version: 2, replayed: false });
    expect((r.resolved as { layers_created: string[] }).layers_created).toHaveLength(6);

    const ids = await layerIds();
    expect(ids).toEqual(main.layers.map((l) => l.id));
    const built = await Promise.all(
      ids.map(async (layer) => {
        const got = (await call(client, "get_layer", { project_id, layer })) as { layer: unknown };
        return got.layer;
      }),
    );
    // Nothing is stripped: the layers equal the reference layer for layer.
    expect(built).toEqual(main.layers);
  });

  it("serves the SDK declarations as a resource and declares scripts in the capabilities", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("kynimo://sdk");
    const first = (await client.readResource({ uri: "kynimo://sdk" })).contents[0];
    if (first === undefined || !("text" in first)) throw new Error("expected text contents");
    expect(first.mimeType).toBe("text/plain");
    expect(first.text).toBe(sdkDeclarations());
    expect(first.text).toContain("declare const kynimo: Kynimo;");

    const caps = await call(client, "get_capabilities", {});
    expect(caps.scripts).toMatchObject({
      tool: "run_script",
      resource: "kynimo://sdk",
      limits: { sourceBytes: 65_536, max_ops: 500 },
    });
  });

  it("leads the instructions with the script hint", () => {
    const text = client.getInstructions() ?? "";
    expect(text.split("\n")[1]).toMatch(
      /^For anything beyond a few edits, write a script: run_script/,
    );
  });
});
