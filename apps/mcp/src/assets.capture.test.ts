import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base64, hasFfmpeg, interTtf, makeClip, solidPng } from "./assets.test-util.js";
import { blobKey, MemoryBlobStore } from "./blobs.js";
import { Ffmpeg } from "./media.js";
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
const blobs = new MemoryBlobStore();
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
  animators: [],
  fill: { value: "#ffffff" },
  transform: { position: { value: [20, 60] } },
});

beforeAll(async () => {
  renderer = new CaptureRenderer();
  const server = createServer(
    new KynimoService(new MemoryStore(), "agent", {
      renderer,
      blobs,
      ...(hasFfmpeg ? { media: new Ffmpeg() } : {}),
    }),
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
  it("loads images emitted by a version-pinned project component", async () => {
    const project_id = await project("component-image");
    const uploaded = await call("upload_asset", {
      project_id,
      base_version: 1,
      idempotency_key: "upload",
      name: "green.png",
      data: base64(solidPng(40, 20, [0, 255, 0, 255])),
    });
    const asset = uploaded.asset as { id: string };
    await call("define_component", {
      project_id,
      idempotency_key: "define",
      id: "custom-image",
      version: "1.0.0",
      title: "Image",
      description: "Draw the uploaded image",
      props: {
        image: { type: "asset", assetType: "image", description: "Image to draw", default: null },
      },
      source: `export function evaluate(props, ctx) {
        const layers = [];
        layers.push(layer({ id: "image", type: "image", name: "Image", assetId: props.image }));
        return { width: ctx.width, height: ctx.height, layers };
      }`,
    });
    await call("add_component", {
      project_id,
      base_version: 2,
      idempotency_key: "place",
      component_id: "custom-image",
      props: { image: asset.id },
    });
    const plain = await project("component-image-control");
    await call("add_layer", {
      project_id: plain,
      base_version: 1,
      idempotency_key: "solid",
      composition: "main",
      layer: { type: "solid", name: "Green", width: 40, height: 20, color: "#00ff00" },
    });
    const actual = await frame0(project_id);
    expect(actual.skipped).toEqual([]);
    expect(actual.pixels).toBe((await frame0(plain)).pixels);
  }, 60_000);

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

  it("renders a video shot at its trim offset through the storyboard tool", async () => {
    const project_id = await project("storyboard-video");
    const jpeg = new Uint8Array(
      readFileSync(new URL("./fixtures/rotated-40x20-orientation-6.jpg", import.meta.url)),
    );
    const frameHash = createHash("sha256").update(jpeg).digest("hex");
    // Only source frame 1 exists. Loading source frame 0 would fail the render.
    await blobs.put(blobKey(frameHash, "jpg"), jpeg, "image/jpeg");
    const manifest = new TextEncoder().encode(
      JSON.stringify({ frames: ["0".repeat(64), frameHash] }),
    );
    const sha256 = createHash("sha256").update(manifest).digest("hex");
    const uri = blobKey(sha256, "json");
    await blobs.put(uri, manifest, "application/json");
    await call("apply_ops", {
      project_id,
      base_version: 1,
      idempotency_key: "storyboard-clip",
      ops: [
        {
          op: "addAsset",
          id: "clip",
          asset: {
            type: "video",
            name: "Clip",
            width: 20,
            height: 40,
            fps: { num: 30, den: 1 },
            frameCount: 2,
            sha256,
            uri,
          },
        },
      ],
    });
    const empty = await frame0(project_id);
    await call("build_from_brief", {
      project_id,
      base_version: 2,
      idempotency_key: "storyboard-video",
      background: "transparent",
      shots: [{ type: "video", asset_id: "clip", duration_frames: 1, source_offset_frames: 1 }],
    });
    const rendered = await frame0(project_id);
    expect(rendered).toMatchObject({ skipped: [], warnings: [] });
    expect(rendered.pixels).not.toBe(empty.pixels);
  }, 60_000);

  it.runIf(hasFfmpeg || process.env.CI !== undefined)(
    "draws an uploaded clip's frame exactly like an image of that decoded frame",
    async () => {
      const withVideo = await project("video");
      const up = await call("upload_asset", {
        project_id: withVideo,
        base_version: 1,
        idempotency_key: "u",
        name: "clip.mp4",
        data: base64(makeClip({ width: 64, height: 36, fps: "30", seconds: 1 })),
      });
      const asset = up.asset as { id: string; uri: string };
      await call("add_layer", {
        project_id: withVideo,
        base_version: 2,
        idempotency_key: "l",
        composition: "main",
        layer: { type: "video", name: "Clip", assetId: asset.id },
      });
      // Frame 0 of the manifest, uploaded again as a plain JPEG image.
      const manifest = JSON.parse(
        new TextDecoder().decode((await blobs.get(asset.uri)) as Uint8Array),
      ) as { frames: string[] };
      const jpeg = (await blobs.get(`assets/${manifest.frames[0]}.jpg`)) as Uint8Array;
      const withImage = await project("still");
      const still = await call("upload_asset", {
        project_id: withImage,
        base_version: 1,
        idempotency_key: "u",
        name: "frame0.jpg",
        data: base64(jpeg),
      });
      await call("add_layer", {
        project_id: withImage,
        base_version: 2,
        idempotency_key: "l",
        composition: "main",
        layer: { type: "image", name: "Clip", assetId: (still.asset as { id: string }).id },
      });
      const video = await frame0(withVideo);
      expect(video).toMatchObject({ skipped: [], warnings: [] });
      expect(video.pixels).toBe((await frame0(withImage)).pixels);
    },
    60_000,
  );
});
