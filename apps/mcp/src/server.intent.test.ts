import { importSvg } from "@kynimo/svg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import { KynimoService } from "./service.js";
import { MemoryStore } from "./store.js";

type Structured = Record<string, unknown>;
interface Kf {
  frame: number;
  value: number;
}
interface TransitionJson {
  progress: { keyframes: Kf[] };
  [field: string]: unknown;
}

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

  it("previews, inserts, and undoes an effect with the normal write contract", async () => {
    const args = {
      ...meta(3, "effect"),
      layer: "a",
      effect: { type: "gaussian-blur", radius: { value: 12 } },
    };
    const dry = await call(client, "add_effect", { ...args, dry_run: true });
    expect(dry).toMatchObject({
      version: 3,
      resolved: { layer: "a", effect_id: "effect-1", index: 0 },
      ops: [{ op: "setEffects", layer: "a", effects: [{ id: "effect-1", type: "gaussian-blur" }] }],
    });
    const written = await call(client, "add_effect", args);
    expect(written).toMatchObject({ version: 4, ops: dry.ops });
    expect(await call(client, "add_effect", args)).toMatchObject({ version: 4, replayed: true });
    const invalid = await callError(client, "add_effect", {
      ...args,
      ...meta(4, "invalid"),
      effect: { ...args.effect, radius: { value: 999 } },
    });
    expect(invalid).toMatchObject({ error: "invalid" });
    expect(await version()).toBe(4);
    await call(client, "undo", meta(4, "undo-effect"));
    expect(await call(client, "get_layer", { project_id, layer: "a" })).toMatchObject({
      layer: { effects: [] },
    });
  });

  describe("add_transition", () => {
    const transitionOf = async (id: string) =>
      (
        (await call(client, "get_layer", { project_id, layer: id })) as {
          layer: { transition: TransitionJson | null };
        }
      ).layer.transition;

    it("writes an in edge with defaults, previews with dry_run and replays", async () => {
      const args = { ...meta(3, "tr"), layer: "a", kind: "wipe", duration: 500 };
      const dry = await call(client, "add_transition", { ...args, dry_run: true });
      expect(dry).toMatchObject({
        version: 3,
        resolved: { layer: "a", kind: "wipe", edge: "in", from_frame: 0, to_frame: 15 },
      });
      expect(await version()).toBe(3);
      const written = await call(client, "add_transition", args);
      expect(written).toMatchObject({ version: 4, ops: dry.ops });
      const t = await transitionOf("a");
      expect(t).toMatchObject({ kind: "wipe", angle: { value: 0 } });
      expect(t?.progress.keyframes.map((k: Kf) => [k.frame, k.value])).toEqual([
        [0, 0],
        [15, 1],
      ]);
      const replay = await call(client, "add_transition", args);
      expect(replay).toMatchObject({ version: 4, replayed: true });
      expect(replay).not.toHaveProperty("ops");
      expect(replay).not.toHaveProperty("resolved");
    });

    it("centres point kinds and seeds deterministically from the layer id", async () => {
      await call(client, "add_transition", { ...meta(3, "i"), layer: "a", kind: "iris" });
      expect((await transitionOf("a"))?.center).toEqual({ value: [960, 540] });
      const first = await call(client, "add_transition", {
        ...meta(4, "g1"),
        layer: "b",
        kind: "glitch",
        dry_run: true,
      });
      const second = await call(client, "add_transition", {
        ...meta(4, "g2"),
        layer: "b",
        kind: "glitch",
        dry_run: true,
      });
      expect(first.ops).toEqual(second.ops);
    });

    it("mirrors the out edge and merges a second edge of the same kind", async () => {
      await call(client, "add_transition", {
        ...meta(3, "o"),
        layer: "a",
        kind: "clock",
        edge: "out",
      });
      const out = await transitionOf("a");
      expect(out?.clockwise).toBe(false);
      await call(client, "add_transition", { ...meta(4, "in"), layer: "a", kind: "clock" });
      const both = await transitionOf("a");
      expect(both?.clockwise).toBe(false);
      expect(both?.progress.keyframes.map((k: Kf) => k.value)).toEqual([0, 1, 1, 0]);

      await call(client, "add_transition", {
        ...meta(5, "w"),
        layer: "b",
        kind: "wipe",
        edge: "out",
      });
      expect((await transitionOf("b"))?.angle).toEqual({ value: 180 });
    });

    it("refuses a different kind or params on an existing transition and leaves the version", async () => {
      await call(client, "add_transition", { ...meta(3, "t"), layer: "a", kind: "wipe" });
      const other = await callError(client, "add_transition", {
        ...meta(4, "k"),
        layer: "a",
        kind: "push",
      });
      expect(other).toMatchObject({ error: "invalid", errors: [{ path: ["kind"] }] });
      const withParams = await callError(client, "add_transition", {
        ...meta(4, "p"),
        layer: "a",
        kind: "wipe",
        params: { feather: { value: 3 } },
      });
      expect(withParams).toMatchObject({ errors: [{ path: ["params"] }] });
      expect(await version()).toBe(4);
    });

    it("refuses adjustment layers, one-frame layers and invalid params", async () => {
      await call(client, "add_layer", {
        ...meta(3, "adj"),
        composition: "main",
        id: "adj",
        layer: { type: "adjustment", name: "adj" },
      });
      await call(client, "add_layer", {
        ...meta(4, "one"),
        composition: "main",
        id: "one",
        layer: {
          type: "solid",
          name: "one",
          width: 10,
          height: 10,
          color: "#ffffff",
          inFrame: 5,
          outFrame: 6,
        },
      });
      const adj = await callError(client, "add_transition", {
        ...meta(5, "x1"),
        layer: "adj",
        kind: "wipe",
      });
      expect(adj.message).toContain("adjustment");
      const one = await callError(client, "add_transition", {
        ...meta(5, "x2"),
        layer: "one",
        kind: "wipe",
      });
      expect(JSON.stringify(one)).toContain("one frame long");
      const bad = await callError(client, "add_transition", {
        ...meta(5, "x3"),
        layer: "a",
        kind: "blinds",
        params: { count: 1 },
      });
      expect(bad).toMatchObject({ errors: [{ path: ["params", "count"] }] });
      expect(await version()).toBe(5);
    });

    it("shrinks the duration to fit a short layer", async () => {
      await call(client, "add_layer", {
        ...meta(3, "short"),
        composition: "main",
        id: "short",
        layer: {
          type: "solid",
          name: "s",
          width: 10,
          height: 10,
          color: "#ffffff",
          inFrame: 0,
          outFrame: 5,
        },
      });
      const r = await call(client, "add_transition", {
        ...meta(4, "s"),
        layer: "short",
        kind: "dissolve",
        duration: "slow",
      });
      expect(r.resolved).toMatchObject({ from_frame: 0, to_frame: 4, duration_frames: 4 });
    });
  });

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

  describe("when the expanded operations are rejected", () => {
    // A spring that is the last key, so the window can't cut it: the new start key lands inside
    // its settle time and batch validation, not the expansion, refuses.
    const input = {
      layers: "s",
      property: "opacity",
      from: 0.5,
      to: 0.8,
      start: 5,
    };
    beforeEach(async () => {
      await call(client, "add_layer", {
        ...meta(3, "add-s"),
        composition: "main",
        id: "s",
        layer: {
          type: "solid",
          name: "s",
          width: 100,
          height: 100,
          color: "#ffffff",
          transform: {
            opacity: {
              keyframes: [
                {
                  frame: 0,
                  value: 0,
                  interpolation: { type: "spring", damping: 1, response: 0.7 },
                },
              ],
            },
          },
        },
      });
    });

    const expectExpanded = (e: Structured) => {
      expect(e).toMatchObject({
        error: "invalid",
        message: expect.stringContaining("expands to were rejected"),
        expanded_ops: [{ op: "setTransformTrack", property: "opacity" }],
      });
      const errors = e.errors as { path: (string | number)[]; message: string }[];
      expect(errors.length).toBeGreaterThan(0);
      // Integrity failures point into the resulting document ("doc", ...), as for apply_ops.
      expect(errors[0]?.path[0]).toBe("doc");
      expect(errors[0]?.message).toContain("settle");
    };

    it("dry_run names the operations and points the errors into them", async () => {
      expectExpanded(
        await callError(client, "animate", { ...meta(4, "k"), ...input, dry_run: true }),
      );
      expect(await version()).toBe(4);
    });

    it("a write does the same, nothing changes, and a replay keeps the shape", async () => {
      expectExpanded(await callError(client, "animate", { ...meta(4, "k"), ...input }));
      expect(await version()).toBe(4);
      const outcome = await call(client, "get_write_outcome", { project_id, idempotency_key: "k" });
      expect(outcome.status).toBe("rejected");
      const replay = await callError(client, "animate", { ...meta(4, "k"), ...input });
      expect(replay).toMatchObject({
        error: "invalid",
        message: expect.stringContaining("expanded to were rejected"),
      });
      // The expanded operations aren't stored, so a replay can't show them.
      expect(replay).not.toHaveProperty("expanded_ops");
    });

    it("operation-level errors point at expanded_ops, not at an ops input", async () => {
      for (const dry_run of [true, false]) {
        const e = await callError(client, "animate", {
          ...meta(4, `v${dry_run}`),
          layers: "a",
          property: "opacity",
          from: 0,
          to: 5,
          dry_run,
        });
        expect(e).toMatchObject({ error: "invalid", expanded_ops: [{ op: "setTransformTrack" }] });
        const errors = e.errors as { path: (string | number)[] }[];
        expect(errors.length).toBeGreaterThan(0);
        for (const err of errors) expect(err.path.slice(0, 2)).toEqual(["expanded_ops", 0]);
      }
      expect(await version()).toBe(4);
    });

    it("other tools' errors carry no extra fields", async () => {
      const e = await callError(client, "apply_ops", {
        ...meta(4, "z"),
        ops: [{ op: "removeLayer", layer: "nope" }],
      });
      expect(e).not.toHaveProperty("expanded_ops");
      expect(e).toMatchObject({ error: "invalid" });
    });
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

  it("lists built-in component versions and prop descriptors in the tool and authoring catalog", async () => {
    const catalog = await call(client, "list_components", {});
    expect(catalog.components).toMatchObject([
      { id: "background", version: "1.0.0" },
      {
        id: "kinetic-type",
        version: "1.0.0",
        props: { position: { type: "point", default: [0, 0], animatable: true } },
      },
      { id: "logo-reveal", version: "1.0.0", props: { logo: { assetType: "image" } } },
      { id: "lower-third", version: "1.0.0" },
      { id: "transition", version: "1.0.0" },
    ]);
    const [first] = (await client.readResource({ uri: "kynimo://components" })).contents;
    if (first === undefined || !("text" in first)) throw new Error("expected text contents");
    expect(JSON.parse(first.text)).toMatchObject({
      ...catalog,
      custom: {
        language: expect.stringContaining("TypeScript"),
        tools: ["define_component", "list_definitions", "add_component"],
        prop_descriptor_schema: expect.any(Object),
      },
    });
  });

  it("previews and writes one pinned component layer, with idempotent retry and undo", async () => {
    const props = {
      text: "Launch",
      color: { role: "accent" },
      position: {
        keyframes: [
          { frame: 0, value: [0, 0], interpolation: { type: "linear" } },
          { frame: 10, value: [12, 20], interpolation: { type: "linear" } },
        ],
      },
    };
    const args = {
      ...meta(3, "component"),
      component_id: "kinetic-type",
      layer_id: "title",
      in_frame: 12,
      out_frame: 36,
      index: 1,
      props,
    };
    const preview = await call(client, "add_component", { ...args, dry_run: true });
    expect(preview).toMatchObject({
      version: 3,
      dry_run: true,
      resolved: { component_id: "kinetic-type", component_version: "1.0.0" },
      layers_added: ["title"],
      ops: [{ op: "addLayer", id: "title", index: 1, composition: "main" }],
    });
    expect(await version()).toBe(3);

    expect(await call(client, "add_component", args)).toMatchObject({
      version: 4,
      ops: preview.ops,
      layers_added: ["title"],
    });
    expect(await call(client, "get_layer", { project_id, layer: "title" })).toMatchObject({
      layer: {
        type: "component",
        componentId: "kinetic-type",
        componentVersion: "1.0.0",
        inFrame: 12,
        startFrame: 12,
        outFrame: 36,
        props,
        transform: { position: { value: [0, 0] } },
      },
    });
    expect(await call(client, "add_component", args)).toMatchObject({ version: 4, replayed: true });
    expect(await call(client, "undo", meta(4, "undo-component"))).toMatchObject({
      version: 5,
      layers_removed: ["title"],
    });
  });

  it.each([
    [{ component_id: "missing" }, ["component_id"]],
    [{ component_version: "99.0.0" }, ["component_version"]],
    [{ composition: "missing" }, ["composition"]],
    [{ in_frame: 30, out_frame: 29 }, ["out_frame"]],
    [{ props: { unknown: "value" } }, ["props", "unknown"]],
    [{ props: { ["x".repeat(64)]: true } }, ["props", "x".repeat(64)]],
    [{ props: { ["x".repeat(65)]: true } }, ["props"]],
    [{ props: { variant: "invalid" } }, ["props", "variant"]],
    [
      {
        props: {
          scale: {
            keyframes: [
              { frame: 0, value: 1, interpolation: { type: "linear" } },
              { frame: 10, value: 20, interpolation: { type: "linear" } },
            ],
          },
        },
      },
      ["props", "scale", "keyframes", 1, "value"],
    ],
    [{ component_id: "logo-reveal", props: { logo: "missing" } }, ["props", "logo"]],
  ])("rejects invalid component placement or props %j without writing", async (input, path) => {
    const invalid = await callError(client, "add_component", {
      ...meta(3, "invalid-component"),
      component_id: "kinetic-type",
      ...input,
    });
    expect(invalid).toMatchObject({ error: "invalid", errors: [{ path }] });
    expect(await version()).toBe(3);
  });

  it("bounds the diagnostic for a long unknown component version", async () => {
    const unknownVersion = `${"9".repeat(1024)}.0.0`;
    const invalid = await callError(client, "add_component", {
      ...meta(3, "long-component-version"),
      component_id: "kinetic-type",
      component_version: unknownVersion,
    });
    expect(invalid).toMatchObject({
      error: "invalid",
      errors: [{ path: ["component_version"] }],
    });
    expect(invalid.message).toContain(`${"9".repeat(61)}...`);
    expect(JSON.stringify(invalid)).not.toContain(unknownVersion);
  });

  describe("build_from_brief", () => {
    const asset = (id: string, type: "image" | "video") => ({
      type,
      name: id,
      uri: `assets/${id}`,
      sha256: "1".repeat(64),
      width: 320,
      height: 320,
      ...(type === "video" ? { fps: { num: 24, den: 1 }, frameCount: 20 } : {}),
    });

    const addMedia = () =>
      call(client, "apply_ops", {
        ...meta(3, "brief-assets"),
        ops: [
          { op: "addAsset", id: "poster", asset: asset("poster", "image") },
          { op: "addAsset", id: "clip", asset: asset("clip", "video") },
        ],
      });

    it("previews and commits a mixed storyboard as one replayable, undoable version", async () => {
      await addMedia();
      const args = {
        ...meta(4, "storyboard"),
        start_frame: 10,
        transition: "wipe",
        shots: [
          { type: "headline", text: "Launch", duration_frames: 30 },
          { type: "image", asset_id: "poster", duration_frames: 20 },
          {
            type: "video",
            asset_id: "clip",
            duration_frames: 11,
            source_offset_frames: 6,
            fit: "cover",
            lower_third: { title: "Demo" },
          },
          { type: "logo", wordmark: "Studio", duration_frames: 10 },
        ],
      };
      const preview = await call(client, "build_from_brief", { ...args, dry_run: true });
      expect(preview).toMatchObject({
        version: 4,
        dry_run: true,
        resolved: {
          composition: "main",
          in_frame: 10,
          out_frame: 81,
          shots: [
            { type: "headline", in_frame: 10, out_frame: 40 },
            { type: "image", in_frame: 40, out_frame: 60 },
            { type: "video", in_frame: 60, out_frame: 71 },
            { type: "logo", in_frame: 71, out_frame: 81 },
          ],
          transitions: [
            { type: "wipe", frame: 40, in_frame: 36, out_frame: 45 },
            { type: "wipe", frame: 60, in_frame: 56, out_frame: 65 },
            { type: "wipe", frame: 71, in_frame: 67, out_frame: 76 },
          ],
        },
        ops: [
          { layer: { componentId: "background", componentVersion: "1.0.0" } },
          { layer: { componentId: "kinetic-type", props: { text: "Launch" } } },
          {
            layer: {
              type: "image",
              assetId: "poster",
              transform: { scale: { value: [3.375, 3.375] } },
            },
          },
          {
            layer: {
              type: "video",
              assetId: "clip",
              startFrame: 54,
              transform: { scale: { value: [6, 6] } },
            },
          },
          { layer: { componentId: "lower-third", props: { title: "Demo", subtitle: "" } } },
          { layer: { componentId: "logo-reveal", props: { wordmark: "Studio" } } },
          { layer: { componentId: "transition" } },
          { layer: { componentId: "transition" } },
          { layer: { componentId: "transition" } },
        ],
      });
      expect(await version()).toBe(4);
      const written = await call(client, "build_from_brief", args);
      expect(written).toMatchObject({ version: 5, ops: preview.ops });
      expect(written.layers_added).toEqual(preview.layers_added);
      expect(written.layers_added).toHaveLength(9);
      expect(await call(client, "build_from_brief", args)).toMatchObject({
        version: 5,
        replayed: true,
      });
      expect(await call(client, "undo", meta(5, "undo-storyboard"))).toMatchObject({ version: 6 });
      const scene = (await call(client, "get_scene", { project_id })) as {
        compositions: { layers: { id: string }[] }[];
      };
      expect(scene.compositions[0]?.layers.map(({ id }) => id)).toEqual(["b", "a"]);
    });

    it("reports a hard cut when an adjacent shot has no room for a wipe", async () => {
      const r = await call(client, "build_from_brief", {
        ...meta(3, "short-storyboard"),
        dry_run: true,
        background: "transparent",
        transition: "wipe",
        shots: [
          { type: "headline", text: "One", duration_frames: 1 },
          { type: "headline", text: "Two", duration_frames: 2 },
        ],
      });
      expect(r).toMatchObject({ resolved: { transitions: [{ type: "cut", frame: 1 }] } });
      expect(r.ops).toHaveLength(2);
    });

    it("reports existing solo without changing it", async () => {
      await call(client, "update_layer", { ...meta(3, "solo"), layer: "a", set: { solo: true } });
      const r = await call(client, "build_from_brief", {
        ...meta(4, "solo-brief"),
        shots: [{ type: "headline", text: "Launch", duration_frames: 30 }],
      });
      expect(r).toMatchObject({
        version: 5,
        resolved: { warnings: [expect.stringContaining("Clear solo with update_layer")] },
      });
      expect(await call(client, "get_layer", { project_id, layer: "a" })).toMatchObject({
        layer: { solo: true },
      });
    });

    it.each([
      [{ type: "headline", text: "Long", duration_frames: 150 }, "duration_frames"],
      [{ type: "logo", duration_frames: 1 }, "wordmark"],
      [{ type: "headline", text: "W".repeat(200), duration_frames: 1 }, "text"],
      [{ type: "image", asset_id: "clip", duration_frames: 1 }, "asset_id"],
      [
        { type: "video", asset_id: "clip", duration_frames: 1, source_offset_frames: 25 },
        "source_offset_frames",
      ],
      [{ type: "video", asset_id: "clip", duration_frames: 26 }, "duration_frames"],
    ])("rejects shot %j without writing its valid predecessors", async (shot, field) => {
      await addMedia();
      const r = await callError(client, "build_from_brief", {
        ...meta(4, "invalid-storyboard"),
        shots: [{ type: "headline", text: "Valid", duration_frames: 1 }, shot],
      });
      expect(r).toMatchObject({ error: "invalid", errors: [{ path: ["shots", 1, field] }] });
      expect(await version()).toBe(4);
    });
  });

  describe("import_svg", () => {
    const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><title>Logo</title><rect x="0" y="0" width="100" height="50" fill="#ff0000"/></svg>`;
    const NOISY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs><text x="1" y="5">Hi</text><rect width="10" height="10" fill="#00f" clip-path="url(#c)"/></svg>`;
    const getLayer = async (id: string) =>
      (await call(client, "get_layer", { project_id, layer: id })) as {
        layer: {
          name: string;
          type: string;
          inFrame: number;
          outFrame: number;
          contents: unknown;
          transform: Record<string, { value: unknown }>;
        };
      };
    const ids = async () =>
      (
        (await call(client, "get_scene", { project_id })) as {
          compositions: { layers: { id: string }[] }[];
        }
      ).compositions.flatMap((c) => c.layers.map((l) => l.id));

    it("adds one shape layer built from the converter, centred, named by the title", async () => {
      const r = await call(client, "import_svg", { ...meta(3, "svg1"), svg: LOGO });
      expect(r).toMatchObject({ version: 4, changed: true, layers_added: ["svg"] });
      expect(r.resolved).toMatchObject({
        layer_id: "svg",
        name: "Logo",
        size: { width: 100, height: 50 },
        view_box: { x: 0, y: 0, width: 100, height: 50 },
        report: { entries: [], summary: { paths: 1, fills: 1 } },
      });
      const expected = importSvg(LOGO);
      const { layer } = await getLayer("svg");
      expect(layer).toMatchObject({ type: "shape", name: "Logo", inFrame: 0, outFrame: 150 });
      expect(layer.contents).toEqual(JSON.parse(JSON.stringify(expected.contents)));
      expect(layer.transform.anchorPoint?.value).toEqual(expected.anchorPoint);
      expect(layer.transform.position?.value).toEqual([960, 540]);
      expect(layer.transform.scale?.value).toEqual(expected.scale);
    });

    it("generates svg, svg-2, ... and defaults the name to SVG without a title", async () => {
      const bare = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0H4V4Z" fill="#000"/></svg>`;
      await call(client, "import_svg", { ...meta(3, "s1"), svg: bare });
      const second = await call(client, "import_svg", { ...meta(4, "s2"), svg: bare });
      expect(second.resolved).toMatchObject({ layer_id: "svg-2", name: "SVG" });
      expect(await ids()).toEqual(expect.arrayContaining(["svg", "svg-2"]));
    });

    it("honors name, layer_id, position, width and index", async () => {
      const r = await call(client, "import_svg", {
        ...meta(3, "opts"),
        svg: LOGO,
        name: "Mark",
        layer_id: "mark",
        position: [100, 200],
        width: 400,
        index: 2,
      });
      expect(r.resolved).toMatchObject({
        layer_id: "mark",
        name: "Mark",
        size: { width: 400, height: 200 },
      });
      const { layer } = await getLayer("mark");
      expect(layer.name).toBe("Mark");
      expect(layer.transform.position?.value).toEqual([100, 200]);
      expect(layer.transform.scale?.value).toEqual([4, 4]);
      expect((await ids()).indexOf("mark")).toBe(2);
    });

    it("targets a composition other than main", async () => {
      await call(client, "precompose", {
        ...meta(3, "pre"),
        layers: ["a"],
        composition_id: "inner",
      });
      const r = await call(client, "import_svg", {
        ...meta(4, "inner"),
        svg: LOGO,
        composition: "inner",
      });
      expect(r.ops).toBeUndefined();
      const scene = (await call(client, "get_scene", { project_id })) as {
        compositions: { id: string; layers: { id: string }[] }[];
      };
      expect(scene.compositions.find((c) => c.id === "inner")?.layers.map((l) => l.id)).toContain(
        "svg",
      );
      const e = await callError(client, "import_svg", {
        ...meta(5, "nocomp"),
        svg: LOGO,
        composition: "nope",
      });
      expect(e).toMatchObject({ error: "invalid", errors: [{ path: ["composition"] }] });
    });

    it("previews with the report and writes nothing on dry_run", async () => {
      const dry = await call(client, "import_svg", {
        ...meta(3, "dry"),
        svg: NOISY,
        dry_run: true,
      });
      expect(dry).toMatchObject({ dry_run: true, version: 3, changed: true });
      expect(dry.ops).toBeUndefined();
      expect(dry.resolved).toMatchObject({ layer_id: "svg" });
      const features = (
        dry.resolved as { report: { entries: { feature: string }[] } }
      ).report.entries.map((e) => e.feature);
      expect(features).toEqual(expect.arrayContaining(["text", "clip-path"]));
      expect(await version()).toBe(3);
      expect(await ids()).not.toContain("svg");
    });

    it("still adds a layer when nothing is paintable, and says why", async () => {
      const r = await call(client, "import_svg", {
        ...meta(3, "empty"),
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><text x="1" y="2">Hi</text></svg>`,
      });
      expect(r).toMatchObject({ version: 4, layers_added: ["svg"] });
      expect((await getLayer("svg")).layer.contents).toEqual([]);
      const report = (r.resolved as { report: { entries: { feature: string }[] } }).report;
      expect(report.entries.map((e) => e.feature)).toContain("text");
    });

    it("refuses unusable SVG as invalid input at svg and writes nothing", async () => {
      const bad = [
        "not xml at all",
        `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>`,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!-- ${"\u00e9".repeat(300 * 1024)} --></svg>`,
      ];
      for (const [i, svg] of bad.entries()) {
        const e = await callError(client, "import_svg", { ...meta(3, `bad-${i}`), svg });
        expect(e, `case ${i}`).toMatchObject({ error: "invalid" });
        expect((e.errors as { path: unknown[] }[])[0]?.path[0], `case ${i}`).toBe("svg");
      }
      expect(await version()).toBe(3);
    });

    it("keeps the reply small for a large SVG, written or dry-run", async () => {
      const paths = Array.from(
        { length: 2000 },
        (_, i) =>
          `<path d="M${i} 0 L${i + 5} 3 L${i} 9 Z" fill="#${(i % 4096).toString(16).padStart(3, "0")}"/>`,
      ).join("");
      const big = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2100 10">${paths}</svg>`;
      const size = (r: unknown) => JSON.stringify(r).length;
      const dry = await call(client, "import_svg", {
        ...meta(3, "big-dry"),
        svg: big,
        dry_run: true,
      });
      expect(size(dry)).toBeLessThan(20_000);
      expect(dry.ops).toBeUndefined();
      expect(await version()).toBe(3);
      expect(await ids()).not.toContain("svg");
      const written = await call(client, "import_svg", { ...meta(3, "big"), svg: big });
      expect(size(written)).toBeLessThan(20_000);
      expect(written.ops).toBeUndefined();
      expect(written).toMatchObject({ version: 4, layers_added: ["svg"] });
      const { layer } = await getLayer("svg");
      expect((layer.contents as unknown[]).length).toBeGreaterThan(0);
    });

    it("does not echo the expanded operations when they are rejected", async () => {
      const e = await callError(client, "import_svg", {
        ...meta(3, "dup"),
        svg: LOGO,
        layer_id: "a",
      });
      expect(e).toMatchObject({ error: "invalid" });
      expect(e.expanded_ops).toBeUndefined();
      expect(JSON.stringify(e).length).toBeLessThan(5_000);
    });

    it("refuses a width that overflows the layer scale, pointing at width", async () => {
      for (const width of [1e308, 5e-324]) {
        const e = await callError(client, "import_svg", {
          ...meta(3, `w-${width}`),
          svg: LOGO,
          width,
        });
        expect(e).toMatchObject({ error: "invalid", errors: [{ path: ["width"] }] });
      }
      expect(await version()).toBe(3);
    });

    it("replays a retry with the same key", async () => {
      const args = { ...meta(3, "replay"), svg: LOGO };
      const first = await call(client, "import_svg", args);
      const again = await call(client, "import_svg", args);
      expect(again).toMatchObject({ version: 4, replayed: true, layers_added: ["svg"] });
      expect(first).toMatchObject({ replayed: false, resolved: { layer_id: "svg" } });
      expect(await ids()).toEqual(expect.arrayContaining(["svg"]));
    });
  });

  describe("beat tools", () => {
    const BEATS = {
      bpm: 120,
      confidence: 0.8,
      timesMs: [500, 1000, 1500, 2000, 2500, 3000, 3500],
    };
    /** Beats land on frames 15, 30, ..., 105 at 30 fps. */
    const LINEAR = { type: "linear" };
    const BEAT_FRAMES = [15, 30, 45, 60, 75, 90, 105];

    /** Version 6: an audio asset with beats, the audio layer `song`, and solid `k` with opacity keys. */
    beforeEach(async () => {
      await call(client, "apply_ops", {
        ...meta(3, "song-asset"),
        ops: [
          {
            op: "addAsset",
            id: "song",
            asset: {
              type: "audio",
              name: "song",
              uri: "assets/song.flac",
              sha256: "1".repeat(64),
              durationMs: 4000,
              beats: BEATS,
            },
          },
        ],
      });
      await call(client, "add_layer", {
        ...meta(4, "song-layer"),
        composition: "main",
        id: "song",
        layer: { type: "audio", name: "song", assetId: "song" },
      });
      await call(client, "add_layer", {
        ...meta(5, "k-layer"),
        composition: "main",
        id: "k",
        layer: {
          type: "solid",
          name: "k",
          width: 100,
          height: 100,
          color: "#ffffff",
          transform: {
            opacity: {
              keyframes: [
                { frame: 13, value: 0, interpolation: LINEAR },
                { frame: 32, value: 1, interpolation: LINEAR },
                { frame: 100, value: 0.5, interpolation: LINEAR },
              ],
            },
          },
        },
      });
    });

    const markers = async (id: string) =>
      (
        (await call(client, "get_layer", { project_id, layer: id })) as {
          layer: { markers: { frame: number; name: string; durationFrames: number }[] };
        }
      ).layer.markers;
    const keyFrames = async (id: string) =>
      ((await opacityTrack(id)) as { keyframes: { frame: number }[] }).keyframes.map(
        (k) => k.frame,
      );
    const mark = (key: string, extra: Structured = {}, v = 6) =>
      call(client, "mark_beats", { ...meta(v, key), layer: "song", ...extra });

    it("marks the asset's beats, without echoing the ops", async () => {
      const r = await mark("m1");
      expect(r).toMatchObject({
        version: 7,
        changed: true,
        resolved: { layer_id: "song", source: "asset", bpm: 120, beat_count: 7, removed: 0 },
      });
      expect(r.ops).toBeUndefined();
      const found = await markers("song");
      expect(found.map((m) => m.frame)).toEqual(BEAT_FRAMES);
      expect(found.map((m) => m.name)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `beat ${n}`));
    });

    it("marks a bpm grid, and replace clears the old markers first", async () => {
      await mark("m1", { grid: { bpm: 60, first_beat_frame: 10, count: 3 } });
      expect((await markers("song")).map((m) => m.frame)).toEqual([10, 40, 70]);
      const refused = await callError(client, "mark_beats", {
        ...meta(7, "m2"),
        layer: "song",
      });
      expect(refused).toMatchObject({ error: "invalid", errors: [{ path: ["replace"] }] });
      const again = await mark("m3", { replace: true }, 7);
      expect(again).toMatchObject({ version: 8, resolved: { source: "asset", removed: 3 } });
      expect((await markers("song")).map((m) => m.frame)).toEqual(BEAT_FRAMES);
    });

    it("dry_run leaves the version unchanged and a replay doesn't write again", async () => {
      const dry = await mark("m1", { dry_run: true });
      expect(dry).toMatchObject({ dry_run: true, version: 6, changed: true });
      expect(await version()).toBe(6);
      expect(await markers("song")).toEqual([]);
      const first = await mark("m2");
      const again = await mark("m2");
      expect(again).toMatchObject({ version: 7, replayed: true });
      expect(first).toMatchObject({ replayed: false });
      expect(await version()).toBe(7);
      expect(await markers("song")).toHaveLength(7);
    });

    it("refuses a layer that isn't audio, and an asset without beats, pointing at the field", async () => {
      const notAudio = await callError(client, "mark_beats", {
        ...meta(6, "m1"),
        layer: "a",
      });
      expect(notAudio).toMatchObject({ error: "invalid", errors: [{ path: ["layer"] }] });
      expect(await version()).toBe(6);
      await mark("m2", { grid: { bpm: 120, first_beat_frame: 0, count: 1 } });
      await call(client, "apply_ops", {
        ...meta(7, "bare"),
        ops: [
          {
            op: "addAsset",
            id: "bare",
            asset: {
              type: "audio",
              name: "bare",
              uri: "assets/bare.flac",
              sha256: "2".repeat(64),
              durationMs: 4000,
            },
          },
        ],
      });
      await call(client, "add_layer", {
        ...meta(8, "bare-layer"),
        composition: "main",
        id: "bare",
        layer: { type: "audio", name: "bare", assetId: "bare" },
      });
      const none = await callError(client, "mark_beats", { ...meta(9, "m3"), layer: "bare" });
      expect(none).toMatchObject({ error: "invalid", errors: [{ path: ["grid"] }] });
      expect(await version()).toBe(9);
    });

    it("sync_to_beats snaps keyframes to the nearest beat", async () => {
      await mark("m1");
      const r = await call(client, "sync_to_beats", {
        ...meta(7, "s1"),
        layers: "k",
        audio_layer: "song",
      });
      expect(r).toMatchObject({
        version: 8,
        changed: true,
        layers_changed: ["k"],
        resolved: { audio_layer_id: "song", beat_count: 7, keyframes_moved: 3, cuts_moved: 0 },
      });
      expect(r.ops).toBeDefined();
      expect(await keyFrames("k")).toEqual([15, 30, 105]);
    });

    it("sync_to_beats slides a cut onto a beat and honors every", async () => {
      await mark("m1");
      await call(client, "update_layer", {
        ...meta(7, "u1"),
        layer: "k",
        set: { inFrame: 28, outFrame: 100, startFrame: 28 },
      });
      const r = await call(client, "sync_to_beats", {
        ...meta(8, "s1"),
        layers: "k",
        audio_layer: "song",
        snap: ["cuts"],
        every: 2,
        max_distance: 20,
      });
      // Every 2nd beat: 15, 45, 75, 105; 28 is 13 from 15 and 17 from 45, so the layer slides to 15.
      expect(r).toMatchObject({ resolved: { cuts_moved: 1, keyframes_moved: 0, beat_count: 4 } });
      const layer = (await call(client, "get_layer", { project_id, layer: "k" })) as {
        layer: { inFrame: number; outFrame: number; startFrame: number };
      };
      expect(layer.layer).toMatchObject({ inFrame: 15, outFrame: 87, startFrame: 15 });
    });

    it("sync_to_beats needs beat markers, and dry_run and replay behave", async () => {
      const none = await callError(client, "sync_to_beats", {
        ...meta(6, "s0"),
        layers: "k",
        audio_layer: "song",
      });
      expect(none).toMatchObject({ error: "invalid", errors: [{ path: ["audio_layer"] }] });
      expect(await version()).toBe(6);

      await mark("m1");
      const args = { ...meta(7, "s1"), layers: "k", audio_layer: "song" };
      const dry = await call(client, "sync_to_beats", { ...args, dry_run: true });
      expect(dry).toMatchObject({ dry_run: true, version: 7, changed: true });
      expect(await keyFrames("k")).toEqual([13, 32, 100]);
      await call(client, "sync_to_beats", args);
      const again = await call(client, "sync_to_beats", args);
      expect(again).toMatchObject({ replayed: true, version: 8 });
      expect(await version()).toBe(8);
    });
  });
});
