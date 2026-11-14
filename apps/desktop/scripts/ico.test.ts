import { describe, expect, it } from "vitest";
// @ts-expect-error The script is plain JavaScript without types.
import { writeIco } from "./ico.mjs";

const png = (n: number) => Buffer.alloc(n, n);

describe("writeIco", () => {
  it("writes the header, one directory entry per image and the image data", () => {
    const ico: Buffer = writeIco([
      { size: 16, png: png(10) },
      { size: 256, png: png(20) },
    ]);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico.length).toBe(6 + 32 + 10 + 20);

    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(7)).toBe(16);
    expect(ico.readUInt16LE(6 + 6)).toBe(32);
    expect(ico.readUInt32LE(6 + 8)).toBe(10);
    expect(ico.readUInt32LE(6 + 12)).toBe(38);

    // 256 is stored as 0.
    expect(ico.readUInt8(22)).toBe(0);
    expect(ico.readUInt32LE(22 + 8)).toBe(20);
    expect(ico.readUInt32LE(22 + 12)).toBe(48);
    expect(ico.subarray(48, 68).equals(png(20))).toBe(true);
    expect(ico.subarray(38, 48).equals(png(10))).toBe(true);
  });

  it("rejects an empty list and sizes outside 1 to 256", () => {
    expect(() => writeIco([])).toThrow(/at least one/);
    expect(() => writeIco([{ size: 512, png: png(1) }])).toThrow(/1 to 256/);
    expect(() => writeIco([{ size: 0, png: png(1) }])).toThrow(/1 to 256/);
  });
});
