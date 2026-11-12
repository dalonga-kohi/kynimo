import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { videoFrameKey } from "@kynimo/renderer";
import { withLayerDefaults } from "@kynimo/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobKey, MemoryBlobStore } from "./blobs.js";
import type { JobReply } from "./export.js";
import { FakeMedia, FakeRenderer } from "./export.test-util.js";
import { ExportFiles } from "./export-files.js";
import { JobQueue } from "./jobs.js";
import { MediaError } from "./media-error.js";
import { KynimoService, ServiceRuntime, ToolError } from "./service.js";
import { MemoryStore } from "./store.js";

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
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

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const FLAC = new TextEncoder().encode("fake flac bytes");

const settings = {
  name: "Export",
  idempotency_key: "c",
  width: 100,
  height: 60,
  fps: { num: 30, den: 1 },
  duration_frames: 90,
  background: "#000000",
};

describe("KynimoService: export jobs", () => {
  let renderer: FakeRenderer;
  let media: FakeMedia;
  let blobs: MemoryBlobStore;
  let dir: string;
  let files: ExportFiles;
  let runtime: ServiceRuntime;
  let svc: KynimoService;
  let project: string;
  let version = 1;
  let key = 0;

  const build = async (
    over: Partial<Omit<typeof settings, "background">> & { background?: string | null } = {},
    options = {},
  ) => {
    runtime = new ServiceRuntime({
      renderer,
      media,
      blobs,
      exportFiles: files,
      downloadUrl: (token) => `https://kynimo.test/exports/${token}`,
      localExportPaths: true,
      ...options,
    });
    svc = new KynimoService(new MemoryStore(), "agent", runtime);
    const created = await svc.createProject({ ...settings, ...over });
    version = created.version;
    return created.id;
  };

  const write = async (ops: unknown[]) => {
    const r = await svc.write(
      { project_id: project, base_version: version, idempotency_key: `w${++key}` },
      { kind: "ops", ops },
    );
    version = r.version;
  };

  const layerOp = (input: object, id?: string) => ({
    op: "addLayer",
    composition: "main",
    ...(id ? { id } : {}),
    layer: withLayerDefaults(input, { width: 100, height: 60, durationFrames: 90 } as never),
  });

  const addAudio = async (layers: { id: string; extra?: object }[]) => {
    await blobs.put(blobKey(sha256(FLAC), "flac"), FLAC, "audio/flac");
    await write([
      {
        op: "addAsset",
        id: "song",
        asset: {
          type: "audio",
          name: "song",
          uri: blobKey(sha256(FLAC), "flac"),
          sha256: sha256(FLAC),
          durationMs: 1000,
        },
      },
      ...layers.map((l) =>
        layerOp({ type: "audio", name: l.id, assetId: "song", ...l.extra }, l.id),
      ),
    ]);
  };

  const start = (input: Partial<Parameters<KynimoService["exportComposition"]>[1]> = {}) =>
    svc.exportComposition(project, { format: "mp4", idempotency_key: `k${++key}`, ...input });
  const finish = async (reply: JobReply): Promise<JobReply> =>
    (await svc.getExportStatus(reply.job_id, 20)).result;
  const run = async (input: Parameters<typeof start>[0] = {}) => {
    const done = await finish(await start(input));
    expect(done.error).toBeUndefined();
    expect(done.state).toBe("succeeded");
    return done;
  };

  beforeEach(async () => {
    renderer = new FakeRenderer();
    media = new FakeMedia();
    blobs = new MemoryBlobStore();
    dir = await mkdtemp(join(tmpdir(), "kynimo-test-exports-"));
    files = await ExportFiles.open(dir);
    project = await build();
  });
  afterEach(async () => {
    renderer.gate.resolve();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe("validation", () => {
    it("defaults to mp4, the whole composition and the composition's size", async () => {
      const done = await run();
      expect(done.result).toMatchObject({
        format: "mp4",
        composition: "main",
        version: 1,
        from_frame: 0,
        to_frame: 89,
        frames: 90,
        width: 100,
        height: 60,
        fps: { num: 30, den: 1 },
        duration_seconds: 3,
        content_type: "video/mp4",
      });
    });

    it("picks the default size per format and never upscales", async () => {
      project = await build({ width: 2400, height: 1200 });
      const sizes = async (input: Parameters<typeof start>[0]) => {
        const r = (await run(input)).result;
        return [r?.width, r?.height];
      };
      expect(await sizes({ to_frame: 2 })).toEqual([1920, 960]);
      expect(await sizes({ to_frame: 2, format: "webm" })).toEqual([1920, 960]);
      expect(await sizes({ to_frame: 2, format: "gif" })).toEqual([480, 240]);
      expect(await sizes({ to_frame: 2, max_size: 600 })).toEqual([600, 300]);
      expect(await sizes({ to_frame: 2, format: "gif", max_size: 960 })).toEqual([960, 480]);
      const preview = await finish(await svc.renderPreviewClip(project, { to_frame: 2 }));
      expect([preview.result?.width, preview.result?.height]).toEqual([360, 180]);
      // A composition smaller than the default stays as it is.
      project = await build({ width: 200, height: 100 });
      expect(await sizes({ to_frame: 2, format: "gif" })).toEqual([200, 100]);
      expect(await sizes({ to_frame: 2, max_size: 1920 })).toEqual([200, 100]);
    });

    it("checks the frame range and names what fits", async () => {
      const outside = await rejection(start({ to_frame: 90 }));
      expect(outside.kind).toBe("invalid");
      expect(outside.errors).toEqual([
        { path: ["to_frame"], message: "must be a frame from 0 to 89" },
      ]);
      const from = await rejection(start({ from_frame: 95 }));
      expect(from.errors[0]?.path).toEqual(["from_frame"]);
      const backwards = await rejection(start({ from_frame: 40, to_frame: 10 }));
      expect(backwards.errors[0]).toMatchObject({ path: ["to_frame"] });
      expect(backwards.message).toMatch(/from_frame 40 is after to_frame 10/);
      const missing = await rejection(start({ composition: "nope" }));
      expect(missing.kind).toBe("not_found");
      expect(missing.message).toMatch(/compositions: main/);
      expect(renderer.opens).toEqual([]);
    });

    it("limits the duration by format, exactly, and names the last frame that fits", async () => {
      project = await build({ duration_frames: 2000 });
      const e = await rejection(start());
      expect(e.kind).toBe("invalid");
      expect(e.message).toBe(
        "an mp4 export may be at most 60 s (1800 frames at 30 fps); use to_frame 1799 or less, or export in parts",
      );
      expect(e.errors[0]?.path).toEqual(["to_frame"]);
      // Exactly 60 s is fine; one frame more is not.
      expect((await start({ to_frame: 1799 })).state).toMatch(/queued|running/);
      expect((await rejection(start({ to_frame: 1800 }))).kind).toBe("invalid");
      expect((await rejection(start({ from_frame: 100, to_frame: 1900 }))).message).toMatch(
        /use to_frame 1899 or less/,
      );
      expect((await rejection(start({ format: "gif", to_frame: 450 }))).message).toBe(
        "a gif export may be at most 15 s (450 frames at 30 fps); use to_frame 449 or less, or export in parts",
      );
      expect((await rejection(svc.renderPreviewClip(project, { to_frame: 300 }))).message).toBe(
        "a preview clip may be at most 10 s (300 frames at 30 fps); use to_frame 299 or less, or export in parts",
      );
      expect((await rejection(start({ format: "webm" }))).message).toMatch(/^a webm export/);
    });

    it("counts a fractional frame rate exactly", async () => {
      // 60 s at 30000/1001 is 1798.2 frames: 1798 fit, 1799 do not.
      project = await build({ duration_frames: 2000, fps: { num: 30000, den: 1001 } });
      expect((await rejection(start({ to_frame: 1798 }))).message).toContain(
        "(1798 frames at 30000/1001 fps); use to_frame 1797 or less",
      );
      expect((await start({ to_frame: 1797 })).state).toMatch(/queued|running/);
    });

    it("limits max_size per format with the maximum in the message", async () => {
      const gif = await rejection(start({ format: "gif", max_size: 961 }));
      expect(gif.errors[0]?.path).toEqual(["max_size"]);
      expect(gif.message).toContain("a gif export");
      expect(gif.message).toContain("960");
      expect((await rejection(start({ max_size: 1921 }))).message).toContain("1920");
      expect((await rejection(start({ max_size: 31 }))).errors[0]?.path).toEqual(["max_size"]);
      const preview = await rejection(svc.renderPreviewClip(project, { max_size: 481 }));
      expect(preview.message).toContain("480");
      expect(renderer.opens).toEqual([]);
    });
  });

  describe("availability", () => {
    it("answers unavailable without a renderer, FFmpeg or export storage", async () => {
      const make = (options: object) =>
        new KynimoService(new MemoryStore(), "agent", options).exportComposition("p", {
          format: "mp4",
          idempotency_key: "k",
        });
      const base = { renderer, media, exportFiles: files };
      const e1 = await rejection(make({ ...base, renderer: undefined }));
      expect([e1.kind, e1.message]).toEqual([
        "unavailable",
        "export is unavailable: this server has no renderer",
      ]);
      const e2 = await rejection(make({ ...base, media: undefined }));
      expect(e2.message).toBe(
        "export is unavailable: this server has no FFmpeg (install ffmpeg and ffprobe)",
      );
      expect(
        (await rejection(make({ ...base, media: undefined, mediaUnavailable: "no ffmpeg" })))
          .message,
      ).toBe("export is unavailable: no ffmpeg");
      const e3 = await rejection(make({ ...base, exportFiles: undefined }));
      expect(e3.message).toBe("export is unavailable: this server has no export storage");
      const e4 = await rejection(
        make({ ...base, exportFiles: undefined, exportsUnavailable: "no disk" }),
      );
      expect(e4.message).toBe("export is unavailable: no disk");
    });
  });

  describe("running a job", () => {
    it("runs to succeeded with a link, a path, a size and an expiry", async () => {
      const reply = await start();
      expect(reply).toMatchObject({
        kind: "export",
        project_id: project,
        replayed: false,
        progress: { frames_total: 90 },
      });
      expect(reply.job_id).toMatch(/^j-[0-9a-f]{32}$/);
      expect(reply.state).toMatch(/queued|running/);
      const done = await finish(reply);
      expect(done).toMatchObject({
        state: "succeeded",
        progress: { phase: "done", frames_done: 90 },
      });
      const result = done.result;
      expect(result?.bytes).toBe("fake-video".length);
      expect(result?.url).toMatch(/^https:\/\/kynimo\.test\/exports\/[A-Za-z0-9_-]{43}$/);
      expect(result && isAbsolute(result.path ?? "")).toBe(true);
      expect(readFileSync(result?.path ?? "", "utf8")).toBe("fake-video");
      expect(result?.path).toContain(reply.job_id);
      expect(Number.isNaN(Date.parse(result?.expires_at ?? ""))).toBe(false);
      expect(Date.parse(result?.expires_at ?? "")).toBeGreaterThan(Date.now());
      expect(result?.render_seconds).toBeGreaterThanOrEqual(0);
      expect(result).not.toHaveProperty("sheet");
      expect(Date.parse(done.created_at)).not.toBeNaN();
      expect(Date.parse(done.finished_at ?? "")).not.toBeNaN();
      // No download link or local path unless the server has them.
      const bare = await build({}, { downloadUrl: undefined, localExportPaths: false });
      project = bare;
      const plain = (await run({ to_frame: 1 })).result;
      expect(plain).not.toHaveProperty("url");
      expect(plain).not.toHaveProperty("path");
    });

    it("writes the frames in order through one export session with the planned encode", async () => {
      project = await build({ width: 100, height: 60 });
      await run({ from_frame: 10, to_frame: 14, max_size: 50 });
      expect(renderer.opens).toEqual([
        { composition: "main", maxSize: 50, assets: [], alpha: "premultiplied" },
      ]);
      const session = renderer.sessions[0];
      expect(session?.calls.map((c) => c.frame)).toEqual([10, 11, 12, 13, 14]);
      expect(session?.closed).toBe(true);
      const encode = media.encodes[0];
      expect(encode?.opts).toMatchObject({
        format: "mp4",
        width: 50,
        height: 30,
        fps: { num: 30, den: 1 },
        frameCount: 5,
        audio: null,
        flatten: true,
      });
      expect(encode?.written.map((f) => [f.byteLength, f[0]])).toEqual(
        [10, 11, 12, 13, 14].map((n) => [50 * 30 * 4, n]),
      );
      expect(encode?.finished).toBe(true);
    });

    it("renders webm unflattened with straight alpha, mp4 and gif flattened", async () => {
      await run({ format: "webm", to_frame: 1 });
      await run({ format: "gif", to_frame: 1 });
      expect(renderer.opens.map((o) => o.alpha)).toEqual(["straight", "premultiplied"]);
      expect(media.encodes.map((e) => [e.opts.format, e.opts.flatten])).toEqual([
        ["webm", false],
        ["gif", true],
      ]);
    });

    it("passes each frame's video frames to the session one frame at a time", async () => {
      const jpg = (n: number) => new TextEncoder().encode(`jpeg ${n}`);
      const shas = [0, 1, 2, 3, 4].map((n) => sha256(jpg(n)));
      for (const [n, sha] of shas.entries())
        await blobs.put(blobKey(sha, "jpg"), jpg(n), "image/jpeg");
      const manifest = new TextEncoder().encode(JSON.stringify({ frames: shas }));
      await blobs.put(blobKey(sha256(manifest), "json"), manifest, "application/json");
      await write([
        {
          op: "addAsset",
          id: "clip",
          asset: {
            type: "video",
            name: "clip",
            uri: blobKey(sha256(manifest), "json"),
            sha256: sha256(manifest),
            width: 4,
            height: 4,
            fps: { num: 30, den: 1 },
            frameCount: 5,
          },
        },
        layerOp({ type: "video", name: "Clip", assetId: "clip" }, "clip-layer"),
      ]);
      await run({ to_frame: 6 });
      expect(renderer.sessions[0]?.calls).toEqual(
        [0, 1, 2, 3, 4, 5, 6].map((frame) => ({
          frame,
          videoKeys: frame < 5 ? [videoFrameKey("clip", frame)] : [],
        })),
      );
    });

    it("counts repeated frames and writes the same buffer again", async () => {
      renderer.repeat = new Set([3, 4]);
      const done = await run({ to_frame: 5 });
      expect(done.result?.repeated_frames).toBe(2);
      const written = media.encodes[0]?.written ?? [];
      expect(written[3]).toBe(written[2]);
      expect(written[4]).toBe(written[2]);
      expect(written[5]).not.toBe(written[2]);
    });

    it("removes the temp directory and closes the session after success", async () => {
      await run({ to_frame: 2 });
      const out = media.encodes[0]?.opts.out ?? "";
      expect(existsSync(dirname(out))).toBe(false);
      expect(renderer.sessions[0]?.closed).toBe(true);
    });

    it("fails with render_failed, closing the session, stopping the encoder and cleaning up", async () => {
      renderer.failAt = 3;
      const done = await finish(await start());
      expect(done.state).toBe("failed");
      expect(done.error).toEqual({ code: "render_failed", message: "the page crashed" });
      expect(done).not.toHaveProperty("result");
      expect(renderer.sessions[0]?.closed).toBe(true);
      expect(media.encodes[0]?.aborted).toBe(true);
      expect(media.encodes[0]?.finished).toBe(false);
      expect(existsSync(dirname(media.encodes[0]?.opts.out ?? ""))).toBe(false);
    });

    it("fails with encode_failed when the encoder breaks, still cleaning up", async () => {
      media.failWrite = new MediaError("the encoder stalled for 120 s");
      const done = await finish(await start());
      expect(done.error).toEqual({
        code: "encode_failed",
        message: "the encoder stalled for 120 s",
      });
      expect(renderer.sessions[0]?.closed).toBe(true);
      expect(existsSync(dirname(media.encodes[0]?.opts.out ?? ""))).toBe(false);
    });

    it("fails when a frame comes back at another size", async () => {
      renderer.sizeError = 2;
      const done = await finish(await start({ to_frame: 2 }));
      expect(done.error?.code).toBe("render_failed");
      expect(done.error?.message).toMatch(/came back 102×60, not the planned 100×60/);
    });

    it("reports frames_done while running", async () => {
      renderer.gateAt = 2;
      const reply = await start();
      await until(() => renderer.reached.length > 0);
      const running = (await svc.getExportStatus(reply.job_id, 0)).result;
      expect(running).toMatchObject({
        state: "running",
        progress: { phase: "rendering", frames_done: 2, frames_total: 90 },
      });
      expect(running.started_at).not.toBeNull();
      expect(running.finished_at).toBeNull();
      expect(running).not.toHaveProperty("result");
      renderer.gate.resolve();
      expect((await finish(reply)).state).toBe("succeeded");
    });

    it("answers a wait_seconds status as soon as the job finishes", async () => {
      renderer.gateAt = 1;
      const reply = await start({ to_frame: 3 });
      await until(() => renderer.reached.length > 0);
      const waiting = svc.getExportStatus(reply.job_id, 20);
      await tick();
      renderer.gate.resolve();
      const { result } = await waiting;
      expect(result.state).toBe("succeeded");
    });
  });

  describe("audio", () => {
    it("mixes audio layers into mp4 and webm, as stereo f32 for exactly the exported frames", async () => {
      await addAudio([{ id: "music" }]);
      const mp4 = await run({ from_frame: 0, to_frame: 29 });
      // Frames 0-29 at 30 fps are 1 s: 48000 stereo samples of f32.
      expect(media.encodes[0]?.audio?.byteLength).toBe(2 * 48_000 * 4);
      expect(media.encodes[0]?.audio?.readFloatLE(0)).toBeCloseTo(0.5);
      expect(mp4.result?.audio_layers).toEqual(["music"]);
      expect(media.pcmCalls).toEqual([Math.ceil(1000 * 48) + 48_000]);
      const webm = await run({ format: "webm", from_frame: 0, to_frame: 14 });
      expect(media.encodes[1]?.audio?.byteLength).toBe(2 * 24_000 * 4);
      expect(webm.result?.audio_layers).toEqual(["music"]);
      expect(webm.result?.fidelity.find((f) => f.feature === "audio")).toBeUndefined();
    });

    it("decodes each asset once and encodes without an audio track when nothing plays", async () => {
      await addAudio([{ id: "a" }, { id: "b" }]);
      await run({ to_frame: 5 });
      expect(media.pcmCalls).toHaveLength(1);
      await write([
        { op: "updateLayer", layer: "a", set: { hidden: true } },
        { op: "updateLayer", layer: "b", set: { hidden: true } },
      ]);
      const done = await run({ to_frame: 5 });
      expect(media.encodes[1]?.opts.audio).toBeNull();
      expect(done.result?.audio_layers).toEqual([]);
    });

    it("drops the audio of a gif and says so", async () => {
      await addAudio([{ id: "music" }]);
      const done = await run({ format: "gif", to_frame: 5 });
      expect(media.encodes[0]?.opts.audio).toBeNull();
      expect(media.pcmCalls).toEqual([]);
      expect(done.result?.audio_layers).toEqual([]);
      expect(done.result?.fidelity).toContainEqual({
        kind: "dropped",
        feature: "audio",
        detail: "GIF has no sound; export mp4 or webm to keep it",
        layers: ["music"],
      });
    });

    it("reports a clipped mix", async () => {
      media.pcm = new Float32Array(96_000).fill(0.9);
      await addAudio([{ id: "a" }, { id: "b" }]);
      const done = await run({ to_frame: 29 });
      expect(done.result?.fidelity).toContainEqual({
        kind: "approximated",
        feature: "audio-clipping",
        detail: `the mix went over full scale in ${2 * 48_000} sample values and was clipped; lower the layers' volume`,
        layers: ["b", "a"],
      });
      expect(media.encodes[0]?.audio?.readFloatLE(0)).toBe(1);
    });

    it("reports audio layers inside precomps as dropped", async () => {
      await addAudio([{ id: "inner" }]);
      await write([{ op: "precompose", layers: ["inner"], id: "sub", layerId: "sub-layer" }]);
      const done = await run({ to_frame: 5 });
      expect(media.encodes[0]?.opts.audio).toBeNull();
      expect(done.result?.fidelity).toContainEqual({
        kind: "dropped",
        feature: "nested-audio",
        detail:
          "audio layers inside precomps are not mixed yet; move them into the exported composition",
        layers: ["inner"],
      });
    });

    it("fails the job when the audio asset's bytes are gone", async () => {
      project = await build({}, { blobs: new MemoryBlobStore() });
      await write([
        {
          op: "addAsset",
          id: "song",
          asset: {
            type: "audio",
            name: "song",
            uri: blobKey(sha256(FLAC), "flac"),
            sha256: sha256(FLAC),
            durationMs: 1000,
          },
        },
        layerOp({ type: "audio", name: "m", assetId: "song" }, "m"),
      ]);
      const done = await finish(await start({ to_frame: 5 }));
      expect(done.state).toBe("failed");
      expect(done.error?.code).toBe("render_failed");
      expect(done.error?.message).toMatch(/audio asset 'song'.*missing or corrupt/);
    });
  });

  describe("fidelity", () => {
    const fidelity = async (input: Parameters<typeof start>[0] = {}) =>
      (await run({ to_frame: 3, ...input })).result?.fidelity ?? [];

    it("flattens transparency on mp4 and gif, never on webm or an opaque background", async () => {
      const transparency = {
        kind: "flattened",
        feature: "transparency",
        detail:
          "transparent areas are composited over black; export webm to keep transparency, or give the composition an opaque background",
      };
      expect(await fidelity()).toEqual([]);
      project = await build({ background: null });
      expect(await fidelity()).toContainEqual(transparency);
      expect(await fidelity({ format: "gif" })).toContainEqual(transparency);
      expect(await fidelity({ format: "webm" })).toEqual([]);
      project = await build({ background: "#10203080" });
      expect(await fidelity()).toContainEqual(transparency);
      project = await build({ background: "#102030ff" });
      expect(await fidelity()).toEqual([]);
    });

    it("pads odd mp4 sizes to even and says so", async () => {
      project = await build({ width: 101, height: 60 });
      const even = {
        kind: "approximated",
        feature: "even-size",
        detail: "padded with 1 px of black to an even size, which H.264 needs",
      };
      expect(await fidelity()).toEqual([even]);
      expect(await fidelity({ format: "webm" })).toEqual([]);
    });

    it("always notes the gif palette, and timing when delays cannot be exact", async () => {
      const palette = {
        kind: "approximated",
        feature: "gif-palette",
        detail: "colors are reduced to a 256-color palette with dithering",
      };
      // 25 fps is 4 hundredths of a second per frame: exact.
      project = await build({ fps: { num: 25, den: 1 } });
      expect(await fidelity({ format: "gif" })).toEqual([palette]);
      // 30 fps is 3.33.
      const timing = {
        kind: "approximated",
        feature: "gif-timing",
        detail: "GIF frame delays are whole hundredths of a second, so frame timing is rounded",
      };
      project = await build();
      expect(await fidelity({ format: "gif" })).toEqual([palette, timing]);
      project = await build({ fps: { num: 30000, den: 1001 } });
      expect(await fidelity({ format: "gif" })).toEqual([palette, timing]);
    });

    it("sorts entries by kind, then feature", async () => {
      project = await build({ width: 101, height: 60, background: null });
      await addAudio([{ id: "a" }]);
      const kinds = (await fidelity()).map((f) => `${f.kind}/${f.feature}`);
      expect(kinds).toEqual(["approximated/even-size", "flattened/transparency"]);
    });
  });

  describe("renderer reports", () => {
    it("merges skipped frames into ranges", async () => {
      renderer.skipOn = (n) => [2, 3, 4, 7].includes(n);
      const done = await run({ to_frame: 9 });
      expect(done.result?.skipped).toEqual([
        {
          layer: "fx",
          type: "adjustment",
          reason: "not drawn yet",
          ranges: [
            { from: 2, to: 4 },
            { from: 7, to: 7 },
          ],
        },
      ]);
      expect(done.result?.warnings).toEqual([]);
    });

    it("lists at most 20 ranges and counts the rest", async () => {
      renderer.skipOn = (n) => n % 2 === 0;
      const done = await run({ to_frame: 59 });
      const entry = done.result?.skipped[0] as { ranges: unknown[]; more_ranges?: number };
      expect(entry.ranges).toHaveLength(20);
      expect(entry.more_ranges).toBe(10);
    });
  });

  describe("caching and replay", () => {
    it("serves the same export again without rendering", async () => {
      const first = await run({ to_frame: 4 });
      const again = await run({ to_frame: 4 });
      expect(first.result?.cached).toBe(false);
      expect(again.result).toMatchObject({ cached: true, url: first.result?.url, bytes: 10 });
      expect(again.job_id).not.toBe(first.job_id);
      expect(renderer.opens).toHaveLength(1);
      expect(media.encodes).toHaveLength(1);
      // Another range, format or size is another export.
      await run({ to_frame: 5 });
      await run({ to_frame: 4, format: "webm" });
      await run({ to_frame: 4, max_size: 50 });
      expect(renderer.opens).toHaveLength(4);
    });

    it("renders again once the document or the renderer build changes", async () => {
      await run({ to_frame: 2 });
      await write([layerOp({ type: "solid", name: "S", width: 10, height: 10, color: "#ffffff" })]);
      expect((await run({ to_frame: 2 })).result?.cached).toBe(false);
      renderer.buildId = "build-2";
      expect((await run({ to_frame: 2 })).result?.cached).toBe(false);
      expect(renderer.opens).toHaveLength(3);
    });

    it("renders again when the cached file has expired", async () => {
      let now = 1_000;
      files = await ExportFiles.open(dir, { ttlMs: 100, now: () => now });
      project = await build();
      await run({ to_frame: 2 });
      now += 200;
      expect((await run({ to_frame: 2 })).result?.cached).toBe(false);
      expect(renderer.opens).toHaveLength(2);
    });

    it("replays a request with the same key as the same job", async () => {
      renderer.gateAt = 0;
      const first = await start({ idempotency_key: "same", to_frame: 3 });
      const second = await start({ idempotency_key: "same", to_frame: 3 });
      expect(second).toMatchObject({ job_id: first.job_id, replayed: true });
      expect(first.replayed).toBe(false);
      const reused = await rejection(start({ idempotency_key: "same", to_frame: 4 }));
      expect(reused.kind).toBe("key_reused");
      // A retry after an edit still finds the original job.
      await write([layerOp({ type: "solid", name: "S", width: 10, height: 10, color: "#ffffff" })]);
      expect((await start({ idempotency_key: "same", to_frame: 3 })).job_id).toBe(first.job_id);
      renderer.gate.resolve();
      await finish(first);
    });

    it("refuses a fifth active job of an account as busy", async () => {
      renderer.gateAt = 0;
      for (let i = 0; i < 4; i++) await start({ to_frame: i + 1 });
      const busy = await rejection(start({ to_frame: 9 }));
      expect(busy.kind).toBe("busy");
      expect(busy.message).toMatch(/already has 4 exports queued or running/);
      renderer.gate.resolve();
    });

    it("maps a closed queue to unavailable", async () => {
      await runtime.close();
      const e = await rejection(start());
      expect([e.kind, e.message]).toEqual(["unavailable", "the server is shutting down"]);
    });
  });

  describe("cancelling", () => {
    it("cancels a running job: stops the frames, aborts the encoder and cleans up", async () => {
      renderer.gateAt = 2;
      const reply = await start();
      await until(() => renderer.reached.length > 0);
      const cancelled = svc.cancelExport(reply.job_id);
      expect(cancelled.cancelled).toBe(true);
      renderer.gate.resolve();
      const done = await finish(reply);
      expect(done.state).toBe("cancelled");
      expect(done).not.toHaveProperty("result");
      expect(renderer.sessions[0]?.calls.map((c) => c.frame)).toEqual([0, 1, 2]);
      expect(renderer.sessions[0]?.closed).toBe(true);
      expect(media.encodes[0]?.aborted).toBe(true);
      expect(media.encodes[0]?.finished).toBe(false);
      expect(existsSync(dirname(media.encodes[0]?.opts.out ?? ""))).toBe(false);
    });

    it("cancels a queued job before it renders anything", async () => {
      renderer.gateAt = 0;
      const first = await start({ to_frame: 3 });
      await until(() => renderer.reached.length > 0);
      const second = await start({ to_frame: 4 });
      expect(second.state).toBe("queued");
      const cancelled = svc.cancelExport(second.job_id);
      expect(cancelled).toMatchObject({ state: "cancelled", cancelled: true });
      renderer.gate.resolve();
      expect((await finish(first)).state).toBe("succeeded");
      expect(renderer.opens).toHaveLength(1);
    });

    it("returns a finished job unchanged", async () => {
      const done = await run({ to_frame: 2 });
      const again = svc.cancelExport(done.job_id);
      expect(again.cancelled).toBe(false);
      expect(again.state).toBe("succeeded");
      expect(again.result?.url).toBe(done.result?.url);
    });
  });

  describe("ownership and expiry", () => {
    it("answers not_found for another actor's job, an unknown job and an expired one", async () => {
      const done = await run({ to_frame: 2 });
      const other = new KynimoService(new MemoryStore(), "other", runtime);
      const a = await rejection(other.getExportStatus(done.job_id, 0));
      expect(a.kind).toBe("not_found");
      expect(a.message).toBe(
        `job '${done.job_id}' does not exist or has expired; jobs are kept for 24 hours and do not survive a server restart`,
      );
      expect(
        (await rejection(Promise.resolve().then(() => other.cancelExport(done.job_id)))).kind,
      ).toBe("not_found");
      const unknown = `j-${"0".repeat(32)}`;
      expect((await rejection(svc.getExportStatus(unknown, 0))).kind).toBe("not_found");
      // After the retention time the record is gone.
      let now = 5_000;
      const queue = new JobQueue<never>({ now: () => now });
      const clocked = new KynimoService(new MemoryStore(), "agent", {
        renderer,
        media,
        exportFiles: files,
        jobs: queue as never,
      });
      const { id } = await clocked.createProject(settings);
      const reply = await clocked.exportComposition(id, {
        format: "mp4",
        idempotency_key: "k",
        to_frame: 1,
      });
      expect((await clocked.getExportStatus(reply.job_id, 20)).result.state).toBe("succeeded");
      now += 25 * 60 * 60 * 1000;
      expect((await rejection(clocked.getExportStatus(reply.job_id, 0))).kind).toBe("not_found");
    });
  });

  describe("preview clips", () => {
    it("renders a low-res mp4 and returns a contact sheet when done", async () => {
      const reply = await svc.renderPreviewClip(project, { to_frame: 29 });
      expect(reply).toMatchObject({ kind: "preview", progress: { frames_total: 30 } });
      expect(reply).not.toHaveProperty("replayed");
      const status = await svc.getExportStatus(reply.job_id, 20);
      expect(status.result.state).toBe("succeeded");
      expect(status.result.result).toMatchObject({
        format: "mp4",
        frames: 30,
        width: 100,
        height: 60,
      });
      expect(status.result.result).not.toHaveProperty("sheet");
      expect(status.images.map((i) => new TextDecoder().decode(i))).toEqual(["sheet-png"]);
      expect(renderer.sheets).toEqual([
        { frames: [0, 6, 12, 17, 23, 29], maxSize: 160, columns: 3 },
      ]);
      // A cached preview keeps its sheet.
      const again = await svc.renderPreviewClip(project, { to_frame: 29 });
      const second = await svc.getExportStatus(again.job_id, 20);
      expect(second.result.result?.cached).toBe(true);
      expect(second.images).toHaveLength(1);
      expect(renderer.opens).toHaveLength(1);
    });

    it("has no sheet for a one-frame clip, and exports carry none", async () => {
      const one = await svc.getExportStatus(
        (await svc.renderPreviewClip(project, { from_frame: 5, to_frame: 5 })).job_id,
        20,
      );
      expect(one.result.state).toBe("succeeded");
      expect(one.images).toEqual([]);
      const exported = await svc.getExportStatus((await start({ to_frame: 5 })).job_id, 20);
      expect(exported.images).toEqual([]);
      expect(renderer.sheets).toEqual([]);
    });
  });
});
