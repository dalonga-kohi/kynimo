import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";

/** What FFmpeg may read: the uploaded temp file only, through these container formats (ADR-0032). */
const INPUT_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,wav,mp3,flac,ogg";

/**
 * Options before every `-i`. `protocol_whitelist file` and the format whitelist shut out playlists,
 * concat lists and network protocols, so a crafted upload can't make FFmpeg read other files or
 * hosts; `-nostdin` keeps it from waiting on input.
 */
const SAFE_INPUT = [
  "-nostdin",
  "-hide_banner",
  "-v",
  "error",
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  INPUT_FORMATS,
];

/** Largest source footage FFmpeg may decode, checked before decoding and enforced by FFmpeg. */
export const MAX_SOURCE_EDGE = 8192;
export const MAX_SOURCE_PIXELS = 2 ** 26;

export interface Rational {
  num: number;
  den: number;
}

export interface MediaProbe {
  /** The first video stream that is not cover art, with its display size (rotation applied). */
  video?: { width: number; height: number; fps: Rational };
  hasAudio: boolean;
  /** Container duration; 0 when unknown. */
  durationMs: number;
}

/** Decoding at upload. FFmpeg in production; tests may substitute it. */
export interface MediaTools {
  /** e.g. "ffmpeg 6.1.1"; recorded in frame manifests. */
  version(): Promise<string>;
  probe(file: string): Promise<MediaProbe>;
  /**
   * Decodes the first video stream to constant-rate JPEG frames at `fps`, scaled to exactly
   * `width`×`height`, calling `onFrame` with each in order as it is produced (nothing is
   * written to disk). Stops FFmpeg and fails once the frames pass `maxBytes`.
   */
  decodeFrames(
    file: string,
    o: {
      fps: Rational;
      width: number;
      height: number;
      maxFrames: number;
      maxSeconds: number;
      maxBytes: number;
    },
    onFrame: (jpeg: Uint8Array) => Promise<void>,
  ): Promise<number>;
  /** Extracts the first audio stream to 48 kHz stereo FLAC; returns its duration. */
  extractAudio(file: string, out: string, maxSeconds: number): Promise<{ durationMs: number }>;
}

export class MediaError extends Error {
  override name = "MediaError";
}

interface FfmpegOptions {
  ffmpeg?: string;
  ffprobe?: string;
  /** Per FFmpeg run. */
  timeoutMs?: number;
}

/** Parses "30000/1001"; undefined for "0/0" and other non-rates. */
export function parseRate(text: unknown): Rational | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^(\d+)\/(\d+)$/.exec(text);
  if (!m) return undefined;
  const num = Number(m[1]);
  const den = Number(m[2]);
  return num > 0 && den > 0 && Number.isSafeInteger(num) && Number.isSafeInteger(den)
    ? { num, den }
    : undefined;
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  sample_aspect_ratio?: string;
}

/** Reads ffprobe's JSON; exported for tests. */
export function readProbe(json: unknown): MediaProbe {
  const data = json as { streams?: ProbeStream[]; format?: { duration?: string } };
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const seconds = Number(data.format?.duration);
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const v = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (v === undefined || !(Number(v.width) > 0) || !(Number(v.height) > 0))
    return { hasAudio, durationMs };
  const fps = parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate);
  if (fps === undefined) throw new MediaError("the video stream has no frame rate");
  const rotation = Number(
    v.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? v.tags?.rotate ?? 0,
  );
  const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  // Non-square pixels (anamorphic footage): the displayed width is the stored width × SAR.
  const sar = /^(\d+):(\d+)$/.exec(v.sample_aspect_ratio ?? "");
  const sarNum = Number(sar?.[1] ?? 1);
  const sarDen = Number(sar?.[2] ?? 1);
  const coded = { width: Number(v.width), height: Number(v.height) };
  if (
    coded.width > MAX_SOURCE_EDGE ||
    coded.height > MAX_SOURCE_EDGE ||
    coded.width * coded.height > MAX_SOURCE_PIXELS
  )
    throw new MediaError(
      `the video is ${coded.width}×${coded.height}; sources may be at most ${MAX_SOURCE_EDGE} px on an edge and ${MAX_SOURCE_PIXELS} pixels`,
    );
  const width =
    sarNum > 0 && sarDen > 0 && sarNum !== sarDen
      ? Math.max(1, Math.round((coded.width * sarNum) / sarDen))
      : coded.width;
  const height = coded.height;
  return {
    video: quarter ? { width: height, height: width, fps } : { width, height, fps },
    hasAudio,
    durationMs,
  };
}

/** FFmpeg and ffprobe binaries on PATH (or given paths), run without a shell and with a timeout. */
export class Ffmpeg implements MediaTools {
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly timeoutMs: number;
  private versionText: Promise<string> | undefined;

  constructor(options: FfmpegOptions = {}) {
    this.ffmpeg = options.ffmpeg ?? "ffmpeg";
    this.ffprobe = options.ffprobe ?? "ffprobe";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private run(bin: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          timeout: this.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          ...(cwd === undefined ? {} : { cwd }),
        },
        (error, stdout, stderr) => {
          if (error === null) return resolve(stdout);
          if ((error as { code?: unknown }).code === "ENOENT")
            return reject(new MediaError(`${bin} is not installed`));
          if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            return reject(new MediaError("FFmpeg's output was too large"));
          if (error.killed)
            return reject(new MediaError(`decoding took longer than ${this.timeoutMs / 1000} s`));
          reject(new MediaError(`the file could not be decoded${detailOf(stderr, args)}`));
        },
      );
    });
  }

  /** Whether both binaries run; for choosing to offer media uploads at startup. */
  async available(): Promise<boolean> {
    try {
      await this.version();
      await this.run(this.ffprobe, ["-version"]);
      return true;
    } catch {
      this.versionText = undefined;
      return false;
    }
  }

  version(): Promise<string> {
    this.versionText ??= this.run(this.ffmpeg, ["-version"]).then((out) => {
      const m = /^ffmpeg version (\S+)/.exec(out);
      return `ffmpeg ${m?.[1] ?? "unknown"}`;
    });
    return this.versionText;
  }

  async probe(file: string): Promise<MediaProbe> {
    const out = await this.run(this.ffprobe, [
      ...SAFE_INPUT.filter((a) => a !== "-nostdin"),
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      file,
    ]);
    try {
      return readProbe(JSON.parse(out));
    } catch (e) {
      if (e instanceof MediaError) throw e;
      throw new MediaError("the file could not be probed");
    }
  }

  async decodeFrames(
    file: string,
    o: {
      fps: Rational;
      width: number;
      height: number;
      maxFrames: number;
      maxSeconds: number;
      maxBytes: number;
    },
    onFrame: (jpeg: Uint8Array) => Promise<void>,
  ): Promise<number> {
    const args = [
      ...SAFE_INPUT,
      "-max_pixels",
      String(MAX_SOURCE_PIXELS),
      "-threads",
      "1",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-t",
      String(o.maxSeconds),
      "-vf",
      `fps=${o.fps.num}/${o.fps.den},scale=${o.width}:${o.height}:flags=lanczos,setsar=1`,
      "-frames:v",
      String(o.maxFrames),
      "-c:v",
      "mjpeg",
      "-q:v",
      "2",
      "-threads",
      "1",
      "-fflags",
      "+bitexact",
      "-flags:v",
      "+bitexact",
      "-f",
      "image2pipe",
      "pipe:1",
    ];
    const child = spawn(this.ffmpeg, args, {
      cwd: dirname(file),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    let failure: MediaError | undefined;
    const stop = (e: MediaError) => {
      failure ??= e;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop(new MediaError(`decoding took longer than ${this.timeoutMs / 1000} s`)),
      this.timeoutMs,
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on("error", (e) =>
        reject(
          (e as { code?: unknown }).code === "ENOENT"
            ? new MediaError(`${this.ffmpeg} is not installed`)
            : e,
        ),
      );
      child.on("close", (code) => resolve(code));
    });
    // Awaited only on success; a late spawn error after a failed read must not go unhandled.
    exited.catch(() => undefined);
    const split = new JpegSplitter();
    let frames = 0;
    let bytes = 0;
    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        if (failure) break;
        for (const jpeg of split.push(new Uint8Array(chunk))) {
          bytes += jpeg.byteLength;
          if (bytes > o.maxBytes) {
            stop(
              new MediaError(
                `the decoded frames would pass ${o.maxBytes} bytes; upload a shorter or smaller clip`,
              ),
            );
            break;
          }
          frames++;
          // Awaiting here pauses the stream: FFmpeg waits while a frame is stored.
          await onFrame(jpeg);
        }
      }
    } catch (e) {
      child.kill("SIGKILL");
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const code = await exited;
    if (failure) throw failure;
    if (code !== 0) throw new MediaError(`the file could not be decoded${detailOf(stderr, args)}`);
    if (split.pending) throw new MediaError("FFmpeg ended in the middle of a frame");
    return frames;
  }

  async extractAudio(
    file: string,
    out: string,
    maxSeconds: number,
  ): Promise<{ durationMs: number }> {
    await this.run(this.ffmpeg, [
      ...SAFE_INPUT,
      "-threads",
      "1",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-t",
      String(maxSeconds),
      "-ac",
      "2",
      "-ar",
      "48000",
      "-c:a",
      "flac",
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      "-f",
      "flac",
      out,
    ]);
    const probed = await this.probe(out);
    if (probed.durationMs <= 0) throw new MediaError("the audio track is empty");
    return { durationMs: probed.durationMs };
  }
}

/**
 * FFmpeg's last error lines, with the temp directory's path replaced so it never reaches a
 * client. `args` holds the paths FFmpeg was given.
 */
function detailOf(stderr: string, args: readonly string[]): string {
  let text = stderr.trim().split("\n").slice(-3).join("; ");
  for (const a of args)
    if (a.includes("kynimo-media-")) text = text.split(dirname(a)).join("<upload>");
  text = text.slice(0, 500);
  return text ? `: ${text}` : "";
}

/**
 * Splits a stream of concatenated baseline/progressive JPEG files (FFmpeg's image2pipe) into
 * files by walking their segments: lengths up to each scan, then entropy-coded data, where a
 * 0xFF is either stuffed (FF 00), a restart marker (FF D0–D7) or the next marker. Exact, unlike
 * searching for FF D8 / FF D9, which can occur inside tables.
 */
export class JpegSplitter {
  private buf = new Uint8Array(0);
  /** Where scanning resumes inside `buf`, and whether it is inside entropy-coded data. */
  private at = 0;
  private inScan = false;

  get pending(): boolean {
    return this.buf.length > 0;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    this.buf = joined;
    const out: Uint8Array[] = [];
    for (;;) {
      const end = this.scan();
      if (end === undefined) break;
      out.push(this.buf.slice(0, end));
      this.buf = this.buf.slice(end);
      this.at = 0;
      this.inScan = false;
    }
    return out;
  }

  /** The end of the first complete file in `buf`, or undefined when more bytes are needed. */
  private scan(): number | undefined {
    const b = this.buf;
    if (this.at === 0) {
      if (b.length < 2) return undefined;
      if (b[0] !== 0xff || b[1] !== 0xd8) throw new MediaError("FFmpeg sent a malformed frame");
      this.at = 2;
    }
    while (this.at + 1 < b.length) {
      if (this.inScan) {
        if (b[this.at] !== 0xff) {
          this.at++;
          continue;
        }
        const next = b[this.at + 1] as number;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
          this.at += next === 0xff ? 1 : 2;
          continue;
        }
        this.inScan = false; // a marker: back to segments
      }
      if (b[this.at] !== 0xff) throw new MediaError("FFmpeg sent a malformed frame");
      const marker = b[this.at + 1] as number;
      if (marker === 0xff) {
        this.at++;
        continue;
      }
      if (marker === 0xd9) return this.at + 2;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        this.at += 2;
        continue;
      }
      if (this.at + 3 >= b.length) return undefined;
      const length = ((b[this.at + 2] as number) << 8) | (b[this.at + 3] as number);
      if (length < 2) throw new MediaError("FFmpeg sent a malformed frame");
      if (this.at + 2 + length > b.length) return undefined;
      this.at += 2 + length;
      if (marker === 0xda) this.inScan = true;
    }
    return undefined;
  }
}
