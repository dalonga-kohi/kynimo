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

  it("blurs a moving solid with updateLayer motionBlur and leaves a still one alone", async () => {
    const created = await call("create_project", {
      name: "Blur",
      idempotency_key: "blur",
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
      const result = await call("render_frames", { project_id, frames: [10] });
      return images(result)[0]?.data ?? "";
    };
    await call("add_layer", {
      ...meta(1, "box"),
      id: "box",
      composition: "main",
      layer: { type: "solid", name: "Box", width: 16, height: 16, color: "#ff0000" },
    });
    await call("set_keyframes", {
      ...meta(2, "move"),
      layer: "box",
      property: "position",
      track: {
        keyframes: [
          { frame: 0, value: [8, 32], interpolation: { type: "linear" } },
          { frame: 20, value: [88, 32], interpolation: { type: "linear" } },
        ],
      },
    });
    const sharp = await render();
    await call("apply_ops", {
      ...meta(3, "blur"),
      ops: [{ op: "updateLayer", layer: "box", set: { motionBlur: { shutterAngle: 360 } } }],
    });
    const blurred = await render();
    expect(blurred).not.toBe(sharp);
    await call("apply_ops", {
      ...meta(4, "off"),
      ops: [{ op: "updateLayer", layer: "box", set: { motionBlur: null } }],
    });
    expect(await render()).toBe(sharp);
  }, 60_000);

  it("draws a 3D solid rotated about Y as a trapezoid through the default camera", async () => {
    const created = await call("create_project", {
      name: "Camera",
      idempotency_key: "camera",
      width: 192,
      height: 108,
      duration_frames: 30,
      background: "#000000",
    });
    const project_id = created.structuredContent?.id as string;
    const meta = (base_version: number, idempotency_key: string) => ({
      project_id,
      base_version,
      idempotency_key,
    });
    await call("add_layer", {
      ...meta(1, "camera"),
      id: "camera",
      composition: "main",
      layer: { type: "camera", name: "Camera" },
    });
    await call("add_layer", {
      ...meta(2, "card"),
      id: "card",
      composition: "main",
      layer: { type: "solid", name: "Card", width: 100, height: 80, color: "#ff0000" },
    });
    await call("set_keyframes", {
      ...meta(3, "anchor"),
      layer: "card",
      property: "anchorPoint",
      track: { value: [50, 40] },
    });
    await call("update_layer", { ...meta(4, "3d"), layer: "card", set: { threeD: true } });
    const render = async () => {
      const result = await call("render_frames", { project_id, frames: [0] });
      expect(result.structuredContent?.skipped).toEqual([]);
      return decodePng(images(result)[0]?.data ?? "");
    };
    /** The red extent of a column and of a row, in pixels. */
    const red = (f: ReturnType<typeof decodePng>, x: number, y: number) =>
      (f.at(x, y)[0] ?? 0) > 128;
    const columnHeight = (f: ReturnType<typeof decodePng>, x: number) =>
      Array.from({ length: f.height }, (_, y) => y).filter((y) => red(f, x, y)).length;
    const rowWidth = (f: ReturnType<typeof decodePng>, y: number) =>
      Array.from({ length: f.width }, (_, x) => x).filter((x) => red(f, x, y)).length;

    // Flat to the screen at z 0 and a 50 mm camera: the card keeps its 100 x 80 size.
    const flat = await render();
    expect(rowWidth(flat, 54)).toBeGreaterThanOrEqual(98);
    expect(columnHeight(flat, 96)).toBeGreaterThanOrEqual(78);
    expect(columnHeight(flat, 50)).toBe(columnHeight(flat, 142));

    await call("set_keyframes", {
      ...meta(5, "rot"),
      layer: "card",
      property: "rotationY",
      track: { value: 50 },
    });
    const turned = await render();
    // One side is nearer the camera, so the card is taller there: a trapezoid, narrower than flat.
    const nearHeight = Math.max(columnHeight(turned, 60), columnHeight(turned, 132));
    const farHeight = Math.min(columnHeight(turned, 60), columnHeight(turned, 132));
    expect(nearHeight).toBeGreaterThan(farHeight + 6);
    expect(rowWidth(turned, 54)).toBeLessThan(rowWidth(flat, 54) - 10);
    expect(rowWidth(turned, 54)).toBeGreaterThan(40);
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

  it("publishes, pins and renders immutable custom shader versions over MCP", async () => {
    const created = await call("create_project", {
      name: "Shaders",
      idempotency_key: "shader-project",
      width: 64,
      height: 64,
      duration_frames: 12,
      background: null,
    });
    const project_id = created.structuredContent?.id as string;
    const body = {
      project_id,
      id: "custom-red",
      title: "Red source",
      version: "1.0.0",
      kind: "generator",
      uniforms: { u_amount: { type: "float", default: 0.5 } },
      source: "return vec4(u_amount, 0.0, 0.0, 1.0);",
    };
    const define = (idempotency_key: string, overrides: Record<string, unknown> = {}) =>
      call("define_shader", { ...body, idempotency_key, ...overrides });
    const args = { ...body, idempotency_key: "shader-v1" };
    const [first, retry] = await Promise.all([
      call("define_shader", args),
      call("define_shader", args),
    ]);
    expect(retry.structuredContent).toEqual({
      ...first.structuredContent,
      replayed: retry.structuredContent?.replayed,
    });
    expect(first.structuredContent).toMatchObject({
      created: true,
      definition: { id: body.id, version: body.version },
    });
    expect([first, retry].filter((r) => r.structuredContent?.replayed === true)).toHaveLength(1);
    const definition = first.structuredContent?.definition;
    expect(definition).toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(definition).not.toHaveProperty("source");
    expect(
      (await call("get_write_outcome", { project_id, idempotency_key: "shader-v1" }))
        .structuredContent,
    ).toMatchObject({ status: "applied", version: 1, result: { definition } });

    const rejected = await client.callTool({
      name: "define_shader",
      arguments: {
        ...body,
        idempotency_key: "conflict",
        source: "return vec4(1.0);",
      },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("immutable");
    const invalid = await client.callTool({
      name: "define_shader",
      arguments: {
        ...body,
        idempotency_key: "syntax",
        version: "0.1.0",
        source: "return 1.0;",
      },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain("shader must return vec4");
    await define("shader-effect", {
      id: "custom-swap",
      title: "Swap channels",
      kind: "effect",
      uniforms: {},
      source: "vec4 c = sampleInput(uv); return vec4(c.bgr, c.a);",
    });
    const generator = {
      type: "custom-shader",
      shaderId: body.id,
      shaderVersion: body.version,
      uniforms: {
        u_amount: {
          keyframes: [
            { frame: 0, value: 0.25, interpolation: { type: "linear" } },
            { frame: 8, value: 1, interpolation: { type: "linear" } },
          ],
        },
      },
    };
    const layer = { type: "generator", name: "Source", width: 64, height: 64, generator };
    const add = { project_id, base_version: 1, composition: "main", id: "source" };
    const invalidBinding = await client.callTool({
      name: "add_layer",
      arguments: {
        ...add,
        idempotency_key: "wrong-uniform",
        layer: {
          ...layer,
          generator: { ...generator, uniforms: { u_amount: { value: [0, 0] } } },
        },
      },
    });
    expect(invalidBinding.isError).toBe(true);
    expect(JSON.stringify(invalidBinding.content)).toContain("must match the type");
    await call("add_layer", { ...add, idempotency_key: "shader-layer", layer });
    await call("add_effect", {
      project_id,
      base_version: 2,
      idempotency_key: "apply-shader",
      layer: "source",
      effect: {
        type: "custom-shader",
        shaderId: "custom-swap",
        shaderVersion: "1.0.0",
        uniforms: {},
      },
    });
    const before = images(await call("render_frames", { project_id, frames: [0] }))[0]?.data ?? "";
    expect(decodePng(before).at(32, 32)).toEqual([0, 0, 64, 255]);
    const next = await define("shader-v2", {
      version: "2.0.0",
      source: "return vec4(0.0, 1.0, 0.0, 1.0);",
    });
    expect(next.structuredContent?.definition).not.toMatchObject({
      hash: (definition as { hash: string }).hash,
    });
    const catalog = await call("list_definitions", { project_id });
    expect(catalog.structuredContent?.definitions).toMatchObject([
      { id: "custom-red", version: "1.0.0" },
      { id: "custom-red", version: "2.0.0" },
      { id: "custom-swap", version: "1.0.0" },
    ]);
    const resource = await client.readResource({
      uri: `kynimo://projects/${project_id}/shaders`,
    });
    const [entry] = resource.contents;
    if (entry === undefined || !("text" in entry)) throw new Error("expected shader catalog JSON");
    expect(JSON.parse(entry.text)).toMatchObject({
      definitions: catalog.structuredContent?.definitions,
    });

    const after = await call("render_frames", { project_id, frames: [8, 0], max_size: 64 });
    expect(after.structuredContent?.version).toBe(3);
    const [end, again] = images(after);
    expect(again?.data).toBe(before);
    expect(decodePng(end?.data ?? "").at(32, 32)).toEqual([0, 0, 255, 255]);
    await call("apply_ops", {
      project_id,
      base_version: 3,
      idempotency_key: "change-pin",
      ops: [
        {
          op: "setGenerator",
          layer: "source",
          generator: { ...generator, shaderVersion: "2.0.0" },
        },
      ],
    });
    const repinned =
      images(await call("render_frames", { project_id, frames: [0] }))[0]?.data ?? "";
    expect(decodePng(repinned).at(32, 32)).toEqual([0, 255, 0, 255]);
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
