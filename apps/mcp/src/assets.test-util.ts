import { readFileSync } from "node:fs";
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
