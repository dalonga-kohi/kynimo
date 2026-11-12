import { type Asset, MAX_COMPOSITION_SIZE } from "@kynimo/scene";
import type { CanvasKit } from "canvaskit-wasm";
import { sha256Hex } from "./hash.js";
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
    const hash = await sha256Hex(bytes, (m) => new ImageAssetError(m));
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
    return decodeRaster(this.#ck, bytes, asset.width, asset.height, `asset '${asset.id}'`);
  }
}

/** Decodes with CanvasKit's codecs to premultiplied sRGB RGBA8, checking the declared size. */
function decodeRaster(
  ck: CanvasKit,
  bytes: Uint8Array,
  expectWidth: number,
  expectHeight: number,
  what: string,
): RasterImage {
  const image = ck.MakeImageFromEncoded(bytes);
  if (image === null) throw new ImageAssetError(`${what}: the image does not decode`);
  try {
    const width = image.width();
    const height = image.height();
    if (width !== expectWidth || height !== expectHeight)
      throw new ImageAssetError(
        `${what}: decodes to ${width}×${height}, but the document says ${expectWidth}×${expectHeight}`,
      );
    const pixels = image.readPixels(0, 0, {
      width,
      height,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Premul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (!(pixels instanceof Uint8Array))
      throw new ImageAssetError(`${what}: CanvasKit returned no RGBA8 pixels`);
    return { width, height, pixels };
  } finally {
    image.delete();
  }
}

export type VideoAsset = Extract<Asset, { type: "video" }>;

/**
 * Decoded frames of video assets, keyed by asset id and source frame. The host loads only the
 * frames a render shows and has already checked each against the asset's frame manifest
 * (ADR-0032); rendering then reads only from here.
 */
export class VideoFrameLibrary {
  readonly #ck: CanvasKit;
  readonly #frames = new Map<string, RasterImage>();

  constructor(ck: CanvasKit) {
    this.#ck = ck;
  }

  /** Decodes one frame (JPEG or PNG) and checks it has the asset's size. */
  add(asset: VideoAsset, frame: number, bytes: Uint8Array): void {
    const what = `video asset '${asset.id}' frame ${frame}`;
    if (!Number.isInteger(frame) || frame < 0 || frame >= asset.frameCount)
      throw new ImageAssetError(`${what}: the asset has frames 0 to ${asset.frameCount - 1}`);
    if (sniffImageFormat(bytes) === null)
      throw new ImageAssetError(`${what}: frames must be ${IMAGE_FORMATS.join(" or ")} files`);
    this.#frames.set(
      videoFrameKey(asset.id, frame),
      decodeRaster(this.#ck, bytes, asset.width, asset.height, what),
    );
  }

  /** Forgets one frame, so a long render holds only the frames it still shows. */
  delete(assetId: string, frame: number): void {
    this.#frames.delete(videoFrameKey(assetId, frame));
  }

  get(assetId: string, frame: number): RasterImage | undefined {
    return this.#frames.get(videoFrameKey(assetId, frame));
  }
}

/** How hosts and the capture page name one decoded video frame. */
export const videoFrameKey = (assetId: string, frame: number): string => `${assetId}/${frame}`;
