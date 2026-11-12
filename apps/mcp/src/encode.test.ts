import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg } from "./assets.test-util.js";
import type { EncodeOptions } from "./encode.js";
import { Ffmpeg, MediaError } from "./media.js";

const runMedia = hasFfmpeg || process.env.CI !== undefined;
const FPS = { num: 30, den: 1 };

/** A moving RGBA gradient (test input; premultiplied when `alpha` is 255). */
function makeFrames(count: number, w: number, h: number, alpha = 255) {
  return Array.from({ length: count }, (_, i) => {
    const frame = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 4;
        frame[at] = (x * 255) / w;
        frame[at + 1] = (y * 255) / h;
        frame[at + 2] = (i * 8) & 255;
        frame[at + 3] = alpha;
      }
    return frame;
  });
}

/** One second of a 440 Hz tone as raw f32le 48 kHz stereo. */
function sineFile(file: string, seconds: number) {
  const n = 48_000 * seconds;
  const data = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48_000);
    data[2 * i] = v;
    data[2 * i + 1] = v;
  }
  return writeFile(file, new Uint8Array(data.buffer));
}

interface Probe {
  streams: Record<string, unknown>[];
  format: { duration?: string };
}
const probe = (file: string): Probe =>
  JSON.parse(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]).toString(),
  );
const stream = (p: Probe, type: string) =>
  p.streams.find((s) => s.codec_type === type) as Record<string, unknown> | undefined;

describe.runIf(runMedia)("FFmpeg encode and PCM decode", () => {
  const ffmpeg = new Ffmpeg();
  let dir: string;
  let frames: Uint8Array[];
  let alphaFrames: Uint8Array[];
  let oddFrames: Uint8Array[];
  let audio: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kynimo-encode-test-"));
    frames = makeFrames(30, 64, 36);
    alphaFrames = makeFrames(30, 64, 36, 128);
    oddFrames = makeFrames(30, 63, 35);
    audio = join(dir, "tone.f32");
    await sineFile(audio, 1);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const options = (o: Partial<EncodeOptions> & Pick<EncodeOptions, "format" | "out">) => ({
    width: 64,
    height: 36,
    fps: FPS,
    frameCount: 30,
    audio: null,
    flatten: false,
    signal: new AbortController().signal,
    ...o,
  });
  const encode = async (o: EncodeOptions, input: Uint8Array[]) => {
    const encoder = ffmpeg.encode(o);
    for (const f of input) await encoder.write(f);
    await encoder.finish();
  };

  it("encodes mp4 with even dimensions, yuv420p and AAC audio", async () => {
    const out = join(dir, "a.mp4");
    const started = Date.now();
    await encode(options({ format: "mp4", out, audio, width: 63, height: 35 }), oddFrames);
    console.info(`mp4 encode of 30 frames took ${Date.now() - started} ms`);
    const p = probe(out);
    const v = stream(p, "video");
    expect(v).toMatchObject({ codec_name: "h264", pix_fmt: "yuv420p", width: 64, height: 36 });
    expect(Number(v?.nb_read_frames)).toBe(30);
    expect(stream(p, "audio")?.codec_name).toBe("aac");
    expect(Number(p.format.duration)).toBeCloseTo(1, 1);
  });

  it("encodes webm with alpha", async () => {
    const out = join(dir, "alpha.webm");
    const started = Date.now();
    await encode(options({ format: "webm", out, audio }), alphaFrames);
    console.info(`webm encode of 30 frames took ${Date.now() - started} ms`);
    const p = probe(out);
    const v = stream(p, "video");
    expect(v?.codec_name).toBe("vp9");
    expect((v?.tags as Record<string, string> | undefined)?.alpha_mode).toBe("1");
    expect(stream(p, "audio")?.codec_name).toBe("opus");
  });

  it("flattens webm over black when asked", async () => {
    const out = join(dir, "flat.webm");
    await encode(options({ format: "webm", out, flatten: true }), alphaFrames);
    const v = stream(probe(out), "video");
    expect(v?.codec_name).toBe("vp9");
    expect((v?.tags as Record<string, string> | undefined)?.alpha_mode).toBeUndefined();
    expect(v?.pix_fmt).toBe("yuv420p");
  });

  it("keeps the frame count of a straight-alpha webm", async () => {
    const out = join(dir, "count.webm");
    await encode(options({ format: "webm", out }), alphaFrames);
    expect(Number(stream(probe(out), "video")?.nb_read_frames)).toBe(30);
  });

  it("encodes gif without audio", async () => {
    const out = join(dir, "a.gif");
    const started = Date.now();
    await encode(options({ format: "gif", out }), frames);
    console.info(`gif encode of 30 frames took ${Date.now() - started} ms`);
    const p = probe(out);
    expect(stream(p, "video")?.codec_name).toBe("gif");
    expect(Number(stream(p, "video")?.nb_read_frames)).toBe(30);
    expect(stream(p, "audio")).toBeUndefined();
    expect((await readdir(dirname(out))).filter((n) => n.startsWith("kynimo-gif-"))).toEqual([]);
  });

  it("refuses audio on a gif", () => {
    expect(() => ffmpeg.encode(options({ format: "gif", out: join(dir, "x.gif"), audio }))).toThrow(
      MediaError,
    );
  });

  it("stops on abort and leaves no process", async () => {
    const ac = new AbortController();
    const encoder = ffmpeg.encode(
      options({ format: "mp4", out: join(dir, "abort.mp4"), signal: ac.signal }),
    );
    await encoder.write(frames[0] as Uint8Array);
    ac.abort();
    await expect(encoder.finish()).rejects.toThrow("the export was cancelled");
    await expect(encoder.write(frames[1] as Uint8Array)).rejects.toThrow("cancelled");
  });

  it("reports a bad frame without leaking the temp path", async () => {
    const out = join(dir, "bad.mp4");
    const encoder = ffmpeg.encode(options({ format: "mp4", out, audio: join(dir, "missing.f32") }));
    await encoder.write(frames[0] as Uint8Array).catch(() => undefined);
    const error = await encoder.finish().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MediaError);
    expect((error as Error).message).toMatch(/^the export could not be encoded/);
    expect((error as Error).message).not.toContain(dir);
  });

  it("rejects a frame of the wrong length", async () => {
    const encoder = ffmpeg.encode(options({ format: "mp4", out: join(dir, "len.mp4") }));
    await expect(encoder.write(new Uint8Array(500))).rejects.toThrow(
      /each frame must be 9216 bytes/,
    );
    await expect(encoder.write(oddFrames[0] as Uint8Array)).rejects.toThrow(MediaError);
    for (const f of frames) await encoder.write(f);
    await encoder.finish();
  });

  it("encodes repeated writes of one buffer", async () => {
    const out = join(dir, "repeat.mp4");
    const encoder = ffmpeg.encode(options({ format: "mp4", out, frameCount: 20 }));
    for (let i = 0; i < 20; i++) await encoder.write(frames[3] as Uint8Array);
    await encoder.finish();
    expect(Number(stream(probe(out), "video")?.nb_read_frames)).toBe(20);
  });

  it("rejects more frames than frameCount", async () => {
    const encoder = ffmpeg.encode(
      options({ format: "gif", out: join(dir, "many.gif"), frameCount: 2 }),
    );
    await encoder.write(frames[0] as Uint8Array);
    await encoder.write(frames[1] as Uint8Array);
    await expect(encoder.write(frames[2] as Uint8Array)).rejects.toThrow(/more than its 2 frames/);
    await encoder.finish();
  });

  it("fails when the encoder stalls", async () => {
    const encoder = ffmpeg.encode(
      options({ format: "mp4", out: join(dir, "stall.mp4"), stallMs: 100 }),
    );
    await encoder.write(frames[0] as Uint8Array);
    await new Promise((r) => setTimeout(r, 400));
    await expect(encoder.write(frames[1] as Uint8Array)).rejects.toThrow(
      /the encoder stalled for 0\.1 s/,
    );
    await expect(encoder.finish()).rejects.toThrow(/stalled/);
  });

  it("does not stall while frames keep coming", async () => {
    const encoder = ffmpeg.encode(
      options({ format: "mp4", out: join(dir, "steady.mp4"), stallMs: 1500, frameCount: 4 }),
    );
    for (let i = 0; i < 4; i++) {
      await encoder.write(frames[i] as Uint8Array);
      await new Promise((r) => setTimeout(r, 400));
    }
    await encoder.finish();
  });

  it("fails when finishing takes too long", async () => {
    const encoder = ffmpeg.encode(
      options({ format: "webm", out: join(dir, "slow.webm"), finishMs: 1 }),
    );
    for (const f of frames) await encoder.write(f);
    await expect(encoder.finish()).rejects.toThrow(
      /encoding took longer than 0\.001 s after the last frame/,
    );
  });

  it("removes the gif temp directory on success, failure and abort", async () => {
    const sub = await mkdtemp(join(dir, "gif-"));
    const leftovers = async () => (await readdir(sub)).filter((n) => n !== "ok.gif");
    await encode(options({ format: "gif", out: join(sub, "ok.gif") }), frames);
    expect(await leftovers()).toEqual([]);

    const ac = new AbortController();
    const encoder = ffmpeg.encode(
      options({ format: "gif", out: join(sub, "x.gif"), signal: ac.signal }),
    );
    await encoder.write(frames[0] as Uint8Array);
    expect((await readdir(sub)).some((n) => n.startsWith("kynimo-gif-"))).toBe(true);
    ac.abort();
    await expect(encoder.finish()).rejects.toThrow("cancelled");
    expect(await leftovers()).toEqual([]);
  });

  describe("decodePcm", () => {
    const flacOf = (seconds: number) => {
      const file = join(dir, `tone-${seconds}.flac`);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
        "-ac",
        "2",
        "-y",
        file,
      ]);
      return file;
    };
    const read = async (file: string) =>
      new Uint8Array(await import("node:fs").then((fs) => fs.readFileSync(file)));

    it("decodes to interleaved stereo f32", async () => {
      const pcm = await ffmpeg.decodePcm(await read(flacOf(1)), 48_000 * 10);
      expect(pcm.length).toBe(2 * 48_000);
      // A quiet tone (FFmpeg sine is 1/8 full scale, then upmixed).
      const peak = Math.max(...Array.from(pcm.subarray(0, 400), Math.abs));
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThan(0.15);
      expect(pcm[2 * 27]).toBe(pcm[2 * 27 + 1]);
    });

    it("fails once the audio passes maxSamples", async () => {
      await expect(ffmpeg.decodePcm(await read(flacOf(2)), 48_000)).rejects.toThrow(
        /the audio is longer than 1 s/,
      );
    });

    it("fails on garbage and removes its temp files", async () => {
      const before = (await readdir(tmpdir())).filter((n) => n.startsWith("kynimo-media-")).length;
      await expect(ffmpeg.decodePcm(new Uint8Array(100), 48_000)).rejects.toThrow(MediaError);
      const after = (await readdir(tmpdir())).filter((n) => n.startsWith("kynimo-media-")).length;
      expect(after).toBeLessThanOrEqual(before);
    });
  });
});
