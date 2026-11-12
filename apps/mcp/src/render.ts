import {
  type CapturedFrame,
  type CapturedSheet,
  type CaptureSession,
  type ExportFrame,
  type ExportSession,
  launchCapture,
} from "@kynimo/capture";
import type { Project } from "@kynimo/scene";

export type { ExportFrame, ExportSession };

/** Declared limits of the render tools (ADR-0018); stated in their input schemas. */
export const RENDER_LIMITS = {
  /** Frames one `render_frames` call returns, each as an image in the result. */
  maxFrames: 16,
  /** Longest output edge of a frame. Larger compositions are downscaled, never cropped. */
  maxSize: 1920,
  minSize: 32,
  defaultSize: 960,
  /** Cells of one contact sheet. */
  minCells: 2,
  maxCells: 36,
  defaultCells: 12,
  maxColumns: 8,
  /** Longest edge of one cell. */
  maxCellSize: 640,
  defaultCellSize: 320,
  /** Longest edge of the whole sheet. */
  maxSheetSize: 2048,
  /** Transparent pixels between cells. */
  sheetGap: 4,
  /** Bytes of image and font assets one render may load (those its composition tree uses). */
  maxAssetBytes: 64 * 1024 * 1024,
  /** Decoded RGBA bytes (width × height × 4) of the images and video frames one render loads. */
  maxDecodedAssetBytes: 512 * 1024 * 1024,
} as const;

/** Asset bytes for one render: image and font assets by id, video frames by `videoFrameKey`. */
export interface RenderMedia {
  assets: ReadonlyMap<string, Uint8Array>;
  videoFrames: ReadonlyMap<string, Uint8Array>;
}

/** Draws documents. `@kynimo/capture` in production; tests use fakes. */
export interface FrameRenderer {
  /** Identifies everything that decides the pixels; part of every cache key. */
  build(): Promise<string>;
  frames(
    doc: Project,
    composition: string,
    frames: readonly number[],
    maxSize: number,
    media: RenderMedia,
  ): Promise<CapturedFrame[]>;
  sheet(
    doc: Project,
    composition: string,
    frames: readonly number[],
    layout: { maxSize: number; columns: number; gap: number },
    media: RenderMedia,
  ): Promise<CapturedSheet>;
  /**
   * Opens a fast export: the document is loaded once and frames come back as raw RGBA, one at a
   * time. "premultiplied" is the compositor's own pixels; "straight" is for formats that keep alpha.
   */
  openExport(
    doc: Project,
    composition: string,
    maxSize: number,
    assets: ReadonlyMap<string, Uint8Array>,
    alpha: "premultiplied" | "straight",
  ): Promise<ExportSession>;
  close(): Promise<void>;
}

/**
 * Renders with one `@kynimo/capture` session, launched on first use so a server that never
 * renders never starts Chromium. A session whose browser is gone (crash, kill) is replaced on the
 * next call.
 */
export class CaptureRenderer implements FrameRenderer {
  #session: Promise<CaptureSession> | undefined;
  #closed = false;

  constructor(private readonly launch: () => Promise<CaptureSession> = () => launchCapture()) {}

  /**
   * The live session, launching one when there is none. Concurrent callers share one launch:
   * after every wait the session promise is checked again, so a caller that finds it replaced
   * waits on the replacement instead of launching a second browser.
   */
  async #current(): Promise<CaptureSession> {
    for (;;) {
      if (this.#closed) throw new Error("the renderer is closed");
      const observed = this.#session;
      if (observed === undefined) return this.#relaunch();
      // Callers that waited on a launch that failed get its error; the next call retries.
      const existing = await observed;
      // close() sets #closed before it awaits, so no launch can start after it.
      if (this.#closed) throw new Error("the renderer is closed");
      if (this.#session !== observed) continue;
      if (!existing.closed) return existing;
      return this.#relaunch();
    }
  }

  #relaunch(): Promise<CaptureSession> {
    const next = this.launch();
    this.#session = next;
    // A failed launch is retried on the next call instead of being cached.
    next.catch(() => {
      if (this.#session === next) this.#session = undefined;
    });
    return next;
  }

  async build(): Promise<string> {
    return (await this.#current()).buildId;
  }

  async frames(
    doc: Project,
    composition: string,
    frames: readonly number[],
    maxSize: number,
    { assets, videoFrames }: RenderMedia,
  ) {
    return (await this.#current()).captureFrames(doc, frames, {
      composition,
      maxSize,
      assets,
      videoFrames,
    });
  }

  async sheet(
    doc: Project,
    composition: string,
    frames: readonly number[],
    layout: { maxSize: number; columns: number; gap: number },
    { assets, videoFrames }: RenderMedia,
  ) {
    return (await this.#current()).captureSheet(doc, frames, {
      composition,
      ...layout,
      assets,
      videoFrames,
    });
  }

  async openExport(
    doc: Project,
    composition: string,
    maxSize: number,
    assets: ReadonlyMap<string, Uint8Array>,
    alpha: "premultiplied" | "straight",
  ) {
    return (await this.#current()).openExport(doc, { composition, maxSize, assets, alpha });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const session = this.#session && (await this.#session.catch(() => undefined));
    this.#session = undefined;
    await session?.close();
  }
}

/**
 * Least-recently-used render results, bounded by bytes. Sound because worker rendering is
 * deterministic: the key holds everything that decides the pixels (ADR-0018).
 */
export class RenderCache<V> {
  readonly #entries = new Map<string, { value: V; bytes: number }>();
  #bytes = 0;

  constructor(readonly maxBytes: number) {}

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, bytes: number): void {
    const old = this.#entries.get(key);
    if (old !== undefined) {
      this.#bytes -= old.bytes;
      this.#entries.delete(key);
    }
    if (bytes > this.maxBytes) return;
    this.#entries.set(key, { value, bytes });
    this.#bytes += bytes;
    for (const [k, e] of this.#entries) {
      if (this.#bytes <= this.maxBytes) break;
      this.#entries.delete(k);
      this.#bytes -= e.bytes;
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }
}

export interface SkippedReport {
  layer: string;
  type: string;
  reason: string;
  /** The rendered frames it was left out of. */
  frames: number[];
}

export interface WarningReport {
  layer: string;
  kind: string;
  message: string;
  codepoints: number[];
  frames: number[];
}

/** Skipped layers and warnings across frames, each listed once with the frames it applies to. */
export function aggregateReports(
  frames: readonly {
    frame: number;
    skipped: CapturedFrame["skipped"];
    warnings: CapturedFrame["warnings"];
  }[],
): { skipped: SkippedReport[]; warnings: WarningReport[] } {
  const skipped = new Map<string, SkippedReport>();
  const warnings = new Map<string, WarningReport>();
  for (const f of frames) {
    for (const s of f.skipped) {
      const key = JSON.stringify([s.id, s.type, s.reason]);
      const entry = skipped.get(key) ?? { layer: s.id, type: s.type, reason: s.reason, frames: [] };
      if (!entry.frames.includes(f.frame)) entry.frames.push(f.frame);
      skipped.set(key, entry);
    }
    for (const w of f.warnings) {
      const key = JSON.stringify([w.id, w.kind, w.message]);
      const entry = warnings.get(key) ?? {
        layer: w.id,
        kind: w.kind,
        message: w.message,
        codepoints: w.codepoints,
        frames: [],
      };
      if (!entry.frames.includes(f.frame)) entry.frames.push(f.frame);
      warnings.set(key, entry);
    }
  }
  return { skipped: [...skipped.values()], warnings: [...warnings.values()] };
}

/**
 * `count` frames spread evenly from `from` to `to` inclusive (both ends included when count ≥ 2),
 * without duplicates when the range is shorter than the count.
 */
export function sampleFrames(from: number, to: number, count: number): number[] {
  if (count === 1 || from === to) return [from];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const f = Math.round(from + ((to - from) * i) / (count - 1));
    if (out[out.length - 1] !== f) out.push(f);
  }
  return out;
}
