import { describe, expect, it } from "vitest";
// @ts-expect-error The script is plain JavaScript without types.
import { writeBmp } from "./bmp.mjs";

describe("writeBmp", () => {
  it("writes a 24-bit bottom-up BMP with rows padded to four bytes", () => {
    // 2x2: red, green / blue, white (RGBA, top row first).
    const rgba = Uint8Array.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const bmp: Buffer = writeBmp(2, 2, rgba);
    expect(bmp.toString("latin1", 0, 2)).toBe("BM");
    expect(bmp.readUInt32LE(2)).toBe(bmp.length);
    expect(bmp.readUInt32LE(10)).toBe(54);
    expect(bmp.readInt32LE(18)).toBe(2);
    expect(bmp.readInt32LE(22)).toBe(2);
    expect(bmp.readUInt16LE(28)).toBe(24);
    // Stride is 8 bytes (6 padded up): 54 + 2 * 8.
    expect(bmp.length).toBe(70);
    // The bottom row (blue, white) comes first, stored as B G R.
    expect([...bmp.subarray(54, 60)]).toEqual([255, 0, 0, 255, 255, 255]);
    // Then the top row (red, green).
    expect([...bmp.subarray(62, 68)]).toEqual([0, 0, 255, 0, 255, 0]);
  });

  it("rejects a pixel buffer of the wrong size", () => {
    expect(() => writeBmp(2, 2, new Uint8Array(3))).toThrow(/Expected 16 bytes/);
  });
});
