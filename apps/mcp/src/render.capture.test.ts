import { inflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base64, solidPng } from "./assets.test-util.js";
import { MemoryBlobStore } from "./blobs.js";
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
  const server = createServer(
    new KynimoService(new MemoryStore(), "agent", { renderer, blobs: new MemoryBlobStore() }),
  );
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

/** RGBA pixels of an 8-bit, non-interlaced RGB or RGBA PNG (what the capture renderer writes). */
function decodePng(base64: string): {
  width: number;
  height: number;
  at: (x: number, y: number) => number[];
} {
  const bytes = Buffer.from(base64, "base64");
  const [width, height] = pngSize(base64);
  const depth = bytes[24];
  const channels = bytes[25] === 6 ? 4 : bytes[25] === 2 ? 3 : 0;
  expect([depth, channels > 0, bytes[28]]).toEqual([8, true, 0]);
  const chunks: Buffer[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    if (bytes.subarray(at + 4, at + 8).toString("latin1") === "IDAT")
      chunks.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= channels ? (out[y * stride + i - channels] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= channels ? (out[(y - 1) * stride + i - channels] ?? 0) : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter ?? 0] ?? 0;
      out[y * stride + i] = (x + predictor) & 255;
    }
  }
  return {
    width,
    height,
    at: (x, y) => {
      const o = y * stride + x * channels;
      return [
        out[o] ?? 0,
        out[o + 1] ?? 0,
        out[o + 2] ?? 0,
        channels === 4 ? (out[o + 3] ?? 0) : 255,
      ];
    },
  };
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

  it("renders a generator layer and a vignette look end to end", async () => {
    const created = await call("create_project", {
      name: "Generators",
      idempotency_key: "generators",
      width: 96,
      height: 64,
      duration_frames: 30,
      background: null,
    });
    const project_id = created.structuredContent?.id as string;
    const meta = (base_version: number, idempotency_key: string) => ({
      project_id,
      base_version,
      idempotency_key,
    });
    const render = async () => {
      const result = await call("render_frames", { project_id, frames: [0] });
      expect(result.structuredContent?.skipped).toEqual([]);
      const [image] = images(result);
      return decodePng(image?.data ?? "");
    };
    const gradient = (end: string) => ({
      type: "gradient",
      kind: "linear",
      start: { value: [0, 0] },
      end: { value: [96, 0] },
      stops: {
        value: [
          { offset: 0, color: "#ffffff" },
          { offset: 1, color: end },
        ],
      },
    });
    await call("add_layer", {
      ...meta(1, "backdrop"),
      id: "backdrop",
      composition: "main",
      layer: {
        type: "generator",
        name: "Backdrop",
        width: 96,
        height: 64,
        transform: { position: { value: [0, 0] } },
        generator: gradient("#000000"),
      },
    });
    const dark = await render();
    expect(dark.at(90, 32)[0]).toBeLessThan(40);
    await call("apply_ops", {
      ...meta(2, "restyle"),
      ops: [{ op: "setGenerator", layer: "backdrop", generator: gradient("#c0c0ff") }],
    });
    const plain = await render();
    expect(plain.at(48, 32)[3]).toBe(255);
    expect(plain.at(48, 32)[0]).toBeGreaterThan(200);
    expect(plain.at(2, 2)[0]).toBeGreaterThan(240);
    await call("add_layer", {
      ...meta(3, "look"),
      id: "look",
      composition: "main",
      index: 0,
      layer: { type: "adjustment", name: "Look" },
    });
    await call("add_effect", {
      ...meta(4, "vignette"),
      layer: "look",
      effect: {
        type: "vignette",
        amount: { value: 0.9 },
        radius: { value: 0.3 },
        feather: { value: 0.6 },
        color: { value: "#000000" },
      },
    });
    const looked = await render();
    const sum = ([r, g, b]: number[]) => (r ?? 0) + (g ?? 0) + (b ?? 0);
    expect(looked.at(48, 32)[3]).toBe(255);
    expect(sum(looked.at(48, 32))).toBeGreaterThan(sum(looked.at(1, 1)) + 200);
    expect(sum(looked.at(1, 1))).toBeLessThan(sum(plain.at(1, 1)));
  }, 60_000);

  it("renders a placed component at its local midpoint and composition origin", async () => {
    const created = await call("create_project", {
      name: "Components",
      idempotency_key: "components",
      width: 96,
      height: 64,
      duration_frames: 30,
      background: "#102030",
    });
    const project_id = created.structuredContent?.id as string;
    await call("add_component", {
      project_id,
      base_version: 1,
      idempotency_key: "cover",
      component_id: "transition",
      component_version: "1.0.0",
      in_frame: 10,
      out_frame: 19,
      props: { color: "#ff0000" },
    });
    const result = await call("render_frames", { project_id, frames: [9, 14, 19] });
    expect(result.structuredContent?.skipped).toEqual([]);
    expect(images(result).map(({ data }) => decodePng(data).at(1, 1))).toEqual([
      [16, 32, 48, 255],
      [255, 0, 0, 255],
      [16, 32, 48, 255],
    ]);
  }, 60_000);

  it("renders headline, contained image, and logo shots with a wipe covering the cut", async () => {
    const created = await call("create_project", {
      name: "Storyboard",
      idempotency_key: "storyboard",
      width: 320,
      height: 180,
      duration_frames: 72,
    });
    const project_id = created.structuredContent?.id as string;
    const uploaded = await call("upload_asset", {
      project_id,
      base_version: 1,
      idempotency_key: "storyboard-image",
      name: "poster.png",
      data: base64(solidPng(40, 80, [0, 255, 0, 255])),
    });
    await call("build_from_brief", {
      project_id,
      base_version: 2,
      idempotency_key: "storyboard-build",
      transition: "wipe",
      shots: [
        { type: "headline", text: "A new chapter", duration_frames: 24 },
        {
          type: "image",
          asset_id: (uploaded.structuredContent?.asset as { id: string } | undefined)?.id,
          duration_frames: 24,
        },
        { type: "logo", wordmark: "Studio", duration_frames: 24 },
      ],
    });
    const result = await call("render_frames", { project_id, frames: [16, 24, 36, 68] });
    expect(result.structuredContent?.skipped).toEqual([]);
    const frames = images(result);
    expect(new Set(frames.map(({ data }) => data)).size).toBe(4);
    const wipe = decodePng(frames[1]?.data ?? "");
    expect(wipe.at(1, 1)).toEqual([41, 151, 255, 255]);
    expect(wipe.at(318, 178)).toEqual([41, 151, 255, 255]);
    const poster = decodePng(frames[2]?.data ?? "");
    expect(poster.at(160, 90)).toEqual([0, 255, 0, 255]);
    expect(poster.at(16, 90)[1]).toBeLessThan(40);
  }, 60_000);

  it("keeps wide and tall storyboard headlines inside the portrait frame", async () => {
    const created = await call("create_project", {
      name: "Portrait storyboard",
      idempotency_key: "portrait-storyboard",
      width: 180,
      height: 320,
      duration_frames: 120,
    });
    const project_id = created.structuredContent?.id as string;
    await call("build_from_brief", {
      project_id,
      base_version: 1,
      idempotency_key: "portrait-build",
      shots: [
        { type: "headline", text: "A new chapter", duration_frames: 60 },
        { type: "headline", text: Array(20).fill("W").join("\n"), duration_frames: 60 },
      ],
    });
    const result = await call("render_frames", { project_id, frames: [59, 119] });
    const frames = images(result);
    expect(frames).toHaveLength(2);
    for (const { data } of frames) {
      const frame = decodePng(data);
      let lit = 0;
      let litOutside = 0;
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          if ((frame.at(x, y)[0] ?? 0) <= 180) continue;
          lit++;
          if (x < 12 || x >= frame.width - 12 || y < 18 || y >= frame.height - 18) litOutside++;
        }
      }
      expect(lit).toBeGreaterThan(100);
      expect(litOutside).toBe(0);
    }
  }, 60_000);

  it("returns downscaled PNG frames and caches by document", async () => {
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
    expect(s.skipped).toEqual([]);
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
