import { type Asset, MAX_COMPOSITION_SIZE } from "@kynimo/scene";
import type { CanvasKit } from "canvaskit-wasm";
import type { RasterImage } from "./raster.js";

export type ImageAsset = Extract<Asset, { type: "image" }>;

/**
 * Formats image assets may use. PNG and JPEG decode to identical bytes in Node and in the pinned
 * Chromium with CanvasKit's own codecs (ADR-0016 spike). Others are added only with that check.
 */
export const IMAGE_FORMATS = ["png", "jpeg"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

const SIGNATURES: Record<ImageFormat, readonly number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff],
};

/** Detects the format from the file signature, never from the name or a declared type. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  for (const format of IMAGE_FORMATS)
    if (SIGNATURES[format].every((b, i) => bytes[i] === b)) return format;
  return null;
}

export class ImageAssetError extends Error {
  override name = "ImageAssetError";
}

// lib is ES2023 without DOM: describe just the Web Crypto call we use (Node 22+, browsers, workers).
type Subtle = { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
const subtle = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (subtle === undefined) throw new ImageAssetError("Web Crypto (crypto.subtle) is unavailable");
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decoded image assets, keyed by asset id. Loading bytes is the caller's job (the asset store,
 * M3); rendering then reads only from here, so the render path never touches the network.
 * Every add checks the bytes against the document's pin, so a document always renders the pixels
 * it was made with.
 */
export class ImageLibrary {
  readonly #ck: CanvasKit;
  readonly #images = new Map<string, RasterImage>();

  constructor(ck: CanvasKit) {
    this.#ck = ck;
  }

  /** Verifies hash, format and size, then decodes with CanvasKit's codecs. */
  async add(asset: ImageAsset, bytes: Uint8Array): Promise<void> {
    // Bounds decode memory, and the compositor could not upload a larger texture anyway.
    if (asset.width > MAX_COMPOSITION_SIZE || asset.height > MAX_COMPOSITION_SIZE)
      throw new ImageAssetError(
        `asset '${asset.id}': images may be at most ${MAX_COMPOSITION_SIZE}×${MAX_COMPOSITION_SIZE} pixels (got ${asset.width}×${asset.height}); downscale it before uploading`,
      );
    const hash = await sha256Hex(bytes);
    if (hash !== asset.sha256)
      throw new ImageAssetError(
        `asset '${asset.id}': bytes hash to ${hash}, but the document pins ${asset.sha256}`,
      );
    if (sniffImageFormat(bytes) === null)
      throw new ImageAssetError(
        `asset '${asset.id}': unsupported image format; use one of ${IMAGE_FORMATS.join(", ")}`,
      );
    this.#images.set(asset.id, this.#decode(asset, bytes));
  }

  get(assetId: string): RasterImage | undefined {
    return this.#images.get(assetId);
  }

  #decode(asset: ImageAsset, bytes: Uint8Array): RasterImage {
    const ck = this.#ck;
    const image = ck.MakeImageFromEncoded(bytes);
    if (image === null) throw new ImageAssetError(`asset '${asset.id}': the image does not decode`);
    try {
      const width = image.width();
      const height = image.height();
      if (width !== asset.width || height !== asset.height)
        throw new ImageAssetError(
          `asset '${asset.id}': decodes to ${width}×${height}, but the document says ${asset.width}×${asset.height}`,
        );
      const pixels = image.readPixels(0, 0, {
        width,
        height,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Premul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      if (!(pixels instanceof Uint8Array))
        throw new ImageAssetError(`asset '${asset.id}': CanvasKit returned no RGBA8 pixels`);
      return { width, height, pixels };
    } finally {
      image.delete();
    }
  }
}
