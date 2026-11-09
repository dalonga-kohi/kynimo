import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base64, interTtf, solidPng } from "./assets.test-util.js";
import { MemoryBlobStore } from "./blobs.js";
import { CaptureRenderer } from "./render.js";
import { createServer } from "./server.js";
import { KynimoService } from "./service.js";
import { MemoryStore } from "./store.js";

/**
 * Uploaded assets end to end: a real MCP client uploads files, and the real capture renderer
 * draws them. Each check compares against a document that draws the same pixels without the
 * asset, so it needs no approved image.
 */
let renderer: CaptureRenderer;
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return r.structuredContent as Record<string, unknown>;
}

async function project(key: string): Promise<string> {
  const created = await call("create_project", {
    name: key,
    idempotency_key: key,
    width: 160,
    height: 90,
    duration_frames: 10,
    background: "#000000",
  });
  return created.id as string;
}

const frame0 = async (project_id: string) => {
  const r = await call("render_frames", { project_id, frames: [0], max_size: 160 });
  return {
    pixels: (r.frames as { pixels_sha256: string }[])[0]?.pixels_sha256,
    skipped: r.skipped,
    warnings: r.warnings,
  };
};

const text = (family: string) => ({
  type: "text",
  name: "Title",
  content: { value: "Hi" },
  box: { mode: "point" },
  font: { family, weight: 700, size: { value: 40 } },
  tracking: { value: 0 },
  leading: { value: 1.2 },
  align: "left",
  textCase: "none",
  fill: { value: "#ffffff" },
  transform: { position: { value: [20, 60] } },
});

beforeAll(async () => {
  renderer = new CaptureRenderer();
  const server = createServer(
    new KynimoService(new MemoryStore(), "agent", { renderer, blobs: new MemoryBlobStore() }),
  );
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  await client.listTools();
}, 60_000);

afterAll(async () => {
  await client.close();
  await renderer.close();
});

describe("uploaded assets in rendered frames", () => {
  it("draws an uploaded PNG exactly like a solid of its color and size", async () => {
    const withImage = await project("img");
    const up = await call("upload_asset", {
      project_id: withImage,
      base_version: 1,
      idempotency_key: "u",
      name: "green.png",
      data: base64(solidPng(40, 20, [0, 255, 0, 255])),
    });
    await call("add_layer", {
      project_id: withImage,
      base_version: 2,
      idempotency_key: "l",
      composition: "main",
      layer: { type: "image", name: "Green", assetId: (up.asset as { id: string }).id },
    });
    const withSolid = await project("solid");
    await call("add_layer", {
      project_id: withSolid,
      base_version: 1,
      idempotency_key: "l",
      composition: "main",
      layer: { type: "solid", name: "Green", width: 40, height: 20, color: "#00ff00" },
    });
    const image = await frame0(withImage);
    expect(image).toMatchObject({ skipped: [], warnings: [] });
    expect(image.pixels).toBe((await frame0(withSolid)).pixels);
  }, 60_000);

  it("draws a camera JPEG turned by its EXIF orientation, with the turned size recorded", async () => {
    // 40×20 pixels stored, orientation 6: it decodes (and draws) 20×40.
    const jpeg = new Uint8Array(
      readFileSync(new URL("./fixtures/rotated-40x20-orientation-6.jpg", import.meta.url)),
    );
    const p = await project("jpeg");
    const up = await call("upload_asset", {
      project_id: p,
      base_version: 1,
      idempotency_key: "u",
      name: "photo.jpg",
      data: base64(jpeg),
    });
    expect(up.asset).toMatchObject({ type: "image", width: 20, height: 40 });
    await call("add_layer", {
      project_id: p,
      base_version: 2,
      idempotency_key: "l",
      composition: "main",
      layer: { type: "image", name: "Photo", assetId: (up.asset as { id: string }).id },
    });
    expect(await frame0(p)).toMatchObject({ skipped: [], warnings: [] });
  }, 60_000);

  it("shapes text with an uploaded font exactly like the same bundled file", async () => {
    const uploaded = await project("font");
    await call("upload_asset", {
      project_id: uploaded,
      base_version: 1,
      idempotency_key: "u",
      name: "inter.ttf",
      data: base64(interTtf()),
      family: "Brand",
    });
    await call("add_layer", {
      project_id: uploaded,
      base_version: 2,
      idempotency_key: "t",
      composition: "main",
      layer: text("Brand"),
    });
    const bundled = await project("bundled");
    await call("add_layer", {
      project_id: bundled,
      base_version: 1,
      idempotency_key: "t",
      composition: "main",
      layer: text("Inter"),
    });
    const brand = await frame0(uploaded);
    expect(brand).toMatchObject({ skipped: [], warnings: [] });
    expect(brand.pixels).toBe((await frame0(bundled)).pixels);
  }, 60_000);
});
