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
