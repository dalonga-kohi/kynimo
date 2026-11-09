import type { CapturedFrame } from "@kynimo/capture";
import type { Project } from "@kynimo/scene";
import { beforeEach, describe, expect, it } from "vitest";
import { base64, interTtf, solidPng } from "./assets.test-util.js";
import { type BlobStore, MemoryBlobStore } from "./blobs.js";
import { withLayerDefaults } from "./defaults.js";
import type { FrameRenderer, RenderMedia } from "./render.js";
import { KynimoService, MAX_UPLOAD_BYTES, ToolError } from "./service.js";
import { MemoryStore } from "./store.js";

/** Records the asset bytes each render was given. */
class AssetRecorder implements FrameRenderer {
  given: ReadonlyMap<string, Uint8Array>[] = [];
  givenFrames: ReadonlyMap<string, Uint8Array>[] = [];
  async build() {
    return "b";
  }
  async frames(
    _doc: Project,
    _c: string,
    frames: readonly number[],
    _s: number,
    media: RenderMedia,
  ) {
    this.given.push(media.assets);
    this.givenFrames.push(media.videoFrames);
    return frames.map(
      (frame): CapturedFrame => ({
        frame,
        width: 1,
        height: 1,
        png: new Uint8Array([frame]),
        pixelsSha256: "p",
        pngSha256: "q",
        skipped: [],
        warnings: [],
      }),
    );
  }
  async sheet(): Promise<never> {
    throw new Error("not used");
  }
  async close() {}
}

async function rejection(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a ToolError");
}

const settings = {
  width: 320,
  height: 180,
  fps: { num: 30, den: 1 },
  duration_frames: 30,
  background: null,
};

describe("assets", () => {
  let blobs: BlobStore;
  let renderer: AssetRecorder;
  let service: KynimoService;
  let project_id: string;
  const meta = (base_version: number, idempotency_key: string) => ({
    project_id,
    base_version,
    idempotency_key,
  });

  beforeEach(async () => {
    blobs = new MemoryBlobStore();
    renderer = new AssetRecorder();
    service = new KynimoService(new MemoryStore(), "agent", { blobs, renderer });
    ({ id: project_id } = await service.createProject({
      name: "P",
      idempotency_key: "c",
      ...settings,
    }));
  });

  it("uploads a PNG: stores the bytes and adds an entry whose fields come from the file", async () => {
    const png = solidPng(12, 5);
    const r = await service.uploadAsset(meta(1, "u"), { name: "logo.png", data: base64(png) });
    expect(r).toMatchObject({ version: 2, assets_added: ["asset-1"], replayed: false });
    expect(r.asset).toMatchObject({ id: "asset-1", type: "image", width: 12, height: 5 });
    expect(r.asset.uri).toBe(`assets/${r.asset.sha256}.png`);
    expect(await blobs.get(r.asset.uri)).toEqual(png);
  });

  it("uploads a font with its family and weight range, or under a given family", async () => {
    // The file declares the bundled family Inter, which an uploaded font may not reuse.
    const clash = await rejection(
      service.uploadAsset(meta(1, "f1"), { name: "inter.ttf", data: base64(interTtf()) }),
    );
    expect(clash.kind).toBe("invalid");
    expect(clash.errors[0]).toMatchObject({
      path: ["family"],
      message: expect.stringMatching(/bundled font family/),
    });
    const r = await service.uploadAsset(meta(1, "f2"), {
      name: "inter.ttf",
      data: base64(interTtf()),
      family: "Brand",
      id: "brand",
    });
    expect(r.asset).toMatchObject({
      id: "brand",
      type: "font",
      family: "Brand",
      weight: { min: 100, max: 900 },
    });
    expect(r.asset.uri).toMatch(/\.ttf$/);
  });

  it("replays a retry with the same key and bytes, and refuses the key for other bytes", async () => {
    const data = base64(solidPng(4, 4));
    const first = await service.uploadAsset(meta(1, "u"), { name: "a", data });
    const again = await service.uploadAsset(meta(1, "u"), { name: "a", data });
    expect(again).toMatchObject({ replayed: true, version: 2, asset: { id: first.asset.id } });
    const other = await rejection(
      service.uploadAsset(meta(1, "u"), { name: "a", data: base64(solidPng(5, 5)) }),
    );
    expect(other.kind).toBe("key_reused");
  });

  it("refuses bad base64, empty, oversized, unsupported and malformed files before writing", async () => {
    const tries: [string, RegExp][] = [
      ["not base64!", /base64/],
      ["", /empty/],
      [base64(new TextEncoder().encode("GIF89a........")), /unsupported file type/],
      [base64(solidPng(4, 4).subarray(0, 20)), /truncated or malformed/],
      [base64(new Uint8Array(MAX_UPLOAD_BYTES + 1)), /at most 8388608 bytes/],
      [base64(solidPng(9000, 1)), /at most 8192×8192/],
    ];
    for (const [data, message] of tries) {
      const e = await rejection(service.uploadAsset(meta(1, "x"), { name: "a", data }));
      expect(e.kind, String(message)).toBe("invalid");
      expect(e.message + JSON.stringify(e.errors), String(message)).toMatch(message);
    }
    expect((await service.getProject(project_id)).version).toBe(1);
  });

  it("refuses family for an image", async () => {
    const e = await rejection(
      service.uploadAsset(meta(1, "x"), { name: "a", data: base64(solidPng(2, 2)), family: "F" }),
    );
    expect(e.errors).toEqual([{ path: ["family"], message: expect.any(String) }]);
  });

  it("is unavailable without a blob store, saying why", async () => {
    const bare = new KynimoService(new MemoryStore(), "agent", { blobsUnavailable: "no bucket" });
    const { id } = await bare.createProject({ name: "P", idempotency_key: "c", ...settings });
    const e = await rejection(
      bare.uploadAsset(
        { project_id: id, base_version: 1, idempotency_key: "u" },
        { name: "a", data: base64(solidPng(2, 2)) },
      ),
    );
    expect(e).toMatchObject({ kind: "unavailable", message: expect.stringContaining("no bucket") });
  });

  it("lists assets with the layers that use them, and undo removes an upload", async () => {
    const up = await service.uploadAsset(meta(1, "u"), {
      name: "logo",
      data: base64(solidPng(10, 10)),
      id: "logo",
    });
    const layer = withLayerDefaults({ type: "image", name: "Logo", assetId: "logo" }, {
      width: 320,
      height: 180,
      durationFrames: 30,
    } as never);
    await service.write(meta(up.version, "l"), {
      kind: "ops",
      ops: [{ op: "addLayer", composition: "main", id: "pic", layer }],
    });
    expect((await service.listAssets(project_id)).assets).toEqual([
      expect.objectContaining({
        id: "logo",
        type: "image",
        width: 10,
        height: 10,
        used_by: ["pic"],
      }),
    ]);
    const removed = await rejection(
      service.write(meta(3, "r"), { kind: "ops", ops: [{ op: "removeAsset", asset: "logo" }] }),
    );
    expect(removed.errors[0]?.message).toMatch(/still used by layer 'pic'/);
  });

  const imageLayer = (assetId: string) =>
    withLayerDefaults({ type: "image", name: assetId, assetId }, {
      width: 320,
      height: 180,
      durationFrames: 30,
    } as never);

  it("gives renders the bytes of the assets the composition tree uses, and only those", async () => {
    const png = solidPng(3, 3);
    await service.uploadAsset(meta(1, "u"), { name: "a", data: base64(png), id: "a" });
    await service.uploadAsset(meta(2, "u2"), { name: "b", data: base64(solidPng(4, 4)), id: "b" });
    // An entry nothing draws, whose bytes this server never had: it must not block renders.
    await service.write(meta(3, "x"), {
      kind: "ops",
      ops: [
        {
          op: "addAsset",
          id: "stray",
          asset: {
            type: "image",
            name: "stray",
            uri: "assets/stray.png",
            sha256: "c".repeat(64),
            width: 1,
            height: 1,
          },
        },
        { op: "addLayer", composition: "main", id: "pic", layer: imageLayer("a") },
        { op: "addLayer", composition: "main", id: "other", layer: imageLayer("b") },
        { op: "precompose", layers: ["other"], id: "inner" },
      ],
    });
    await service.renderFrames(project_id, { frames: [0], max_size: 64 });
    expect([...(renderer.given[0]?.keys() ?? [])].sort()).toEqual(["a", "b"]);
    expect(renderer.given[0]?.get("a")).toEqual(png);
  });

  it("fails a render clearly when a used asset's bytes are gone or were never uploaded", async () => {
    const empty = new KynimoService(new MemoryStore(), "agent", {
      blobs: new MemoryBlobStore(),
      renderer,
    });
    const { id } = await empty.createProject({ name: "P", idempotency_key: "c", ...settings });
    const entry = (uri: string) => ({
      type: "image",
      name: "x",
      uri,
      sha256: "d".repeat(64),
      width: 1,
      height: 1,
    });
    await empty.write(
      { project_id: id, base_version: 1, idempotency_key: "a" },
      {
        kind: "ops",
        ops: [
          { op: "addAsset", id: "a", asset: entry(`assets/${"d".repeat(64)}.png`) },
          { op: "addLayer", composition: "main", layer: imageLayer("a") },
        ],
      },
    );
    expect(await rejection(empty.renderFrames(id, { frames: [0], max_size: 64 }))).toMatchObject({
      kind: "render_failed",
      message: expect.stringMatching(/'a'.*missing from/),
    });
    // An entry written by hand (apply_ops) with a key upload_asset never makes.
    await empty.write(
      { project_id: id, base_version: 2, idempotency_key: "b" },
      {
        kind: "ops",
        ops: [
          { op: "addAsset", id: "hand", asset: entry("assets/logo.png") },
          { op: "addLayer", composition: "main", layer: imageLayer("hand") },
          { op: "removeLayer", layer: { name: "a" } },
          { op: "removeAsset", asset: "a" },
        ],
      },
    );
    expect(await rejection(empty.renderFrames(id, { frames: [0], max_size: 64 }))).toMatchObject({
      kind: "render_failed",
      message: expect.stringMatching(/'hand'.*not stored by upload_asset/),
    });
  });
});
