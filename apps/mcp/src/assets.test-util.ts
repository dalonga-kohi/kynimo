import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

/** A real PNG (8-bit RGBA, no filtering) of one color. */
export function solidPng(width: number, height: number, rgba = [255, 0, 0, 255]): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgba).flat())]);
  const raw = Buffer.concat(Array(height).fill(row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** The renderer's bundled Inter (variable, 100–900): a real font file for upload tests. */
export const interTtf = (): Uint8Array =>
  new Uint8Array(
    readFileSync(new URL("../../../packages/renderer/fonts/inter.ttf", import.meta.url)),
  );

export const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Whether FFmpeg is on PATH; media tests run when it is, and always in CI. */
export const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * A test clip made with FFmpeg's own generators (test code only: the server never reads lavfi).
 * `audio` adds a sine tone; `rotate` adds a display rotation, as phones record it.
 */
export function makeClip(o: {
  width: number;
  height: number;
  fps: string;
  seconds: number;
  audio?: boolean;
  format?: "mp4" | "webm";
  rotate?: number;
}): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "kynimo-clip-"));
  const out = join(dir, `clip.${o.format ?? "mp4"}`);
  try {
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `testsrc=size=${o.width}x${o.height}:rate=${o.fps}:duration=${o.seconds}`,
        ...(o.audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${o.seconds}`] : []),
        ...(o.format === "webm"
          ? ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-c:a", "libopus"]
          : ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"]),
        "-shortest",
        out,
      ],
      { stdio: "ignore" },
    );
    if (o.rotate === undefined) return new Uint8Array(readFileSync(out));
    // A display matrix, as phones write it (the legacy `rotate` tag is ignored by FFmpeg 6+).
    const turned = join(dir, `turned.${o.format ?? "mp4"}`);
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-display_rotation", String(o.rotate), "-i", out, "-c", "copy", turned],
      { stdio: "ignore" },
    );
    return new Uint8Array(readFileSync(turned));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An audio-only file. */
export function makeTone(seconds: number, format: "wav" | "mp3" = "wav"): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "kynimo-tone-"));
  const out = join(dir, `tone.${format}`);
  try {
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, out],
      { stdio: "ignore" },
    );
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Interleaved stereo f32 at 48 kHz: a 1 kHz click on every beat of a steady tempo, silence between. */
export function clickPcm(bpm: number, seconds: number, offsetMs = 250): Float32Array {
  const rate = 48_000;
  const frames = Math.round(seconds * rate);
  const pcm = new Float32Array(frames * 2);
  const period = 60_000 / bpm;
  for (let ms = offsetMs; ms < seconds * 1000 - 50; ms += period) {
    const start = Math.round((ms * rate) / 1000);
    for (let i = 0; i < 960 && start + i < frames; i++) {
      const t = i / rate;
      const v = 0.8 * Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-t / 0.005);
      pcm[(start + i) * 2] = v;
      pcm[(start + i) * 2 + 1] = v;
    }
  }
  return pcm;
}

/** A 16-bit stereo 48 kHz PCM WAV of {@link clickPcm}, with a hand-written header. */
export function clickWav(bpm: number, seconds: number): Uint8Array {
  const pcm = clickPcm(bpm, seconds);
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++)
    data.writeInt16LE(Math.round((pcm[i] as number) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(48_000 * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}
