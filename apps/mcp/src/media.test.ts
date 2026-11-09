import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Project, ProjectSchema, SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { beforeEach, describe, expect, it } from "vitest";
import { base64, hasFfmpeg, makeClip, makeTone, solidPng } from "./assets.test-util.js";
import { type BlobStore, MemoryBlobStore } from "./blobs.js";
import { withLayerDefaults } from "./defaults.js";
import {
  Ffmpeg,
  JpegSplitter,
  MediaError,
  type MediaTools,
  parseRate,
  readProbe,
} from "./media.js";
import type { FrameRenderer, RenderMedia } from "./render.js";
import { isMediaFile, KynimoService, shownVideoFrames, ToolError } from "./service.js";
import { MemoryStore } from "./store.js";

describe("readProbe", () => {
  const video = (extra: Record<string, unknown> = {}) => ({
    codec_type: "video",
    width: 1920,
    height: 1080,
    avg_frame_rate: "30000/1001",
    r_frame_rate: "30000/1001",
    ...extra,
  });

  it("reads the display size, rate, audio and duration", () => {
    expect(
      readProbe({
        streams: [video(), { codec_type: "audio" }],
        format: { duration: "2.5" },
      }),
    ).toEqual({
      video: { width: 1920, height: 1080, fps: { num: 30000, den: 1001 } },
      hasAudio: true,
      durationMs: 2500,
    });
  });

  it("swaps the size for quarter-turn rotation, from side data or the legacy tag", () => {
    const turned = { width: 1080, height: 1920 };
    expect(
      readProbe({ streams: [video({ side_data_list: [{ rotation: -90 }] })] }).video,
    ).toMatchObject(turned);
    expect(readProbe({ streams: [video({ tags: { rotate: "270" } })] }).video).toMatchObject(
      turned,
    );
    expect(
      readProbe({ streams: [video({ side_data_list: [{ rotation: 180 }] })] }).video,
    ).toMatchObject({ width: 1920, height: 1080 });
  });

  it("treats cover art as no video and falls back to r_frame_rate", () => {
    expect(
      readProbe({
        streams: [video({ disposition: { attached_pic: 1 } }), { codec_type: "audio" }],
      }),
    ).toEqual({ hasAudio: true, durationMs: 0 });
    expect(readProbe({ streams: [video({ avg_frame_rate: "0/0" })] }).video?.fps).toEqual({
      num: 30000,
      den: 1001,
    });
    expect(parseRate("0/0")).toBeUndefined();
    expect(parseRate("25/1")).toEqual({ num: 25, den: 1 });
  });
});

describe("readProbe limits and pixel aspect", () => {
  it("refuses sources over 8192 px or 2^26 pixels, before anything decodes", () => {
    const v = (width: number, height: number) => ({
      streams: [{ codec_type: "video", width, height, avg_frame_rate: "30/1" }],
    });
    expect(() => readProbe(v(9000, 100))).toThrow(MediaError);
    expect(() => readProbe(v(8000, 8500))).toThrow(/67108864 pixels/);
    expect(readProbe(v(8192, 4096)).video).toMatchObject({ width: 8192, height: 4096 });
  });

  it("widens anamorphic footage to its display aspect", () => {
    const probe = readProbe({
      streams: [
        {
          codec_type: "video",
          width: 720,
          height: 480,
          sample_aspect_ratio: "4:3",
          avg_frame_rate: "30/1",
        },
      ],
    });
    expect(probe.video).toMatchObject({ width: 960, height: 480 });
  });
});

describe("shownVideoFrames", () => {
  it("maps through a precomp at its own frame rate", () => {
    const size = { width: 64, height: 36, durationFrames: 30 } as never;
    const video = (startFrame: number) =>
      withLayerDefaults({ type: "video", name: "V", assetId: "clip", startFrame }, size);
    const doc = ProjectSchema.parse({
      formatVersion: SCENE_FORMAT_VERSION,
      name: "P",
      mainCompositionId: "main",
      style: null,
      assets: [
        {
          id: "clip",
          name: "clip",
          type: "video",
          uri: `assets/${"0".repeat(64)}.json`,
          sha256: "0".repeat(64),
          width: 64,
          height: 36,
          fps: { num: 10, den: 1 },
          frameCount: 20,
        },
      ],
      compositions: [
        {
          id: "main",
          name: "main",
          width: 64,
          height: 36,
          fps: { num: 30, den: 1 },
          durationFrames: 30,
          background: null,
          markers: [],
          layers: [
            withLayerDefaults({ type: "precomp", name: "P", compositionId: "inner" }, size),
          ].map((l, i) => ({ ...(l as object), id: `p${i}` })),
        },
        {
          id: "inner",
          name: "inner",
          width: 64,
          height: 36,
          fps: { num: 15, den: 1 },
          durationFrames: 15,
          background: null,
          markers: [],
          layers: [{ ...(video(1) as object), id: "iv" }],
        },
      ],
    });
    // Main frame 20 (30 fps) → inner frame 10 (15 fps) → layer frame 9 → source floor(9·10/15) = 6.
    expect(shownVideoFrames(doc, "main", [0, 20])).toEqual(new Map([["clip", new Set([6])]]));
  });
});

describe("JpegSplitter", () => {
  const jpeg = new Uint8Array(
    readFileSync(new URL("./fixtures/rotated-40x20-orientation-6.jpg", import.meta.url)),
  );

  it("splits concatenated JPEG files exactly, however the stream is chunked", () => {
    const stream = new Uint8Array([...jpeg, ...jpeg, ...jpeg]);
    for (const size of [1, 7, 4096]) {
      const split = new JpegSplitter();
      const out: Uint8Array[] = [];
      for (let i = 0; i < stream.length; i += size)
        out.push(...split.push(stream.subarray(i, i + size)));
      expect(out, String(size)).toEqual([jpeg, jpeg, jpeg]);
      expect(split.pending).toBe(false);
    }
  });

  it("keeps a partial file pending and refuses a stream that is not JPEG", () => {
    const split = new JpegSplitter();
    expect(split.push(jpeg.subarray(0, 100))).toEqual([]);
    expect(split.pending).toBe(true);
    expect(() => new JpegSplitter().push(new TextEncoder().encode("not a jpeg"))).toThrow(
      MediaError,
    );
  });
});

describe("isMediaFile", () => {
  it("recognizes container signatures and nothing else", () => {
    const text = (t: string) => new TextEncoder().encode(t);
    expect(isMediaFile(text("\0\0\0\x18ftypisom"))).toBe(true);
    expect(isMediaFile(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0]))).toBe(true);
    expect(isMediaFile(text("RIFF\0\0\0\0WAVEfmt "))).toBe(true);
    expect(isMediaFile(text("ID3\x04"))).toBe(true);
    expect(isMediaFile(text("#EXTM3U\nfile:///etc/passwd"))).toBe(false);
    expect(isMediaFile(text("ffconcat version 1.0"))).toBe(false);
    expect(isMediaFile(solidPng(2, 2))).toBe(false);
  });
});

/** Records video frames each render was given. */
class Recorder implements FrameRenderer {
  given: RenderMedia[] = [];
  async build() {
    return "b";
  }
  async frames(_d: Project, _c: string, frames: readonly number[], _s: number, m: RenderMedia) {
    this.given.push(m);
    return frames.map((frame) => ({
      frame,
      width: 1,
      height: 1,
      png: new Uint8Array([frame]),
      pixelsSha256: "p",
      pngSha256: "q",
      skipped: [],
      warnings: [],
    }));
  }
  async sheet(): Promise<never> {
    throw new Error("not used");
  }
  async close() {}
}

/** Counts decodes, so tests can see a retry does not decode again. */
class Counting implements MediaTools {
  decodes = 0;
  constructor(private readonly inner: MediaTools) {}
  version() {
    return this.inner.version();
  }
  probe(file: string) {
    return this.inner.probe(file);
  }
  decodeFrames(...args: Parameters<MediaTools["decodeFrames"]>) {
    this.decodes++;
    return this.inner.decodeFrames(...args);
  }
  extractAudio(...args: Parameters<MediaTools["extractAudio"]>) {
    return this.inner.extractAudio(...args);
  }
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

const runMedia = hasFfmpeg || process.env.CI !== undefined;

describe.runIf(runMedia)("video and audio uploads with FFmpeg", () => {
  let blobs: MemoryBlobStore;
  let media: Counting;
  let renderer: Recorder;
  let service: KynimoService;
  let project_id: string;
  const meta = (base_version: number, idempotency_key: string) => ({
    project_id,
    base_version,
    idempotency_key,
  });

  beforeEach(async () => {
    blobs = new MemoryBlobStore();
    media = new Counting(new Ffmpeg());
    renderer = new Recorder();
    service = new KynimoService(new MemoryStore(), "agent", { blobs, media, renderer });
    ({ id: project_id } = await service.createProject({
      name: "P",
      idempotency_key: "c",
      width: 320,
      height: 180,
      fps: { num: 30, den: 1 },
      duration_frames: 60,
      background: null,
    }));
  });

  it("decodes a clip to constant-rate frames with a pinned manifest, and its sound to audio", async () => {
    const clip = makeClip({ width: 160, height: 90, fps: "25", seconds: 2, audio: true });
    const r = await service.uploadAsset(meta(1, "u"), {
      name: "clip.mp4",
      data: base64(clip),
      id: "clip",
    });
    expect(r).toMatchObject({ version: 2, assets_added: ["clip", "clip-audio"] });
    expect(r.asset).toMatchObject({
      type: "video",
      width: 160,
      height: 90,
      fps: { num: 25, den: 1 },
      frameCount: 50,
    });
    expect(r.audio_asset).toMatchObject({ type: "audio", name: "clip.mp4 (audio)" });
    expect((r.audio_asset as { durationMs: number }).durationMs).toBeGreaterThan(1900);
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(r.asset.uri)) as Uint8Array),
    ) as { frames: string[]; decoder: string };
    expect(manifest.frames).toHaveLength(50);
    expect(manifest.decoder).toMatch(/^ffmpeg /);
    expect(await blobs.get(`assets/${manifest.frames[0]}.jpg`)).toBeDefined();
    expect(await blobs.get((r.audio_asset as { uri: string }).uri)).toBeDefined();
  }, 60_000);

  it("replays a retry with the same key without decoding again", async () => {
    const data = base64(makeClip({ width: 64, height: 36, fps: "10", seconds: 1 }));
    const first = await service.uploadAsset(meta(1, "u"), { name: "c", data });
    const again = await service.uploadAsset(meta(1, "u"), { name: "c", data });
    expect(media.decodes).toBe(1);
    expect(again).toMatchObject({ replayed: true, version: first.version, asset: first.asset });
    expect(again.audio_asset).toBeUndefined();
  }, 60_000);

  it("decodes the same file to the same frames every time", async () => {
    const data = base64(makeClip({ width: 64, height: 36, fps: "10", seconds: 1 }));
    const a = await service.uploadAsset(meta(1, "a"), { name: "c", data });
    const b = await service.uploadAsset(meta(2, "b"), { name: "c", data, id: "second" });
    expect(b.asset.sha256).toBe(a.asset.sha256);
  }, 60_000);

  it("scales large or turned footage into 1920 px, caps the rate at 60 fps, reads WebM", async () => {
    const big = await service.uploadAsset(meta(1, "big"), {
      name: "big",
      data: base64(makeClip({ width: 2560, height: 1440, fps: "120", seconds: 0.2 })),
    });
    expect(big.asset).toMatchObject({ width: 1920, height: 1080, fps: { num: 60, den: 1 } });
    const turned = await service.uploadAsset(meta(2, "turned"), {
      name: "turned",
      data: base64(makeClip({ width: 64, height: 36, fps: "10", seconds: 0.5, rotate: 90 })),
    });
    expect(turned.asset).toMatchObject({ width: 36, height: 64 });
    const webm = await service.uploadAsset(meta(3, "webm"), {
      name: "webm",
      data: base64(makeClip({ width: 64, height: 36, fps: "24", seconds: 0.5, format: "webm" })),
    });
    expect(webm.asset).toMatchObject({ type: "video", fps: { num: 24, den: 1 }, frameCount: 12 });
  }, 120_000);

  it("uploads audio-only files as audio assets", async () => {
    const r = await service.uploadAsset(meta(1, "a"), {
      name: "tone.wav",
      data: base64(makeTone(1)),
    });
    expect(r.asset).toMatchObject({ type: "audio", name: "tone.wav" });
    expect(r.asset.uri).toMatch(/\.flac$/);
    expect(r.audio_asset).toBeUndefined();
  }, 60_000);

  it("refuses clips over 60 s, files FFmpeg cannot read, and family", async () => {
    const long = await rejection(
      service.uploadAsset(meta(1, "l"), {
        name: "long",
        data: base64(makeClip({ width: 16, height: 16, fps: "1", seconds: 61 })),
      }),
    );
    expect(long.message).toMatch(/at most 60 s \(this one is 61\.0 s\)/);
    const broken = new Uint8Array(64);
    broken.set(new TextEncoder().encode("\0\0\0\x18ftypisom"), 0);
    const bad = await rejection(
      service.uploadAsset(meta(1, "b"), { name: "b", data: base64(broken) }),
    );
    expect(bad).toMatchObject({ kind: "invalid", errors: [{ path: ["data"] }] });
    const fam = await rejection(
      service.uploadAsset(meta(1, "f"), { name: "t", data: base64(makeTone(1)), family: "X" }),
    );
    expect(fam.errors[0]?.path).toEqual(["family"]);
    expect((await service.getProject(project_id)).version).toBe(1);
  }, 120_000);

  it("FFmpeg itself refuses playlists and concat lists that point at other files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kynimo-media-test-"));
    try {
      const ffmpeg = new Ffmpeg();
      const hls = join(dir, "x.m3u8");
      writeFileSync(
        hls,
        "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10,\nfile:///etc/hostname\n#EXT-X-ENDLIST\n",
      );
      await expect(ffmpeg.probe(hls)).rejects.toThrow(MediaError);
      const concat = join(dir, "x.mp4");
      writeFileSync(concat, "ffconcat version 1.0\nfile /etc/hostname\n");
      await expect(ffmpeg.probe(concat)).rejects.toThrow(MediaError);
      // Error text never shows the server's temp path.
      const e = await ffmpeg.probe(concat).catch((err: Error) => err);
      expect(String(e)).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops FFmpeg once the decoded frames pass the byte limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kynimo-media-test-"));
    try {
      const file = join(dir, "c.mp4");
      writeFileSync(file, makeClip({ width: 64, height: 36, fps: "10", seconds: 2 }));
      let frames = 0;
      await expect(
        new Ffmpeg().decodeFrames(
          file,
          {
            fps: { num: 10, den: 1 },
            width: 64,
            height: 36,
            maxFrames: 20,
            maxSeconds: 60,
            maxBytes: 3000,
          },
          async () => {
            frames++;
          },
        ),
      ).rejects.toThrow(/would pass 3000 bytes/);
      expect(frames).toBeLessThan(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks the derived audio id and name: a long id is refused up front, a long name is cut", async () => {
    const clip = base64(makeClip({ width: 64, height: 36, fps: "10", seconds: 0.5, audio: true }));
    const longId = await rejection(
      service.uploadAsset(meta(1, "i"), { name: "c", data: clip, id: "a".repeat(59) }),
    );
    expect(longId.errors).toEqual([{ path: ["id"], message: expect.stringContaining("58") }]);
    const r = await service.uploadAsset(meta(1, "n"), {
      name: "n".repeat(200),
      data: clip,
      id: "x",
    });
    expect((r.audio_asset as { name: string }).name).toBe(`${"n".repeat(192)} (audio)`);
    // `<id>-audio` already taken (here by the audio of upload "x"): reported on `id`.
    const audioOfX = await service.uploadAsset(meta(2, "t"), {
      name: "c",
      data: base64(makeTone(0.5)),
      id: "y-audio",
    });
    const taken = await rejection(
      service.uploadAsset(meta(audioOfX.version, "t2"), { name: "c", data: clip, id: "y" }),
    );
    expect(taken.errors[0]?.path).toEqual(["id"]);
  }, 60_000);

  it("gives renders exactly the source frames shown, mapped through the layer's time", async () => {
    const up = await service.uploadAsset(meta(1, "u"), {
      name: "c",
      data: base64(makeClip({ width: 64, height: 36, fps: "10", seconds: 2 })),
      id: "clip",
    });
    const layer = withLayerDefaults({ type: "video", name: "V", assetId: "clip", startFrame: 6 }, {
      width: 320,
      height: 180,
      durationFrames: 60,
    } as never);
    await service.write(meta(up.version, "l"), {
      kind: "ops",
      ops: [{ op: "addLayer", composition: "main", layer }],
    });
    // 10 fps footage at 30 fps from frame 6: frame 0 shows nothing, 6 → 0, 9 → 1, 35 → 9.
    await service.renderFrames(project_id, { frames: [0, 6, 9, 35], max_size: 64 });
    expect([...(renderer.given[0]?.videoFrames.keys() ?? [])].sort()).toEqual([
      "clip/0",
      "clip/1",
      "clip/9",
    ]);
  }, 60_000);

  it("collects frames shown through precomps and through hidden matte sources", async () => {
    const up = await service.uploadAsset(meta(1, "u"), {
      name: "c",
      data: base64(makeClip({ width: 64, height: 36, fps: "10", seconds: 2 })),
      id: "clip",
    });
    const size = { width: 320, height: 180, durationFrames: 60 } as never;
    const video = (fields: Record<string, unknown>) =>
      withLayerDefaults({ type: "video", name: "V", assetId: "clip", ...fields }, size);
    const solid = withLayerDefaults(
      { type: "solid", name: "S", width: 10, height: 10, color: "#ffffff" },
      size,
    );
    await service.write(meta(up.version, "l"), {
      kind: "ops",
      ops: [
        { op: "addLayer", composition: "main", id: "s", layer: solid },
        { op: "addLayer", composition: "main", id: "mv", layer: video({ hidden: true }), index: 1 },
        { op: "setMatte", layer: "s", matte: { layer: "mv", mode: "alpha" } },
        { op: "addLayer", composition: "main", id: "iv", layer: video({ startFrame: 1 }) },
        { op: "precompose", layers: ["iv"], id: "inner" },
      ],
    });
    // Main frame 6 (30 fps): the hidden matte source shows source floor(6·10/30) = 2; the
    // precomped layer (startFrame 1) shows floor(5·10/30) = 1.
    await service.renderFrames(project_id, { frames: [6], max_size: 64 });
    expect([...(renderer.given[0]?.videoFrames.keys() ?? [])].sort()).toEqual(["clip/1", "clip/2"]);
  }, 60_000);

  it("fails renders clearly when a manifest or frame is missing, corrupt or mismatched, or over the limit", async () => {
    const store = new Map<string, Uint8Array>();
    const tamper: BlobStore = {
      put: async (k, b) => void store.set(k, b),
      get: async (k) => store.get(k),
    };
    const s2 = new KynimoService(new MemoryStore(), "agent", { blobs: tamper, media, renderer });
    const { id } = await s2.createProject({
      name: "P",
      idempotency_key: "c",
      width: 64,
      height: 36,
      fps: { num: 10, den: 1 },
      duration_frames: 10,
      background: null,
    });
    const up = await s2.uploadAsset(
      { project_id: id, base_version: 1, idempotency_key: "u" },
      {
        name: "c",
        data: base64(makeClip({ width: 64, height: 36, fps: "10", seconds: 1 })),
        id: "clip",
      },
    );
    const layer = withLayerDefaults({ type: "video", name: "V", assetId: "clip" }, {
      width: 64,
      height: 36,
      durationFrames: 10,
    } as never);
    await s2.write(
      { project_id: id, base_version: 2, idempotency_key: "l" },
      { kind: "ops", ops: [{ op: "addLayer", composition: "main", layer }] },
    );
    const manifest = store.get(up.asset.uri) as Uint8Array;
    const frames = (JSON.parse(new TextDecoder().decode(manifest)) as { frames: string[] }).frames;
    const render = (frame: number, svc = s2) =>
      svc.renderFrames(id, { frames: [frame], max_size: 32 });

    // Before any render caches it: the manifest gone.
    store.delete(up.asset.uri);
    expect((await rejection(render(4))).message).toMatch(/missing or corrupt frame manifest/);
    store.set(up.asset.uri, manifest);
    // A frame gone.
    store.delete(`assets/${frames[3]}.jpg`);
    expect(await rejection(render(3))).toMatchObject({
      kind: "render_failed",
      message: expect.stringMatching(/frame 3 is missing or corrupt/),
    });

    // A manifest that hashes right but lists the wrong number of frames.
    const wrong = new TextEncoder().encode(JSON.stringify({ frames: frames.slice(1) }));
    const sha = createHash("sha256").update(wrong).digest("hex");
    store.set(`assets/${sha}.json`, wrong);
    const { id: _, ...entry } = up.asset;
    await s2.write(
      { project_id: id, base_version: 3, idempotency_key: "m" },
      {
        kind: "ops",
        ops: [
          {
            op: "addAsset",
            id: "bad",
            asset: { ...entry, uri: `assets/${sha}.json`, sha256: sha },
          },
          { op: "updateLayer", layer: { type: "video" }, set: { hidden: true } },
          { op: "addLayer", composition: "main", layer: { ...(layer as object), assetId: "bad" } },
        ],
      },
    );
    expect((await rejection(render(5))).message).toMatch(
      /'bad' has a frame manifest that does not match/,
    );

    const tight = new KynimoService(new MemoryStore(), "agent", {
      blobs: new MemoryBlobStore(),
      media,
      renderer,
      maxRenderAssetBytes: 100,
    });
    const { id: id4 } = await tight.createProject({
      name: "P",
      idempotency_key: "c",
      width: 64,
      height: 36,
      fps: { num: 10, den: 1 },
      duration_frames: 10,
      background: null,
    });
    await tight.uploadAsset(
      { project_id: id4, base_version: 1, idempotency_key: "u" },
      {
        name: "c",
        data: base64(makeClip({ width: 64, height: 36, fps: "10", seconds: 1 })),
        id: "clip",
      },
    );
    await tight.write(
      { project_id: id4, base_version: 2, idempotency_key: "l" },
      { kind: "ops", ops: [{ op: "addLayer", composition: "main", layer }] },
    );
    expect(await rejection(tight.renderFrames(id4, { frames: [0], max_size: 32 }))).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/more than 100 bytes of stored/),
    });
  }, 120_000);
});

it("video uploads are unavailable without FFmpeg, saying why", async () => {
  const service = new KynimoService(new MemoryStore(), "agent", {
    blobs: new MemoryBlobStore(),
    mediaUnavailable: "no ffmpeg here",
  });
  const { id } = await service.createProject({
    name: "P",
    idempotency_key: "c",
    width: 32,
    height: 32,
    fps: { num: 30, den: 1 },
    duration_frames: 10,
    background: null,
  });
  const header = new TextEncoder().encode("\0\0\0\x18ftypisom");
  const e = await rejection(
    service.uploadAsset(
      { project_id: id, base_version: 1, idempotency_key: "u" },
      { name: "c", data: base64(header) },
    ),
  );
  expect(e).toMatchObject({
    kind: "unavailable",
    message: expect.stringContaining("no ffmpeg here"),
  });
});
