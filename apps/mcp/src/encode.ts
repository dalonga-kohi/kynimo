import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportFormat } from "./export-files.js";
import type { Rational } from "./media.js";
import { detailOf, MediaError } from "./media-error.js";

export interface EncodeOptions {
  format: ExportFormat;
  /** Size of the raw RGBA frames that will be written. */
  width: number;
  height: number;
  fps: Rational;
  frameCount: number;
  /** Raw interleaved f32le 48 kHz stereo file, exactly the video's length; mp4/webm only. */
  audio: string | null;
  /**
   * True: frames are premultiplied RGBA and alpha is ignored, which is exactly "over black".
   * False: frames are straight RGBA and a webm keeps its alpha. mp4 and gif are always flattened,
   * so give them premultiplied frames.
   */
  flatten: boolean;
  /** Output file path, in a temp directory the caller owns (a gif also makes a temp directory next to it). */
  out: string;
  signal: AbortSignal;
  /** Longest time without a write or encoder output while frames are being written. Default 120 s. */
  stallMs?: number;
  /** Longest time from `finish()` until the last FFmpeg exits. Default max(120 s, 200 ms per frame). */
  finishMs?: number;
}

export interface Encoder {
  /** One raw frame, `width * height * 4` bytes RGBA, rows top to bottom. The same buffer may be written again. */
  write(frame: Uint8Array): Promise<void>;
  finish(): Promise<void>;
}

const DEFAULT_STALL_MS = 120_000;
const STDERR_LIMIT = 64 * 1024;

/** The filter graph of a single-pass encode (mp4, webm); only fixed text and integers go in. */
function filterGraph(o: EncodeOptions): string {
  switch (o.format) {
    case "mp4":
      return "[0:v]pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:black,format=yuv420p[v]";
    case "webm":
      return `[0:v]format=${o.flatten ? "yuv420p" : "yuva420p"}[v]`;
    case "gif":
      throw new Error("gif has its own graphs");
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
        "-tile-columns",
        "2",
        "-threads",
        "4",
        "-deadline",
        "good",
        "-cpu-used",
        "2",
        ...(o.flatten ? [] : ["-auto-alt-ref", "0"]),
        ...(o.audio === null ? [] : ["-c:a", "libopus", "-b:a", "128k"]),
      ];
    case "gif":
      return [];
  }
}

const positive = (n: number) => Number.isSafeInteger(n) && n > 0;

interface Proc {
  child: ChildProcess;
  /** Resolves once the process has exited (or failed to start). */
  closed: Promise<void>;
  exitCode(): number | null | undefined;
  stderr(): string;
}

/**
 * Starts FFmpeg reading raw RGBA frames on stdin; no shell, and no user text in the arguments.
 * An mp4 or webm is one FFmpeg. A gif is two, so memory stays bounded: the first writes a palette
 * and a lossless FFV1 copy of the frames to a temp directory next to the output, the second
 * (started by `finish()`) maps the copy through the palette.
 */
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
  const stallMs = o.stallMs ?? DEFAULT_STALL_MS;
  const finishMs = o.finishMs ?? Math.max(120_000, o.frameCount * 200);
  const frameBytes = o.width * o.height * 4;
  const flatten = o.flatten || o.format !== "webm";
  const gif = o.format === "gif";
  const tmp = gif ? mkdtempSync(join(dirname(o.out), "kynimo-gif-")) : null;
  const cleanup = () => {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  };

  const input = [
    "-f",
    "rawvideo",
    "-pix_fmt",
    flatten ? "rgb0" : "rgba",
    "-s",
    `${o.width}x${o.height}`,
    "-framerate",
    rate,
    "-i",
    "pipe:0",
  ];
  const args =
    tmp !== null
      ? [
          "-hide_banner",
          "-loglevel",
          "error",
          ...input,
          "-filter_complex",
          "[0:v]split[a][b];[a]palettegen=stats_mode=diff[p]",
          "-map",
          "[p]",
          "-update",
          "1",
          "-frames:v",
          "1",
          join(tmp, "palette.png"),
          "-map",
          "[b]",
          "-frames:v",
          String(o.frameCount),
          "-r",
          rate,
          "-c:v",
          "ffv1",
          "-level",
          "3",
          join(tmp, "frames.mkv"),
        ]
      : [
          "-hide_banner",
          "-loglevel",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          ...input,
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
  const secondPass = (dir: string) => [
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "file",
    "-i",
    join(dir, "frames.mkv"),
    "-i",
    join(dir, "palette.png"),
    "-lavfi",
    "[0:v][1:v]paletteuse=dither=sierra2_4a[v]",
    "-map",
    "[v]",
    "-loop",
    "0",
    "-f",
    "gif",
    "-y",
    o.out,
  ];

  let failure: MediaError | undefined;
  let current: Proc | undefined;
  let timer: NodeJS.Timeout | undefined;
  const disarm = () => clearTimeout(timer);
  const arm = (ms: number, why: string) => {
    disarm();
    timer = setTimeout(() => stop(new MediaError(why)), ms);
  };
  const stall = () => arm(stallMs, `the encoder stalled for ${stallMs / 1000} s`);
  const stop = (e: MediaError) => {
    failure ??= e;
    disarm();
    current?.child.kill("SIGKILL");
  };

  const launch = (argv: string[], stdin: boolean, onActivity: () => void): Proc => {
    const child = spawn(ffmpeg, argv, {
      stdio: [stdin ? "pipe" : "ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let code: number | null | undefined;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk;
      onActivity();
    });
    const closed = new Promise<void>((resolve) => {
      const done = (c: number | null) => {
        if (code !== undefined) return;
        code = c;
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
    child.stdin?.on("error", () => undefined);
    return { child, closed, exitCode: () => code, stderr: () => stderr };
  };

  const onAbort = () => stop(new MediaError("the export was cancelled"));
  const first = launch(args, true, () => {
    if (!finishing) stall();
  });
  current = first;
  let finishing = false;
  stall();
  // Whatever ends the first process without a finish() (abort, stall, crash) also ends the temp files.
  void first.closed.then(() => {
    if (failure !== undefined || !finishing) {
      disarm();
      o.signal.removeEventListener("abort", onAbort);
      cleanup();
    }
  });
  if (o.signal.aborted) onAbort();
  else o.signal.addEventListener("abort", onAbort, { once: true });

  // Scrubbed of the caller's temp paths, which must not reach a client.
  const scrub = (text: string) => {
    let out = text;
    for (const p of [o.out, o.audio])
      if (p !== null) out = out.split(p).join("<export>").split(dirname(p)).join("<export>");
    return out;
  };
  const exitError = (proc: Proc, argv: string[]) =>
    failure ??
    new MediaError(`the export could not be encoded${detailOf(scrub(proc.stderr()), argv)}`);

  let written = 0;
  let finished: Promise<void> | undefined;
  return {
    async write(frame) {
      if (failure) throw failure;
      if (first.exitCode() !== undefined) throw exitError(first, args);
      if (frame.byteLength !== frameBytes)
        throw new MediaError(
          `each frame must be ${frameBytes} bytes (${o.width}×${o.height} RGBA), got ${frame.byteLength}`,
        );
      if (written >= o.frameCount)
        throw new MediaError(`the export was given more than its ${o.frameCount} frames`);
      written++;
      stall();
      if (first.child.stdin?.write(frame) !== false) return;
      await new Promise<void>((resolve, reject) => {
        const stdin = first.child.stdin;
        const settle = (fn: () => void) => {
          stdin?.off("drain", onDrain);
          fn();
        };
        const onDrain = () => settle(resolve);
        stdin?.once("drain", onDrain);
        void first.closed.then(() => settle(() => reject(exitError(first, args))));
      });
    },
    finish() {
      finished ??= (async () => {
        finishing = true;
        try {
          arm(finishMs, `encoding took longer than ${finishMs / 1000} s after the last frame`);
          if (failure === undefined && first.exitCode() === undefined) first.child.stdin?.end();
          await first.closed;
          if (failure) throw failure;
          if (first.exitCode() !== 0) throw exitError(first, args);
          if (tmp !== null) {
            const argv = secondPass(tmp);
            const second = launch(argv, false, () => undefined);
            current = second;
            // An abort or timeout that fired between the two passes kills the second one at once.
            if (failure) second.child.kill("SIGKILL");
            await second.closed;
            if (failure) throw failure;
            if (second.exitCode() !== 0) throw exitError(second, argv);
          }
        } finally {
          disarm();
          o.signal.removeEventListener("abort", onAbort);
          cleanup();
        }
      })();
      return finished;
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
