import { type FontFormat, MAX_FONT_BYTES, sniffFontFormat } from "./fonts.js";
import { type ImageFormat, sniffImageFormat } from "./images.js";

/**
 * Reads what an asset entry declares about a file (size, family, weights) from the file itself,
 * so an uploaded asset's metadata never depends on what a client claims. Pure byte parsing: no
 * decoding, no CanvasKit. Every read is bounds-checked; malformed files raise AssetInfoError.
 */
export class AssetInfoError extends Error {
  override name = "AssetInfoError";
}

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
}

export interface FontInfo {
  format: FontFormat;
  /** Typographic family (name id 16), else the legacy family (name id 1). */
  family: string;
  /** The `wght` axis range of a variable font, else the static weight; CSS steps of 100. */
  weight: { min: number; max: number };
}

class Reader {
  constructor(
    readonly bytes: Uint8Array,
    readonly what: string,
  ) {}
  private need(offset: number, size: number): void {
    if (offset < 0 || offset + size > this.bytes.length)
      throw new AssetInfoError(`${this.what}: the file is truncated or malformed`);
  }
  u8(o: number): number {
    this.need(o, 1);
    return this.bytes[o] as number;
  }
  u16(o: number): number {
    this.need(o, 2);
    return ((this.bytes[o] as number) << 8) | (this.bytes[o + 1] as number);
  }
  u32(o: number): number {
    this.need(o, 4);
    return this.u16(o) * 0x10000 + this.u16(o + 2);
  }
  /** 16.16 fixed point. */
  fixed(o: number): number {
    const raw = this.u32(o);
    return (raw >= 0x80000000 ? raw - 0x100000000 : raw) / 0x10000;
  }
  tag(o: number): string {
    this.need(o, 4);
    return String.fromCharCode(...this.bytes.subarray(o, o + 4));
  }
  slice(o: number, size: number): Uint8Array {
    this.need(o, size);
    return this.bytes.subarray(o, o + size);
  }
}

/** Width and height from the PNG IHDR chunk or the JPEG start-of-frame segment. */
export function readImageInfo(bytes: Uint8Array): ImageInfo {
  const format = sniffImageFormat(bytes);
  if (format === null)
    throw new AssetInfoError("not a PNG or JPEG file; images must be one of png, jpeg");
  const r = new Reader(bytes, format.toUpperCase());
  const size =
    format === "png" ? pngSize(r) : (jpegSize(r) ?? fail(r, "has no start-of-frame segment"));
  if (size.width < 1 || size.height < 1) fail(r, "declares an empty image");
  return { format, ...size };
}

const fail = (r: Reader, message: string): never => {
  throw new AssetInfoError(`${r.what}: the file ${message}`);
};

function pngSize(r: Reader) {
  if (r.tag(12) !== "IHDR") fail(r, "does not start with an IHDR chunk");
  return { width: r.u32(16), height: r.u32(20) };
}

/** Start-of-frame markers: baseline, progressive, lossless and arithmetic variants. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(r: Reader): { width: number; height: number } | undefined {
  let o = 2;
  while (o < r.bytes.length) {
    if (r.u8(o) !== 0xff) fail(r, "has a malformed segment");
    let marker = r.u8(o + 1);
    // Fill bytes before a marker.
    while (marker === 0xff) {
      o++;
      marker = r.u8(o + 1);
    }
    o += 2;
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = r.u16(o);
    if (length < 2) fail(r, "has a malformed segment");
    if (SOF.has(marker)) return { height: r.u16(o + 3), width: r.u16(o + 5) };
    o += length;
  }
  return undefined;
}

const NAME_TYPOGRAPHIC_FAMILY = 16;
const NAME_FAMILY = 1;

/** Family and weight range from the `name`, `OS/2` and `fvar` tables of a TrueType/OpenType file. */
export function readFontInfo(bytes: Uint8Array): FontInfo {
  if (bytes.length > MAX_FONT_BYTES)
    throw new AssetInfoError(`font files may be at most ${MAX_FONT_BYTES} bytes`);
  const format = sniffFontFormat(bytes);
  if (format === null)
    throw new AssetInfoError(
      "not a TrueType or OpenType font file (.ttf/.otf); WOFF, WOFF2 and collections (.ttc) are not supported",
    );
  const r = new Reader(bytes, "font");
  const tables = new Map<string, number>();
  const count = r.u16(4);
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16;
    tables.set(r.tag(rec), r.u32(rec + 8));
  }
  const name = tables.get("name");
  if (name === undefined) fail(r, "has no name table");
  const family =
    readName(r, name as number, NAME_TYPOGRAPHIC_FAMILY) ??
    readName(r, name as number, NAME_FAMILY);
  if (family === undefined || family.trim() === "") fail(r, "names no font family");
  const fvar = tables.get("fvar");
  const axis = fvar === undefined ? undefined : wghtAxis(r, fvar);
  let weight: { min: number; max: number };
  if (axis !== undefined) {
    const min = clampWeight(Math.ceil(axis.min / 100) * 100);
    const max = clampWeight(Math.floor(axis.max / 100) * 100);
    weight = min <= max ? { min, max } : { min: roundWeight(axis.min), max: roundWeight(axis.min) };
  } else {
    const os2 = tables.get("OS/2");
    const w = roundWeight(os2 === undefined ? 400 : r.u16(os2 + 4));
    weight = { min: w, max: w };
  }
  return { format, family: (family as string).trim(), weight };
}

const clampWeight = (w: number) => Math.min(900, Math.max(100, w));
/** usWeightClass 1–9 is an old scaled form of 100–900. */
const roundWeight = (w: number) => clampWeight(Math.round((w < 10 ? w * 100 : w) / 100) * 100);

function wghtAxis(r: Reader, fvar: number): { min: number; max: number } | undefined {
  const axesOffset = r.u16(fvar + 4);
  const axisCount = r.u16(fvar + 8);
  const axisSize = r.u16(fvar + 10);
  for (let i = 0; i < axisCount; i++) {
    const a = fvar + axesOffset + i * axisSize;
    if (r.tag(a) === "wght") return { min: r.fixed(a + 4), max: r.fixed(a + 12) };
  }
  return undefined;
}

/**
 * One name record, preferring Windows US English, then any Windows or Unicode record (UTF-16BE),
 * then Macintosh Roman (read as Latin-1, exact for the ASCII names fonts use).
 */
function readName(r: Reader, table: number, nameId: number): string | undefined {
  const count = r.u16(table + 2);
  const strings = table + r.u16(table + 4);
  let best: { rank: number; text: string } | undefined;
  for (let i = 0; i < count; i++) {
    const rec = table + 6 + i * 12;
    if (r.u16(rec + 6) !== nameId) continue;
    const platform = r.u16(rec);
    const language = r.u16(rec + 4);
    const raw = r.slice(strings + r.u16(rec + 10), r.u16(rec + 8));
    const rank =
      platform === 3 && language === 0x409 ? 0 : platform === 3 || platform === 0 ? 1 : 2;
    if (platform === 2 || platform > 3 || (best !== undefined && best.rank <= rank)) continue;
    best = { rank, text: platform === 1 ? latin1(raw) : utf16be(raw) };
  }
  return best?.text;
}

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);
function utf16be(b: Uint8Array): string {
  const units: number[] = [];
  for (let i = 0; i + 1 < b.length; i += 2)
    units.push(((b[i] as number) << 8) | (b[i + 1] as number));
  return String.fromCharCode(...units);
}
