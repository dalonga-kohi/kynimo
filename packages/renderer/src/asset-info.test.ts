import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AssetInfoError, readFontInfo, readImageInfo } from "./asset-info.js";
import { encodeImage } from "./canvaskit.test-util.js";

const gray = (): [number, number, number, number] => [128, 128, 128, 255];

describe("readImageInfo", () => {
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
