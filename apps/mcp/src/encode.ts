import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportFormat } from "./export-files.js";
import type { Rational } from "./media.js";
import { detailOf, MediaError } from "./media-error.js";

export interface EncodeOptions {
  format: ExportFormat;
  /** Size of the PNG frames that will be written. */
  width: number;
  height: number;
  fps: Rational;
  frameCount: number;
  /** Raw interleaved f32le 48 kHz stereo file, exactly the video's length; mp4/webm only. */
  audio: string | null;
  /** Flatten transparency over black (mp4 and gif always; webm when true). */
  flatten: boolean;
  /** Output file path, in a temp directory the caller owns. */
  out: string;
  signal: AbortSignal;
  /** Default 30 minutes. */
  timeoutMs?: number;
}

export interface Encoder {
  write(png: Uint8Array): Promise<void>;
  finish(): Promise<void>;
}

const DEFAULT_ENCODE_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_LIMIT = 64 * 1024;

/** The filter graph; only integers and fixed text go in, never user text. */
function filterGraph(o: EncodeOptions): string {
  const rate = `${o.fps.num}/${o.fps.den}`;
  const flatten = o.flatten || o.format !== "webm";
  const head = flatten
    ? `color=c=black:s=${o.width}x${o.height}:r=${rate}[bg];[bg][0:v]overlay=shortest=1:format=auto,format=rgb24`
    : "[0:v]format=rgba";
  switch (o.format) {
    case "mp4":
      return `${head},pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:black,format=yuv420p[v]`;
    case "webm":
      return `${head},format=${flatten ? "yuv420p" : "yuva420p"}[v]`;
    case "gif":
      return `${head},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a[v]`;
  }
}

function codecArgs(o: EncodeOptions): string[] {
  switch (o.format) {
    case "mp4":
      return [
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-profile:v",
        "high",
        "-movflags",
        "+faststart",
        ...(o.audio === null ? [] : ["-c:a", "aac", "-b:a", "192k"]),
      ];
    case "webm":
      return [
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "30",
        "-b:v",
        "0",
        "-row-mt",
        "1",
        "-deadline",
        "good",
        "-cpu-used",
        "2",
        ...(o.flatten ? [] : ["-auto-alt-ref", "0"]),
        ...(o.audio === null ? [] : ["-c:a", "libopus", "-b:a", "128k"]),
      ];
    case "gif":
      return ["-loop", "0"];
  }
}

const positive = (n: number) => Number.isSafeInteger(n) && n > 0;

/** Starts FFmpeg reading PNG frames on stdin; no shell, and no user text in the arguments. */
export function startEncode(ffmpeg: string, o: EncodeOptions): Encoder {
  if (o.format === "gif" && o.audio !== null) throw new MediaError("GIF exports have no audio");
  if (
    !positive(o.width) ||
    !positive(o.height) ||
    !positive(o.frameCount) ||
    !positive(o.fps.num) ||
    !positive(o.fps.den)
  )
    throw new MediaError("the export's size, frame rate and frame count must be positive integers");
  const rate = `${o.fps.num}/${o.fps.den}`;
  const timeoutMs = o.timeoutMs ?? DEFAULT_ENCODE_TIMEOUT_MS;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-f",
    "image2pipe",
    "-c:v",
    "png",
    "-framerate",
    rate,
    "-i",
    "pipe:0",
    ...(o.audio === null ? [] : ["-f", "f32le", "-ar", "48000", "-ac", "2", "-i", o.audio]),
    "-filter_complex",
    filterGraph(o),
    "-map",
    "[v]",
    ...(o.audio === null ? [] : ["-map", "1:a"]),
    "-frames:v",
    String(o.frameCount),
    "-r",
    rate,
    ...codecArgs(o),
    "-f",
    o.format,
    "-y",
    o.out,
  ];
  const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk;
  });
  let failure: MediaError | undefined;
  let exitCode: number | null | undefined;
  const stop = (e: MediaError) => {
    failure ??= e;
    child.kill("SIGKILL");
  };
  const onAbort = () => stop(new MediaError("the export was cancelled"));
  const timer = setTimeout(
    () => stop(new MediaError(`encoding took longer than ${timeoutMs / 1000} s`)),
    timeoutMs,
  );
  const closed = new Promise<void>((resolve) => {
    const done = (code: number | null) => {
      if (exitCode !== undefined) return;
      exitCode = code;
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onAbort);
      resolve();
    };
    child.on("error", (e) => {
      failure ??= new MediaError(
        (e as { code?: unknown }).code === "ENOENT"
          ? `${ffmpeg} is not installed`
          : "the export could not be encoded",
      );
      done(-1);
    });
    child.on("close", done);
  });
  // A broken pipe shows up as FFmpeg's exit; the write error itself carries nothing more.
  child.stdin.on("error", () => undefined);
  if (o.signal.aborted) onAbort();
  else o.signal.addEventListener("abort", onAbort, { once: true });

  // Scrubbed of the caller's temp paths, which must not reach a client.
  const scrub = (text: string) => {
    let out = text;
    for (const p of [o.out, o.audio])
      if (p !== null) out = out.split(p).join("<export>").split(dirname(p)).join("<export>");
    return out;
  };
  const exitError = () =>
    failure ?? new MediaError(`the export could not be encoded${detailOf(scrub(stderr), args)}`);

  let written = 0;
  return {
    async write(png) {
      if (failure) throw failure;
      if (exitCode !== undefined) throw exitError();
      if (written >= o.frameCount)
        throw new MediaError(`the export was given more than its ${o.frameCount} frames`);
      written++;
      if (child.stdin.write(png)) return;
      await new Promise<void>((resolve, reject) => {
        const settle = (fn: () => void) => {
          child.stdin.off("drain", onDrain);
          fn();
        };
        const onDrain = () => settle(resolve);
        child.stdin.once("drain", onDrain);
        void closed.then(() => settle(() => reject(exitError())));
      });
    },
    async finish() {
      if (failure === undefined && exitCode === undefined) child.stdin.end();
      await closed;
      if (failure) throw failure;
      if (exitCode !== 0) throw exitError();
    },
  };
}

/**
 * Decodes a stored FLAC to interleaved f32 samples (little-endian, as every platform we run on
 * is) through a temp file, since stdin is not allowed as input. Stops FFmpeg once more than
 * `maxSamples` frames have come out.
 */
export async function decodePcm(
  ffmpeg: string,
  flac: Uint8Array,
  maxSamples: number,
  timeoutMs: number,
): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), "kynimo-media-"));
  try {
    const file = join(dir, "audio.flac");
    await writeFile(file, flac);
    const args = [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "file",
      "-f",
      "flac",
      "-i",
      file,
      "-f",
      "f32le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ];
    const child = spawn(ffmpeg, args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk;
    });
    let failure: MediaError | undefined;
    const stop = (e: MediaError) => {
      failure ??= e;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop(new MediaError(`decoding took longer than ${timeoutMs / 1000} s`)),
      timeoutMs,
    );
    const exited = new Promise<number | null>((resolve) => {
      child.on("error", (e) => {
        failure ??= new MediaError(
          (e as { code?: unknown }).code === "ENOENT"
            ? `${ffmpeg} is not installed`
            : "the audio could not be decoded",
        );
        resolve(-1);
      });
      child.on("close", (code) => resolve(code));
    });
    const maxBytes = maxSamples * 8;
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        stop(new MediaError(`the audio is longer than ${Math.round(maxSamples / 48_000)} s`));
        return;
      }
      chunks.push(chunk);
    });
    const code = await exited;
    clearTimeout(timer);
    if (failure) throw failure;
    if (code !== 0) throw new MediaError(`the audio could not be decoded${detailOf(stderr, args)}`);
    // Copied into a fresh buffer so the Float32Array view is 4-byte aligned.
    const frames = Math.floor(bytes / 8);
    const samples = new Float32Array(frames * 2);
    new Uint8Array(samples.buffer).set(Buffer.concat(chunks).subarray(0, frames * 8));
    return samples;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
