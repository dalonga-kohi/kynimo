import {
  type Asset,
  BUNDLED_FONT_FAMILIES,
  type BundledFontFamily,
  isBundledFontFamily,
} from "@kynimo/scene";
import type { CanvasKit, Typeface, TypefaceFontProvider } from "canvaskit-wasm";
import { sha256Hex } from "./hash.js";

export type FontAsset = Extract<Asset, { type: "font" }>;

export interface WeightRange {
  readonly min: number;
  readonly max: number;
}

/** A font file every build ships, in this package's `fonts/` directory (ADR-0019). */
export interface BundledFont {
  readonly family: BundledFontFamily;
  /** File name under `fonts/`; hosts load the bytes and hand them to {@link FontLibrary.addBundled}. */
  readonly file: string;
  readonly sha256: string;
  /** The `wght` axis range of the variable font. */
  readonly weight: WeightRange;
  readonly license: "OFL-1.1";
}

/**
 * The bundled fonts, pinned by hash. Changing a file changes pixels, so it is a deliberate,
 * reviewed change like any other renderer pin (ADR-0016).
 */
export const BUNDLED_FONTS: readonly BundledFont[] = [
  {
    family: "Inter",
    file: "inter.ttf",
    sha256: "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031",
    weight: { min: 100, max: 900 },
    license: "OFL-1.1",
  },
  {
    family: "Noto Sans",
    file: "noto-sans.ttf",
    sha256: "bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d",
    weight: { min: 100, max: 900 },
    license: "OFL-1.1",
  },
];

/** Formats a font file may use. Collections and web-compressed fonts are refused (ADR-0019). */
export const FONT_FORMATS = ["truetype", "opentype"] as const;
export type FontFormat = (typeof FONT_FORMATS)[number];

/** Font files above this size are refused; the largest bundled one is about 2 MB. */
export const MAX_FONT_BYTES = 33_554_432;

const tag = (bytes: Uint8Array) => String.fromCharCode(...bytes.subarray(0, 4));

/** Detects the format from the file signature, never from the name or a declared type. */
export function sniffFontFormat(bytes: Uint8Array): FontFormat | null {
  const t = tag(bytes);
  if (t === "\u0000\u0001\u0000\u0000" || t === "true") return "truetype";
  if (t === "OTTO") return "opentype";
  return null;
}

const REFUSED: Record<string, string> = {
  wOFF: "WOFF fonts are not supported; upload the TrueType or OpenType (.ttf/.otf) file",
  wOF2: "WOFF2 fonts are not supported; upload the TrueType or OpenType (.ttf/.otf) file",
  ttcf: "font collections (.ttc) are not supported; upload each font as its own .ttf/.otf file",
};

export class FontAssetError extends Error {
  override name = "FontAssetError";
}

/** A loaded font file, registered with the paragraph font provider under a private alias. */
export interface LoadedFont {
  readonly family: string;
  readonly weight: WeightRange;
  /** Name Skia knows it by. Unique per file, so Skia's own style matching never picks for us. */
  readonly alias: string;
  readonly sha256: string;
  /** For character coverage checks (fallback and missing-glyph reports). */
  readonly typeface: Typeface;
}

/**
 * CSS Fonts 4 weight matching over the files of one family: a file whose range holds `weight`
 * wins; otherwise the nearest file in the CSS search order (for 400–500, heavier up to 500, then
 * lighter, then heavier; below 400, lighter first; above 500, heavier first).
 */
export function matchWeight<F extends { weight: WeightRange }>(
  files: readonly F[],
  weight: number,
): F | undefined {
  const exact = files.find((f) => f.weight.min <= weight && weight <= f.weight.max);
  if (exact !== undefined) return exact;
  const heavier = files
    .filter((f) => f.weight.min > weight)
    .sort((a, b) => a.weight.min - b.weight.min);
  const lighter = files
    .filter((f) => f.weight.max < weight)
    .sort((a, b) => b.weight.max - a.weight.max);
  if (weight < 400) return lighter[0] ?? heavier[0];
  if (weight > 500) return heavier[0] ?? lighter[0];
  return heavier.find((f) => f.weight.min <= 500) ?? lighter[0] ?? heavier[0];
}

/**
 * Fonts a frame may use, keyed by family. Loading bytes is the caller's job (bundled files ship
 * in this package's `fonts/`; uploaded ones come from the asset store, M3); rendering then reads
 * only from here. Skia sees only these fonts, never system fonts, so text shapes the same on every
 * host. Every add checks the bytes against their pin. Families are per document, so use one
 * library per document. Call {@link delete} when done: it holds CanvasKit objects.
 */
export class FontLibrary {
  readonly #ck: CanvasKit;
  readonly #provider: TypefaceFontProvider;
  readonly #fonts: LoadedFont[] = [];

  constructor(ck: CanvasKit) {
    this.#ck = ck;
    this.#provider = ck.TypefaceFontProvider.Make();
  }

  /** Loads one of the {@link BUNDLED_FONTS}, checking its pinned hash. */
  async addBundled(family: BundledFontFamily, bytes: Uint8Array): Promise<void> {
    const entry = BUNDLED_FONTS.find((f) => f.family === family);
    if (entry === undefined)
      throw new FontAssetError(
        `'${family}' is not a bundled font; bundled fonts are ${BUNDLED_FONT_FAMILIES.join(", ")}`,
      );
    await this.#add(`bundled font '${family}'`, family, entry.weight, entry.sha256, bytes);
  }

  /** Loads an uploaded font asset, checking hash, format and size. */
  async add(asset: FontAsset, bytes: Uint8Array): Promise<void> {
    if (isBundledFontFamily(asset.family))
      throw new FontAssetError(
        `asset '${asset.id}': '${asset.family}' is a bundled font family; give the uploaded font another family name`,
      );
    await this.#add(`asset '${asset.id}'`, asset.family, asset.weight, asset.sha256, bytes);
  }

  /** The file that draws `family` at `weight`, or `undefined` when the family is not loaded. */
  match(family: string, weight: number): LoadedFont | undefined {
    return matchWeight(
      this.#fonts.filter((f) => f.family === family),
      weight,
    );
  }

  /** @internal The paragraph font provider holding every loaded file. */
  get provider(): TypefaceFontProvider {
    return this.#provider;
  }

  /** Frees the CanvasKit objects; the library is unusable afterwards. */
  delete(): void {
    for (const f of this.#fonts) f.typeface.delete();
    this.#fonts.length = 0;
    this.#provider.delete();
  }

  async #add(
    what: string,
    family: string,
    weight: WeightRange,
    pin: string,
    bytes: Uint8Array,
  ): Promise<void> {
    if (bytes.length > MAX_FONT_BYTES)
      throw new FontAssetError(
        `${what}: font files may be at most ${MAX_FONT_BYTES} bytes (got ${bytes.length})`,
      );
    const hash = await sha256Hex(bytes, (m) => new FontAssetError(m));
    if (hash !== pin)
      throw new FontAssetError(`${what}: bytes hash to ${hash}, but the pin is ${pin}`);
    // Adding the same file again (a host reloading assets) is a no-op.
    if (this.#fonts.some((f) => f.family === family && f.sha256 === hash)) return;
    const clash = this.#fonts.find(
      (f) => f.family === family && f.weight.min <= weight.max && weight.min <= f.weight.max,
    );
    if (clash !== undefined)
      throw new FontAssetError(
        `${what}: family '${family}' already has a font covering weights ${clash.weight.min}–${clash.weight.max}`,
      );
    if (sniffFontFormat(bytes) === null)
      throw new FontAssetError(
        `${what}: ${REFUSED[tag(bytes)] ?? "not a TrueType or OpenType font file"}`,
      );
    // Copy into an exact ArrayBuffer: CanvasKit reads the whole buffer, not the view's window.
    const data = bytes.slice().buffer;
    const typeface = this.#ck.Typeface.MakeTypefaceFromData(data);
    if (typeface === null) throw new FontAssetError(`${what}: the font file does not load`);
    const alias = `kynimo-font-${this.#fonts.length}`;
    this.#provider.registerFont(data, alias);
    this.#fonts.push({ family, weight, alias, sha256: hash, typeface });
  }
}
