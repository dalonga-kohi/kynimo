import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AssetInfoError, readFontInfo, readImageInfo } from "./asset-info.js";
import { canvasKit, encodeImage } from "./canvaskit.test-util.js";

const gray = (): [number, number, number, number] => [128, 128, 128, 255];

/** Inserts an APP1 Exif segment holding only an orientation tag right after the JPEG SOI. */
function withOrientation(jpeg: Uint8Array, orientation: number, order: "II" | "MM"): Uint8Array {
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  const v = new DataView(tiff.buffer);
  const le = order === "II";
  tiff.set([order.charCodeAt(0), order.charCodeAt(1)], 0);
  v.setUint16(2, 42, le);
  v.setUint32(4, 8, le);
  v.setUint16(8, 1, le);
  v.setUint16(10, 0x0112, le);
  v.setUint16(12, 3, le); // SHORT
  v.setUint32(14, 1, le);
  v.setUint16(18, orientation, le);
  const payload = Uint8Array.from([..."Exif"].map((c) => c.charCodeAt(0)).concat([0, 0]));
  const length = 2 + payload.length + tiff.length;
  const segment = new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff, ...payload, ...tiff]);
  return new Uint8Array([...jpeg.subarray(0, 2), ...segment, ...jpeg.subarray(2)]);
}

describe("readImageInfo", () => {
  it("reports the size a JPEG decodes to under its EXIF orientation, as CanvasKit does", async () => {
    const ck = await canvasKit();
    const jpeg = await encodeImage(7, 3, gray, "jpeg");
    for (const order of ["II", "MM"] as const)
      for (const orientation of [1, 3, 6, 8]) {
        const bytes = withOrientation(jpeg, orientation, order);
        const image = ck.MakeImageFromEncoded(bytes);
        const decoded = { width: image?.width(), height: image?.height() };
        image?.delete();
        expect(readImageInfo(bytes), `${order} ${orientation}`).toMatchObject(decoded);
        expect(decoded.width, `${order} ${orientation}`).toBe(orientation >= 5 ? 3 : 7);
      }
  });

  it("reads PNG and JPEG sizes from real encoder output", async () => {
    for (const format of ["png", "jpeg"] as const)
      expect(readImageInfo(await encodeImage(7, 3, gray, format))).toEqual({
        format,
        width: 7,
        height: 3,
      });
  });

  it("refuses other formats and truncated files with an AssetInfoError", async () => {
    expect(() => readImageInfo(new TextEncoder().encode("GIF89a..."))).toThrow(AssetInfoError);
    const png = await encodeImage(7, 3, gray, "png");
    expect(() => readImageInfo(png.subarray(0, 18))).toThrow(/truncated or malformed/);
    const jpeg = await encodeImage(7, 3, gray, "jpeg");
    expect(() => readImageInfo(jpeg.subarray(0, 4))).toThrow(AssetInfoError);
  });
});

/** A minimal sfnt with `name` and `OS/2` tables: enough for the header reads, not for drawing. */
function staticFont(names: { platform: number; id: number; text: string }[], weightClass: number) {
  const encode = (platform: number, text: string) =>
    platform === 1
      ? Uint8Array.from(text, (c) => c.charCodeAt(0))
      : Uint8Array.from([...text].flatMap((c) => [0, c.charCodeAt(0)]));
  const strings = names.map((n) => encode(n.platform, n.text));
  const nameSize = 6 + names.length * 12 + strings.reduce((s, b) => s + b.length, 0);
  const tables = [
    { tag: "OS/2", size: 8 },
    { tag: "name", size: nameSize },
  ];
  const header = 12 + tables.length * 16;
  const out = new Uint8Array(header + tables.reduce((s, t) => s + t.size, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tables.length);
  let offset = header;
  tables.forEach((t, i) => {
    for (let k = 0; k < 4; k++) out[12 + i * 16 + k] = t.tag.charCodeAt(k);
    view.setUint32(12 + i * 16 + 8, offset);
    view.setUint32(12 + i * 16 + 12, t.size);
    if (t.tag === "OS/2") view.setUint16(offset + 4, weightClass);
    else {
      view.setUint16(offset + 2, names.length);
      view.setUint16(offset + 4, 6 + names.length * 12);
      let at = 0;
      names.forEach((n, j) => {
        const rec = offset + 6 + j * 12;
        view.setUint16(rec, n.platform);
        view.setUint16(rec + 4, n.platform === 3 ? 0x409 : 0);
        view.setUint16(rec + 6, n.id);
        view.setUint16(rec + 8, strings[j]?.length ?? 0);
        view.setUint16(rec + 10, at);
        out.set(strings[j] ?? new Uint8Array(), offset + 6 + names.length * 12 + at);
        at += strings[j]?.length ?? 0;
      });
    }
    offset += t.size;
  });
  return out;
}

/** Hostile files must fail with AssetInfoError (or parse), never a RangeError or a hang. */
const onlyAssetErrors = (read: () => unknown) => {
  try {
    read();
  } catch (e) {
    expect(e).toBeInstanceOf(AssetInfoError);
  }
};

describe("hostile input", () => {
  it("JPEG: fill-byte runs, a cut-off SOF, short segments, a broken Exif block", async () => {
    const soi = [0xff, 0xd8];
    onlyAssetErrors(() => readImageInfo(Uint8Array.from([...soi, ...Array(5000).fill(0xff)])));
    onlyAssetErrors(() => readImageInfo(Uint8Array.from([...soi, 0xff, 0xc0, 0x00, 0x11, 0x08])));
    onlyAssetErrors(() => readImageInfo(Uint8Array.from([...soi, 0xff, 0xe0, 0x00, 0x01])));
    const jpeg = await encodeImage(7, 3, gray, "jpeg");
    // An Exif block whose IFD offset and entry count point far past its end is ignored.
    const broken = withOrientation(jpeg, 6, "MM");
    broken.set([0xff, 0xff, 0xff, 0xf0], 2 + 4 + 6 + 4);
    expect(readImageInfo(broken)).toMatchObject({ width: 7, height: 3 });
  });

  it("fonts: huge table and axis counts, names pointing past the end", () => {
    const font = staticFont([{ platform: 3, id: 1, text: "Brand" }], 400);
    const many = font.slice();
    new DataView(many.buffer).setUint16(4, 0xffff);
    onlyAssetErrors(() => readFontInfo(many));
    const pastEnd = font.slice();
    const v = new DataView(pastEnd.buffer);
    const nameTable = v.getUint32(12 + 16 + 8);
    v.setUint16(nameTable + 6 + 10, 0xfff0);
    onlyAssetErrors(() => readFontInfo(pastEnd));
    // An fvar claiming 65535 zero-sized axes: bounded by the u16 count, no wght found.
    const fvar = new Uint8Array(16);
    new DataView(fvar.buffer).setUint16(4, 16);
    new DataView(fvar.buffer).setUint16(8, 0xffff);
    const withFvar = new Uint8Array(font.length + 16 + fvar.length);
    withFvar.set(font.subarray(0, 12));
    const w = new DataView(withFvar.buffer);
    w.setUint16(4, 3);
    // Shift the two existing records and their tables by one record (16 bytes).
    withFvar.set(font.subarray(12, 44), 12);
    for (const i of [0, 1])
      w.setUint32(
        12 + i * 16 + 8,
        font.length === 0 ? 0 : new DataView(font.buffer).getUint32(12 + i * 16 + 8) + 16,
      );
    withFvar.set(
      [..."fvar"].map((c) => c.charCodeAt(0)),
      44,
    );
    w.setUint32(52, font.length + 16);
    withFvar.set(font.subarray(44), 60);
    withFvar.set(fvar, font.length + 16);
    onlyAssetErrors(() => readFontInfo(withFvar));
  });
});

describe("readFontInfo", () => {
  it("reads the family and wght axis range of the bundled variable fonts", async () => {
    expect(readFontInfo(await readFile(new URL("../fonts/inter.ttf", import.meta.url)))).toEqual({
      format: "truetype",
      family: "Inter",
      weight: { min: 100, max: 900 },
    });
    expect(
      readFontInfo(await readFile(new URL("../fonts/noto-sans.ttf", import.meta.url))).family,
    ).toBe("Noto Sans");
  });

  it("prefers the typographic family and Windows names, and reads a static weight", () => {
    const font = staticFont(
      [
        { platform: 1, id: 1, text: "Brand Mac" },
        { platform: 3, id: 1, text: "Brand Bold" },
        { platform: 3, id: 16, text: "Brand" },
      ],
      700,
    );
    expect(readFontInfo(font)).toEqual({
      format: "truetype",
      family: "Brand",
      weight: { min: 700, max: 700 },
    });
  });

  it("falls back to the legacy family, rounds odd weights and reads the old scaled form", () => {
    const named = (w: number) => staticFont([{ platform: 1, id: 1, text: "Old" }], w);
    expect(readFontInfo(named(350))).toMatchObject({
      family: "Old",
      weight: { min: 400, max: 400 },
    });
    expect(readFontInfo(named(3)).weight).toEqual({ min: 300, max: 300 });
    expect(readFontInfo(named(1000)).weight).toEqual({ min: 900, max: 900 });
  });

  it("refuses web fonts, collections, nameless and truncated files", () => {
    const tagged = (t: string) => Uint8Array.from([...t, "\0", "\0"], (c) => c.charCodeAt(0));
    expect(() => readFontInfo(tagged("wOF2"))).toThrow(/WOFF/);
    expect(() => readFontInfo(tagged("ttcf"))).toThrow(/collections/);
    expect(() => readFontInfo(staticFont([], 400))).toThrow(/names no font family/);
    expect(() =>
      readFontInfo(staticFont([{ platform: 3, id: 1, text: "X" }], 400).subarray(0, 30)),
    ).toThrow(AssetInfoError);
  });
});
