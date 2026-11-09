import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

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
   * Decodes the first video stream to constant-rate JPEG frames `outDir/000000.jpg`, … at `fps`,
   * scaled to exactly `width`×`height`; returns the frame files in order.
   */
  decodeFrames(
    file: string,
    outDir: string,
    o: { fps: Rational; width: number; height: number; maxFrames: number; maxSeconds: number },
  ): Promise<string[]>;
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
  const width = Number(v.width);
  const height = Number(v.height);
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
          if (error.killed)
            return reject(new MediaError(`decoding took longer than ${this.timeoutMs / 1000} s`));
          // FFmpeg's own message for the file (never includes host paths beyond the temp file).
          const detail = stderr.trim().split("\n").slice(-3).join("; ").slice(0, 500);
          reject(new MediaError(`the file could not be decoded${detail ? `: ${detail}` : ""}`));
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
    outDir: string,
    o: { fps: Rational; width: number; height: number; maxFrames: number; maxSeconds: number },
  ): Promise<string[]> {
    await this.run(
      this.ffmpeg,
      [
        ...SAFE_INPUT,
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
        "-start_number",
        "0",
        "-f",
        "image2",
        join(outDir, "%06d.jpg"),
      ],
      outDir,
    );
    const names = (await readdir(outDir)).filter((n) => /^\d{6}\.jpg$/.test(n)).sort();
    return names.map((n) => join(outDir, n));
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
