import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { RenderComponentDefinition } from "@kynimo/components";
import {
  BUNDLED_FONTS,
  type RenderWarning,
  type SkippedLayer,
  videoFrameKey,
} from "@kynimo/renderer";
import { migrateProject, type Project, type ShaderDefinition } from "@kynimo/scene";
import { type Browser, chromium, type Page, type Route } from "playwright";
import {
  type ExportRequest,
  ORIGIN,
  type PageApi,
  type PageRequest,
  type PageResponse,
  type PageTimings,
} from "./protocol.js";
import { fitSize } from "./size.js";

/**
 * Frames one call may request. Every PNG of a call crosses back in one response, so callers
 * (`render_frames`, workers) chunk longer ranges into several calls (ADR-0018: declared limits).
 */
export const MAX_FRAMES_PER_CALL = 64;

/**
 * Bytes of one export frame per protocol message. One message holding a whole 1080p frame takes
 * about 130 ms to cross; in slices of this size the same bytes take about 70 ms.
 */
const EXPORT_SLICE_BYTES = 192 * 1024;

/** The worker launch flags (ADR-0016): WebGL2 on SwiftShader, never the host GPU. */
export const CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] as const;

export class CaptureError extends Error {
  override name = "CaptureError";
  /** The page-side error's name (`RenderError`, `FontAssetError`, `RangeError`, …), if it came from there. */
  readonly pageError: string | null;

  constructor(message: string, pageError: string | null = null) {
    super(message);
    this.pageError = pageError;
  }
}

export interface CapturedFrame {
  frame: number;
  width: number;
  height: number;
  /** The frame as a PNG file (straight-alpha sRGB RGBA8), encoded by the pinned CanvasKit. */
  png: Uint8Array;
  /**
   * Lowercase hex SHA-256 of the composited premultiplied sRGB RGBA8 pixels, rows top to bottom.
   * The determinism invariant is stated on these bytes: same document + frame → same hash.
   */
  pixelsSha256: string;
  /** Lowercase hex SHA-256 of `png`. Also fixed by the pins, but changes with the encoder. */
  pngSha256: string;
  /** Layers left out because the renderer cannot draw them yet; nothing is dropped silently (ADR-0018). */
  skipped: SkippedLayer[];
  /** Content drawn other than the document asks (font fallback, missing glyphs). */
  warnings: RenderWarning[];
}

export interface CaptureOptions {
  /** The composition to render; the project's main composition by default. */
  composition?: string;
  /** Project definitions pinned by shader layers and effects in this document. */
  shaders?: readonly ShaderDefinition[];
  /** Project definitions needed to evaluate the document's component instances. */
  components?: readonly RenderComponentDefinition[];
  /**
   * The longest output edge in pixels. Larger frames are composited at full size, then
   * downscaled on the CPU with the pinned CanvasKit (trilinear), keeping the aspect ratio
   * ({@link fitSize}); smaller ones are returned as they are. Hashes are of the output pixels.
   */
  maxSize?: number;
  /**
   * Bytes of the document's image and font assets, by asset id. Each is checked against the
   * document's pin. Loading them (the asset store, M3) is the caller's job: capture never fetches.
   */
  assets?: ReadonlyMap<string, Uint8Array>;
  /**
   * Bytes of video frames by `videoFrameKey(assetId, frame)`, JPEG or PNG. The caller checks them
   * against the asset's frame manifest; capture checks each decodes to the asset's size.
   */
  videoFrames?: ReadonlyMap<string, Uint8Array>;
}

export interface SheetOptions extends CaptureOptions {
  /** Cells per row; the sheet has as many rows as the frames need. */
  columns: number;
  /** Transparent pixels between cells. Default 0. */
  gap?: number;
}

/** Frames tiled row-major into one PNG; each cell holds exactly that frame's output pixels. */
export interface CapturedSheet {
  width: number;
  height: number;
  png: Uint8Array;
  pixelsSha256: string;
  pngSha256: string;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  /** Per cell, in order: the frame and what it skipped or drew differently. */
  frames: { frame: number; skipped: SkippedLayer[]; warnings: RenderWarning[] }[];
}

export interface ExportOptions {
  /** The composition to export; the project's main composition by default. */
  composition?: string;
  /** Project definitions pinned by shader layers and effects in this document. */
  shaders?: readonly ShaderDefinition[];
  /** Project definitions needed to evaluate the document's component instances. */
  components?: readonly RenderComponentDefinition[];
  /** As {@link CaptureOptions.maxSize}. */
  maxSize?: number;
  /** Image and font bytes by asset id, as for captureFrames; checked against pins. */
  assets?: ReadonlyMap<string, Uint8Array>;
  /**
   * "premultiplied": the compositor's premultiplied RGBA (= over black when alpha is ignored).
   * "straight": un-premultiplied, for formats that keep alpha.
   */
  alpha: "premultiplied" | "straight";
}

export interface ExportFrame {
  frame: number;
  width: number;
  height: number;
  /** width*height*4 bytes, rows top to bottom. When `repeated`, the same Uint8Array object as the previous call's. */
  rgba: Uint8Array;
  /** True when the evaluated frame equals the previous frame's, so it was not drawn again. */
  repeated: boolean;
  skipped: SkippedLayer[];
  warnings: RenderWarning[];
}

/** One export in its own page: the document is loaded once and frames come back as raw RGBA. */
export interface ExportSession {
  /** Output size (`fitSize` of the composition). */
  readonly width: number;
  readonly height: number;
  /** True once closed, or once the browser is gone. */
  readonly closed: boolean;
  /**
   * Renders composition frame `frame`. `videoFrames` must hold every video frame this frame shows
   * (same keys as captureFrames); frames not passed since the previous call are released in the
   * page. Calls run one at a time. Throws {@link CaptureError}.
   */
  frame(frame: number, videoFrames?: ReadonlyMap<string, Uint8Array>): Promise<ExportFrame>;
  /** Milliseconds the page spent per stage since the previous call (or since the export opened). */
  timings(): Promise<PageTimings>;
  close(): Promise<void>;
}

export interface CaptureSession {
  /** The Chromium version, e.g. `153.0.8010.12`. Record it with what the session renders (ADR-0016). */
  readonly browserVersion: string;
  /** `UNMASKED_RENDERER_WEBGL`; always a SwiftShader renderer. */
  readonly gpu: string;
  /**
   * Identifies everything that decides the pixels: the page bundle, CanvasKit's wasm, the bundled
   * fonts, the Chromium version and the GPU string (hex SHA-256). Render caches key on it (ADR-0018).
   */
  readonly buildId: string;
  /** True once closed, or once the browser is gone; a closed session stays closed. */
  readonly closed: boolean;
  /**
   * Renders `frames` (at most {@link MAX_FRAMES_PER_CALL}) of a document to PNG. The document is
   * migrated and validated first. Calls on one session run one at a time. Throws
   * {@link CaptureError}, also once the browser is gone: a closed or crashed session stays closed.
   */
  captureFrames(
    document: unknown,
    frames: readonly number[],
    options?: CaptureOptions,
  ): Promise<CapturedFrame[]>;
  /** Renders `frames` (at most {@link MAX_FRAMES_PER_CALL}) into one contact sheet PNG. */
  captureSheet(
    document: unknown,
    frames: readonly number[],
    options: SheetOptions,
  ): Promise<CapturedSheet>;
  /**
   * Opens an export in a new page of the same browser. It does not wait for `captureFrames`
   * calls, nor do they wait for it. Closing the session closes its exports.
   */
  openExport(document: unknown, options: ExportOptions): Promise<ExportSession>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** The page bundle's source. Defaults to the one built into `dist/page/capture.js`. */
  pageScript?: string;
}

const require = createRequire(import.meta.url);

async function staticFiles(pageScript: string | undefined): Promise<Map<string, StaticFile>> {
  const files = new Map<string, StaticFile>();
  files.set("/", {
    type: "text/html",
    body: '<!doctype html><meta charset="utf-8"><title>capture</title><script src="/capture.js"></script>',
  });
  files.set("/capture.js", {
    type: "text/javascript",
    body: pageScript ?? (await readFile(new URL("./page/capture.js", import.meta.url), "utf8")),
  });
  const canvaskit = dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
  files.set("/canvaskit/canvaskit.wasm", {
    type: "application/wasm",
    body: await readFile(join(canvaskit, "canvaskit.wasm")),
  });
  for (const font of BUNDLED_FONTS)
    files.set(`/fonts/${font.file}`, {
      type: "font/ttf",
      body: await readFile(require.resolve(`@kynimo/renderer/fonts/${font.file}`)),
    });
  return files;
}

interface StaticFile {
  type: string;
  body: string | Buffer;
}

const COMPONENT_FRAME_DEADLINE_MS = 30_000;

/** Bounds browser work even when a native rendering call cannot be interrupted inside the page. */
async function componentDeadline<T>(
  pending: Promise<T>,
  frames: number,
  stop: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void stop().catch(() => undefined);
          reject(new CaptureError("the component render worker exceeded its deadline"));
        }, frames * COMPONENT_FRAME_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Launches the pinned Chromium (Playwright's) on SwiftShader with the capture page loaded, and
 * refuses to run on any other GPU (ADR-0016). One session renders any number of documents; close
 * it when done.
 */
export async function launchCapture(options: LaunchOptions = {}): Promise<CaptureSession> {
  const { browser, page, gpu, serve, files } = await openCapturePage(options);
  const build = createHash("sha256");
  for (const [path, file] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    build.update(`${path}\0`).update(createHash("sha256").update(file.body).digest("hex"));
  build.update(`\0${browser.version()}\0${gpu}`);
  const open = () => newCapturePage(browser, files);
  let active: Pick<Awaited<ReturnType<typeof open>>, "page" | "serve"> | undefined = {
    page,
    serve,
  };
  return session(browser, gpu, build.digest("hex"), open, async (request, assets) => {
    active ??= await open();
    const current = active;
    current.serve(assets);
    try {
      // As a JSON string: Playwright's own serializer would walk (and type-check) the project.
      const pending = current.page.evaluate(
        (json) =>
          (globalThis as unknown as { KynimoCapture: PageApi }).KynimoCapture.render(
            JSON.parse(json),
          ),
        JSON.stringify(request),
      );
      return await (request.components.length === 0
        ? pending
        : componentDeadline(pending, request.frames.length, () => {
            active = undefined;
            return current.page.context().close();
          }));
    } catch (error) {
      throw new CaptureError(`the capture page failed: ${message(error)}`);
    } finally {
      current.serve(new Map());
    }
  });
}

/**
 * @internal The browser with the capture page loaded and initialized. The page reaches only
 * {@link ORIGIN}, answered from memory: other HTTP(S) requests are aborted, WebSockets closed and
 * service workers blocked. `serve` sets the asset bytes answered at `/assets/<id>`.
 */
export async function openCapturePage({ pageScript }: LaunchOptions = {}): Promise<{
  browser: Browser;
  page: Page;
  gpu: string;
  serve(assets: ReadonlyMap<string, Uint8Array>): void;
  files: ReadonlyMap<string, StaticFile>;
}> {
  const files = await staticFiles(pageScript);
  let browser: Browser;
  try {
    browser = await chromium.launch({
      args: process.env.KYNIMO_BENCH_GPU_ARGS?.split(" ") ?? [...CHROMIUM_ARGS],
    });
  } catch (error) {
    throw new CaptureError(`could not launch the pinned Chromium: ${message(error)}`);
  }
  try {
    const { page, gpu, serve } = await newCapturePage(browser, files);
    return { browser, page, gpu, files, serve };
  } catch (error) {
    await browser.close();
    throw error instanceof CaptureError
      ? error
      : new CaptureError(`could not start the capture page: ${message(error)}`);
  }
}

/** A fresh isolated page in `browser`, loaded and initialized, answering from `files` and its own assets. */
async function newCapturePage(
  browser: Browser,
  files: ReadonlyMap<string, StaticFile>,
): Promise<{ page: Page; gpu: string; serve(assets: ReadonlyMap<string, Uint8Array>): void }> {
  let assets: ReadonlyMap<string, Uint8Array> = new Map();

  const answer = (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
    const file = files.get(url.pathname);
    if (file !== undefined)
      return route.fulfill({ status: 200, contentType: file.type, body: file.body });
    const bytes = url.pathname.startsWith("/assets/")
      ? assets.get(decodePath(url.pathname.slice("/assets/".length)))
      : undefined;
    if (bytes !== undefined)
      return route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: Buffer.from(bytes),
      });
    return route.fulfill({ status: 404, body: "" });
  };

  // Service workers could answer requests without passing through the routes.
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await context.route("**/*", answer);
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const gpu = await page.evaluate(() =>
      (globalThis as unknown as { KynimoCapture: PageApi }).KynimoCapture.init(),
    );
    if (!/swiftshader/i.test(gpu) && process.env.KYNIMO_BENCH_GPU_ARGS === undefined)
      throw new CaptureError(
        `capture runs only on SwiftShader (ADR-0016), but WebGL2 reports '${gpu}'`,
      );
    return {
      page,
      gpu,
      serve(next) {
        assets = next;
      },
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

/** A path segment decoded, or `""` (never an asset id) when it is malformed. */
function decodePath(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

function checkDocument(document: unknown) {
  const migrated = migrateProject(document);
  if (!migrated.ok)
    throw new CaptureError(
      `the document is invalid: ${migrated.errors
        .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
        .join("; ")}`,
    );
  return migrated.doc;
}

function checkMaxSize(maxSize: number | undefined) {
  if (maxSize !== undefined && (!Number.isInteger(maxSize) || maxSize < 1))
    throw new CaptureError(`maxSize must be a positive integer (got ${maxSize})`);
}

function checkAssets(project: Project, assets: ReadonlyMap<string, Uint8Array>) {
  for (const id of assets.keys()) {
    const asset = project.assets.find((a) => a.id === id);
    if (asset === undefined || (asset.type !== "image" && asset.type !== "font"))
      throw new CaptureError(`assets: '${id}' is not an image or font asset of the document`);
  }
}

function checkVideoFrames(project: Project, videoFrames: ReadonlyMap<string, Uint8Array>) {
  for (const key of videoFrames.keys()) {
    const [id, n] = key.split("/");
    const asset = project.assets.find((a) => a.id === id);
    if (asset?.type !== "video" || key !== videoFrameKey(asset.id, Number(n)))
      throw new CaptureError(`videoFrames: '${key}' does not name a frame of a video asset`);
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function session(
  browser: Browser,
  gpu: string,
  buildId: string,
  openPage: () => ReturnType<typeof newCapturePage>,
  render: (request: PageRequest, assets: ReadonlyMap<string, Uint8Array>) => Promise<PageResponse>,
): CaptureSession {
  let closed = false;
  browser.on("disconnected", () => {
    closed = true;
  });
  const exports = new Set<ExportSession>();
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const call = (
    document: unknown,
    frames: readonly number[],
    {
      composition,
      assets = new Map(),
      videoFrames = new Map(),
      maxSize,
      shaders = [],
      components = [],
    }: CaptureOptions,
    sheet: PageRequest["sheet"],
  ) =>
    serialized(async () => {
      if (closed) throw new CaptureError("the capture session is closed");
      const project = checkDocument(document);
      if (frames.length === 0 || frames.length > MAX_FRAMES_PER_CALL)
        throw new CaptureError(
          `frames must list 1 to ${MAX_FRAMES_PER_CALL} frames (got ${frames.length}); split longer ranges into several calls`,
        );
      checkMaxSize(maxSize);
      if (sheet !== null) {
        if (!Number.isInteger(sheet.columns) || sheet.columns < 1)
          throw new CaptureError(`columns must be a positive integer (got ${sheet.columns})`);
        if (!Number.isInteger(sheet.gap) || sheet.gap < 0)
          throw new CaptureError(`gap must be a whole number of pixels (got ${sheet.gap})`);
      }
      checkAssets(project, assets);
      checkVideoFrames(project, videoFrames);
      const response = await render(
        {
          project,
          shaders,
          components,
          compositionId: composition ?? project.mainCompositionId,
          frames: [...frames],
          assets: [...assets.keys()],
          videoFrames: [...videoFrames.keys()],
          maxSize: maxSize ?? null,
          sheet,
        },
        new Map([...assets, ...videoFrames]),
      );
      if (!response.ok) throw new CaptureError(response.message, response.name);
      return response;
    });

  const png = (base64: string) => {
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    return { png: bytes, pngSha256: createHash("sha256").update(bytes).digest("hex") };
  };

  return {
    browserVersion: browser.version(),
    gpu,
    buildId,
    get closed() {
      return closed;
    },
    async captureFrames(document, frames, options = {}) {
      const response = await call(document, frames, options, null);
      if (!("frames" in response)) throw new CaptureError("the capture page returned a sheet");
      return response.frames.map((f) => ({ ...f, ...png(f.png) }));
    },
    async captureSheet(document, frames, { columns, gap = 0, ...options }) {
      const response = await call(document, frames, options, { columns, gap });
      if (!("sheet" in response)) throw new CaptureError("the capture page returned frames");
      const { sheet } = response;
      return { ...sheet, ...png(sheet.png), columns: Math.min(columns, frames.length) };
    },
    async openExport(
      document,
      { composition, maxSize, assets = new Map(), alpha, shaders = [], components = [] },
    ) {
      if (closed) throw new CaptureError("the capture session is closed");
      const project = checkDocument(document);
      checkMaxSize(maxSize);
      checkAssets(project, assets);
      if (alpha !== "premultiplied" && alpha !== "straight")
        throw new CaptureError(`alpha must be 'premultiplied' or 'straight' (got ${alpha})`);
      const compositionId = composition ?? project.mainCompositionId;
      if (!project.compositions.some((c) => c.id === compositionId))
        throw new CaptureError(
          `unknown composition '${compositionId}'; use one of: ${project.compositions.map((c) => c.id).join(", ")}`,
        );
      const exported = await openExportPage(
        openPage,
        {
          project,
          shaders,
          components,
          compositionId,
          assets: [...assets.keys()],
          maxSize: maxSize ?? null,
          alpha,
        },
        assets,
        project,
        () => closed,
      );
      exports.add(exported);
      void exported.closing.then(() => exports.delete(exported));
      return exported;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...exports].map((e) => e.close()));
      await browser.close();
    },
  };
}

type ExportHandle = ExportSession & { closing: Promise<void> };

/** Opens the export page and wraps it; the page's calls are serialized among themselves. */
async function openExportPage(
  openPage: () => ReturnType<typeof newCapturePage>,
  request: ExportRequest,
  assets: ReadonlyMap<string, Uint8Array>,
  project: Project,
  browserGone: () => boolean,
): Promise<ExportHandle> {
  const comp = project.compositions.find((c) => c.id === request.compositionId);
  const size = fitSize(comp?.width ?? 1, comp?.height ?? 1, request.maxSize);
  let opened: Awaited<ReturnType<typeof openPage>>;
  try {
    opened = await openPage();
  } catch (error) {
    throw error instanceof CaptureError
      ? error
      : new CaptureError(`could not start the capture page: ${message(error)}`);
  }
  const { page } = opened;
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const pending = fn();
      return await (request.components.length === 0
        ? pending
        : componentDeadline(pending, 1, () => page.context().close()));
    } catch (error) {
      throw new CaptureError(`the capture page failed: ${message(error)}`);
    }
  };
  // The asset route reads this map: provided assets for good, video frames per call.
  const served = new Map<string, Uint8Array>(assets);
  opened.serve(served);
  let pageClosed = false;
  let release!: () => void;
  const closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  page.on("close", () => {
    pageClosed = true;
    release();
  });
  page.on("crash", () => {
    pageClosed = true;
  });
  const isClosed = () => pageClosed || browserGone();
  const shutdown = async () => {
    pageClosed = true;
    await page
      .evaluate(() =>
        (globalThis as unknown as { KynimoCapture: PageApi }).KynimoCapture.closeExport(),
      )
      .catch(() => undefined);
    await page
      .context()
      .close()
      .catch(() => undefined);
    release();
  };

  const opening = await call(() =>
    page.evaluate(
      (json) =>
        (globalThis as unknown as { KynimoCapture: PageApi }).KynimoCapture.openExport(
          JSON.parse(json),
        ),
      JSON.stringify(request),
    ),
  ).catch(async (error: unknown) => {
    await shutdown();
    throw error;
  });
  if (!opening.ok) {
    await shutdown();
    throw new CaptureError(opening.message, opening.name);
  }

  let queue: Promise<unknown> = Promise.resolve();
  let previousKeys = new Set<string>();
  let previous: Uint8Array | undefined;
  const frame = (n: number, videoFrames: ReadonlyMap<string, Uint8Array> = new Map()) => {
    const task = async (): Promise<ExportFrame> => {
      if (isClosed()) throw new CaptureError("the export is closed");
      checkVideoFrames(project, videoFrames);
      for (const key of previousKeys) if (!videoFrames.has(key)) served.delete(key);
      for (const [key, bytes] of videoFrames) served.set(key, bytes);
      previousKeys = new Set(videoFrames.keys());
      const response = await call(() =>
        page.evaluate(
          ([frameNumber, keys]) =>
            (globalThis as unknown as { KynimoCapture: PageApi }).KynimoCapture.exportFrame(
              frameNumber as number,
              keys as string[],
            ),
          [n, [...videoFrames.keys()]] as const,
        ),
      );
      if ("ok" in response) throw new CaptureError(response.message, response.name);
      const { bytes, ...header } = response;
      let rgba: Uint8Array;
      if (header.repeated) {
        if (previous === undefined)
          throw new CaptureError("the capture page repeated a frame it never drew");
        rgba = previous;
      } else {
        if (bytes !== header.width * header.height * 4)
          throw new CaptureError(
            `the capture page returned ${bytes} bytes for a ${header.width}×${header.height} frame`,
          );
        // Read as slices, all requested at once: they are answered in order on the one connection.
        const out = Buffer.allocUnsafe(bytes);
        const slices: Promise<number>[] = [];
        for (let start = 0; start < bytes; start += EXPORT_SLICE_BYTES) {
          const end = Math.min(bytes, start + EXPORT_SLICE_BYTES);
          slices.push(
            page
              .evaluate(
                ([a, b]) =>
                  (globalThis as unknown as { KynimoCapture: PageApi }).KynimoCapture.exportSlice(
                    a as number,
                    b as number,
                  ),
                [start, end] as const,
              )
              .then((base64) => out.write(base64, start, end - start, "base64") - (end - start)),
          );
        }
        const short = await call(() => Promise.all(slices));
        if (short.some((n) => n !== 0))
          throw new CaptureError(`the capture page returned a short frame ${n}`);
        rgba = new Uint8Array(out.buffer, out.byteOffset, bytes);
        previous = rgba;
      }
      return { ...header, rgba };
    };
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    width: size.width,
    height: size.height,
    get closed() {
      return isClosed();
    },
    frame,
    timings() {
      const task = () =>
        call(() =>
          page.evaluate(() =>
            (globalThis as unknown as { KynimoCapture: PageApi }).KynimoCapture.takeTimings(),
          ),
        );
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    },
    closing,
    async close() {
      await shutdown();
    },
  };
}
