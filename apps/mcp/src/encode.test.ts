import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg } from "./assets.test-util.js";
import type { EncodeOptions } from "./encode.js";
import { Ffmpeg, MediaError } from "./media.js";

const runMedia = hasFfmpeg || process.env.CI !== undefined;
const FPS = { num: 30, den: 1 };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG frames from FFmpeg's own generators (test code only). */
function makeFrames(source: string, count: number, w: number, h: number, alpha = false) {
  const out = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `${source}size=${w}x${h}:rate=30`,
      "-frames:v",
      String(count),
      ...(alpha ? ["-pix_fmt", "rgba"] : []),
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "pipe:1",
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const starts: number[] = [];
  for (let at = out.indexOf(SIGNATURE); at >= 0; at = out.indexOf(SIGNATURE, at + 8))
    starts.push(at);
  return starts.map((s, i) => new Uint8Array(out.subarray(s, starts[i + 1] ?? out.length)));
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
    frames = makeFrames("testsrc2=", 30, 64, 36);
    alphaFrames = makeFrames("color=c=0xff000080:", 30, 64, 36, true);
    oddFrames = makeFrames("testsrc2=", 30, 63, 35);
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

  it("encodes gif without audio", async () => {
    const out = join(dir, "a.gif");
    const started = Date.now();
    await encode(options({ format: "gif", out }), frames);
    console.info(`gif encode of 30 frames took ${Date.now() - started} ms`);
    const p = probe(out);
    expect(stream(p, "video")?.codec_name).toBe("gif");
    expect(Number(stream(p, "video")?.nb_read_frames)).toBe(30);
    expect(stream(p, "audio")).toBeUndefined();
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
    const encoder = ffmpeg.encode(options({ format: "mp4", out, audio }));
    await encoder.write(new Uint8Array(500).fill(7)).catch(() => undefined);
    const error = await encoder.finish().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MediaError);
    expect((error as Error).message).toMatch(/^the export could not be encoded/);
    expect((error as Error).message).not.toContain(dir);
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

  it("times out", async () => {
    const encoder = ffmpeg.encode(
      options({ format: "mp4", out: join(dir, "slow.mp4"), timeoutMs: 1 }),
    );
    await encoder.write(frames[0] as Uint8Array).catch(() => undefined);
    await expect(encoder.finish()).rejects.toThrow(/encoding took longer than/);
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
