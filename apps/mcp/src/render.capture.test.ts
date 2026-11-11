import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaptureRenderer } from "./render.js";
import { createServer } from "./server.js";
import { KynimoService } from "./service.js";
import { MemoryStore } from "./store.js";

/**
 * The render tools end to end: a real MCP client, the real capture renderer (the built page in
 * the pinned Chromium on SwiftShader) and the client's output-schema validation.
 */
let renderer: CaptureRenderer;
let client: Client;
let project: string;

beforeAll(async () => {
  renderer = new CaptureRenderer();
  const server = createServer(new KynimoService(new MemoryStore(), "agent", { renderer }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  const created = await call("create_project", {
    name: "Render",
    idempotency_key: "c",
    width: 320,
    height: 180,
    duration_frames: 30,
    background: "#102030",
  });
  project = created.structuredContent?.id as string;
  await call("add_layer", {
    project_id: project,
    base_version: 1,
    idempotency_key: "a",
    composition: "main",
    layer: { type: "solid", name: "Box", width: 80, height: 80, color: "#ff8800" },
  });
  await call("set_keyframes", {
    project_id: project,
    base_version: 2,
    idempotency_key: "k",
    layer: { name: "Box" },
    property: "position",
    track: {
      keyframes: [
        { frame: 0, value: [60, 90], interpolation: { type: "linear" } },
        { frame: 29, value: [260, 90], interpolation: { type: "linear" } },
      ],
    },
  });
  await call("add_layer", {
    project_id: project,
    base_version: 3,
    idempotency_key: "fx",
    composition: "main",
    layer: {
      type: "component",
      name: "Badge",
      componentId: "badge",
      componentVersion: "1.0.0",
      props: {},
    },
    id: "badge",
  });
}, 60_000);

afterAll(async () => {
  await renderer?.close();
}, 60_000);

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r;
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(base64: string): [number, number] {
  const bytes = Buffer.from(base64, "base64");
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

const images = (r: CallToolResult) => r.content.flatMap((c) => (c.type === "image" ? [c] : []));

describe("render tools with the capture renderer", () => {
  it("renders an adjustment and the blur-in preset end to end", async () => {
    const created = await call("create_project", {
      name: "Effects",
      idempotency_key: "effects",
      width: 96,
      height: 64,
      duration_frames: 48,
      background: null,
    });
    const project_id = created.structuredContent?.id as string;
    const meta = (base_version: number, idempotency_key: string) => ({
      project_id,
      base_version,
      idempotency_key,
    });
    const render = async (...frames: number[]) => {
      const result = await call("render_frames", { project_id, frames });
      expect(result.structuredContent?.skipped).toEqual([]);
      return images(result).map((image) => image.data);
    };
    const [empty] = await render(30);
    await call("add_layer", {
      ...meta(1, "source"),
      id: "square",
      composition: "main",
      layer: { type: "solid", name: "Square", width: 24, height: 24, color: "#ff0000" },
    });
    const [plain] = await render(30);
    await call("add_layer", {
      ...meta(2, "grade"),
      id: "grade",
      composition: "main",
      layer: { type: "adjustment", name: "Grade" },
    });
    await call("add_effect", {
      ...meta(3, "hue"),
      layer: "grade",
      effect: { type: "hue-saturation", hue: { value: 120 }, saturation: { value: 0 } },
    });
    const [graded] = await render(30);
    expect(graded).not.toBe(plain);
    await call("apply_preset", {
      ...meta(4, "entrance"),
      layers: "square",
      preset: "blur-in",
      params: { radius: 24, duration: 1000, easing: { type: "linear" } },
    });
    const [start, middle, end] = await render(0, 15, 30);
    expect(start).toBe(empty);
    expect(middle).not.toBe(empty);
    expect(middle).not.toBe(graded);
    expect(end).toBe(graded);
  }, 60_000);

  it("returns downscaled PNG frames, lists skipped layers, and caches by document", async () => {
    const r = await call("render_frames", { project_id: project, frames: [0, 29], max_size: 160 });
    const imgs = images(r);
    expect(imgs.map((i) => [i.mimeType, ...pngSize(i.data)])).toEqual([
      ["image/png", 160, 90],
      ["image/png", 160, 90],
    ]);
    const s = r.structuredContent as {
      frames: { frame: number; cached: boolean; pixels_sha256: string }[];
      skipped: unknown[];
    };
    expect(s.frames.map((f) => [f.frame, f.cached])).toEqual([
      [0, false],
      [29, false],
    ]);
    // The box moved, so the frames differ.
    expect(s.frames[0]?.pixels_sha256).not.toBe(s.frames[1]?.pixels_sha256);
    expect(s.skipped).toEqual([
      {
        layer: "badge",
        type: "component",
        reason: "component evaluation arrives in M6",
        frames: [0, 29],
      },
    ]);
    const again = await call("render_frames", { project_id: project, frames: [29], max_size: 160 });
    const cached = again.structuredContent as typeof s;
    expect(cached.frames[0]).toEqual({ ...s.frames[1], cached: true });
    expect(images(again)[0]?.data).toBe(imgs[1]?.data);
  }, 60_000);

  it("returns one contact sheet image with the cells' frames", async () => {
    const r = await call("render_contact_sheet", { project_id: project, count: 4, cell_size: 96 });
    const [img] = images(r);
    expect(pngSize(img?.data ?? "")).toEqual([2 * 96 + 4, 2 * 54 + 4]);
    expect(r.structuredContent).toMatchObject({
      frames: [0, 10, 19, 29],
      columns: 2,
      rows: 2,
      cell_width: 96,
      cell_height: 54,
      cached: false,
    });
  }, 60_000);

  it("rejects requests over the declared limits before rendering", async () => {
    const r = (await client.callTool({
      name: "render_frames",
      arguments: { project_id: project, frames: Array.from({ length: 17 }, (_, i) => i) },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/at most 16 frames per call/);
  });
});
