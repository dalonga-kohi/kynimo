import { importSvg } from "@kynimo/svg";
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
});
