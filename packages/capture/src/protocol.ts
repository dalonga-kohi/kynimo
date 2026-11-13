import type { RenderComponentDefinition } from "@kynimo/components";
import type { RenderWarning, SkippedLayer } from "@kynimo/renderer";
import type { Project, ShaderDefinition } from "@kynimo/scene";

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
  shaders: readonly ShaderDefinition[];
  components: readonly RenderComponentDefinition[];
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

/** `openExport`: the document and assets of one export; the host serves the bytes at `/assets/<id>`. */
export interface ExportRequest {
  project: Project;
  shaders: readonly ShaderDefinition[];
  components: readonly RenderComponentDefinition[];
  compositionId: string;
  assets: string[];
  maxSize: number | null;
  alpha: "premultiplied" | "straight";
}

/** One export frame as the page returns it; the pixels follow through `exportSlice`. */
export interface ExportFrameHeader {
  frame: number;
  width: number;
  height: number;
  repeated: boolean;
  /** Bytes of RGBA to read with `exportSlice`; 0 when `repeated`. */
  bytes: number;
  skipped: SkippedLayer[];
  warnings: RenderWarning[];
}

/** Milliseconds the page spent per stage, summed over `frames` export frames. */
export interface PageTimings {
  frames: number;
  /** Frames not drawn because they equal the previous one. */
  repeated: number;
  /** Evaluation and the repeat check. */
  evaluateMs: number;
  /** CanvasKit rasterization of the layers. */
  rasterMs: number;
  /** The WebGL2 compositor, including the readback. */
  compositeMs: number;
  downscaleMs: number;
  /** Preparing the pixels to cross to the host. */
  transferMs: number;
  /** Frames that reused the kept result of their unchanged bottom layers. */
  reused: number;
}

type PageError = { ok: false; name: string; message: string };

/** What the page bundle defines as the global `KynimoCapture`. */
export interface PageApi {
  /** Loads CanvasKit, the bundled fonts and the compositor; returns `UNMASKED_RENDERER_WEBGL`. */
  init(): Promise<string>;
  render(request: PageRequest): Promise<PageResponse>;
  /** Opens the page's one export (replacing any earlier one). */
  openExport(request: ExportRequest): Promise<{ ok: true } | PageError>;
  /** Draws one frame of the open export. `videoFrameKeys` is every video frame it shows. */
  exportFrame(
    frame: number,
    videoFrameKeys: string[],
  ): Promise<ExportFrameHeader | PageError>;
  /** Bytes `start` to `end` of the frame drawn last, base64. */
  exportSlice(start: number, end: number): string;
  closeExport(): void;
  /** Stage timings since the previous call. */
  takeTimings(): PageTimings;
}
