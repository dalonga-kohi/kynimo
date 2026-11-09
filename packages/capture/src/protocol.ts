import type { RenderWarning, SkippedLayer } from "@kynimo/renderer";
import type { Project } from "@kynimo/scene";

/**
 * The page's origin. The host answers every request to it from memory (page bundle, CanvasKit's
 * wasm, bundled fonts, asset bytes) and aborts every other request, so a capture never touches the
 * network. `.invalid` never resolves (RFC 6761); https makes the page a secure context, which Web
 * Crypto needs.
 */
export const ORIGIN = "https://capture.kynimo.invalid";

/** One `captureFrames` call, as the page receives it. The project has already passed `migrateProject`. */
export interface PageRequest {
  project: Project;
  compositionId: string;
  frames: number[];
  /** Ids of the image and font assets whose bytes the host serves at `/assets/<id>`. */
  assets: string[];
  /**
   * Decoded video frames the host serves at `/assets/<assetId>/<frame>` (`videoFrameKey`), already
   * checked against their frame manifests (ADR-0032). Only the frames this request shows.
   */
  videoFrames: string[];
  /** Longest output edge in pixels; larger frames are downscaled to it, smaller ones kept. */
  maxSize: number | null;
  /** Tile every frame into one image instead of returning them one by one. */
  sheet: { columns: number; gap: number } | null;
}

export interface PageFrame {
  frame: number;
  width: number;
  height: number;
  /** The PNG file, base64. */
  png: string;
  /** Lowercase hex SHA-256 of the composited premultiplied RGBA8 pixels, rows top to bottom. */
  pixelsSha256: string;
  skipped: SkippedLayer[];
  warnings: RenderWarning[];
}

/** A contact sheet: the frames tiled row-major, each cell exactly its frame's downscaled pixels. */
export interface PageSheet {
  width: number;
  height: number;
  png: string;
  pixelsSha256: string;
  cellWidth: number;
  cellHeight: number;
  frames: { frame: number; skipped: SkippedLayer[]; warnings: RenderWarning[] }[];
}

/** Errors cross as data so the host can keep their name (`RenderError`, `FontAssetError`, …). */
export type PageResponse =
  | { ok: true; frames: PageFrame[] }
  | { ok: true; sheet: PageSheet }
  | { ok: false; name: string; message: string };

/** What the page bundle defines as the global `KynimoCapture`. */
export interface PageApi {
  /** Loads CanvasKit, the bundled fonts and the compositor; returns `UNMASKED_RENDERER_WEBGL`. */
  init(): Promise<string>;
  render(request: PageRequest): Promise<PageResponse>;
}
