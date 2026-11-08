import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { BUNDLED_FONTS, type RenderWarning, type SkippedLayer } from "@kynimo/renderer";
import { migrateProject } from "@kynimo/scene";
import { type Browser, chromium, type Page, type Route } from "playwright";
import { ORIGIN, type PageApi, type PageRequest, type PageResponse } from "./protocol.js";

/**
 * Frames one call may request. Every PNG of a call crosses back in one response, so callers
 * (`render_frames`, workers) chunk longer ranges into several calls (ADR-0018: declared limits).
 */
export const MAX_FRAMES_PER_CALL = 64;

/** The worker launch flags (ADR-0016): WebGL2 on SwiftShader, never the host GPU. */
const CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] as const;

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
  return session(browser, gpu, build.digest("hex"), async (request, assets) => {
    serve(assets);
    try {
      // As a JSON string: Playwright's own serializer would walk (and type-check) the project.
      return await page.evaluate(
        (json) =>
          (globalThis as unknown as { KynimoCapture: PageApi }).KynimoCapture.render(
            JSON.parse(json),
          ),
        JSON.stringify(request),
      );
    } catch (error) {
      throw new CaptureError(`the capture page failed: ${message(error)}`);
    } finally {
      serve(new Map());
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

  let browser: Browser;
  try {
    browser = await chromium.launch({ args: [...CHROMIUM_ARGS] });
  } catch (error) {
    throw new CaptureError(`could not launch the pinned Chromium: ${message(error)}`);
  }
  try {
    // Service workers could answer requests without passing through the routes.
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", answer);
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const gpu = await page.evaluate(() =>
      (globalThis as unknown as { KynimoCapture: PageApi }).KynimoCapture.init(),
    );
    if (!/swiftshader/i.test(gpu))
      throw new CaptureError(
        `capture runs only on SwiftShader (ADR-0016), but WebGL2 reports '${gpu}'`,
      );
    return {
      browser,
      page,
      gpu,
      files,
      serve(next) {
        assets = next;
      },
    };
  } catch (error) {
    await browser.close();
    throw error instanceof CaptureError
      ? error
      : new CaptureError(`could not start the capture page: ${message(error)}`);
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function session(
  browser: Browser,
  gpu: string,
  buildId: string,
  render: (request: PageRequest, assets: ReadonlyMap<string, Uint8Array>) => Promise<PageResponse>,
): CaptureSession {
  let closed = false;
  browser.on("disconnected", () => {
    closed = true;
  });
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const call = (
    document: unknown,
    frames: readonly number[],
    { composition, assets = new Map(), maxSize }: CaptureOptions,
    sheet: PageRequest["sheet"],
  ) =>
    serialized(async () => {
      if (closed) throw new CaptureError("the capture session is closed");
      const migrated = migrateProject(document);
      if (!migrated.ok)
        throw new CaptureError(
          `the document is invalid: ${migrated.errors
            .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
            .join("; ")}`,
        );
      const project = migrated.doc;
      if (frames.length === 0 || frames.length > MAX_FRAMES_PER_CALL)
        throw new CaptureError(
          `frames must list 1 to ${MAX_FRAMES_PER_CALL} frames (got ${frames.length}); split longer ranges into several calls`,
        );
      if (maxSize !== undefined && (!Number.isInteger(maxSize) || maxSize < 1))
        throw new CaptureError(`maxSize must be a positive integer (got ${maxSize})`);
      if (sheet !== null) {
        if (!Number.isInteger(sheet.columns) || sheet.columns < 1)
          throw new CaptureError(`columns must be a positive integer (got ${sheet.columns})`);
        if (!Number.isInteger(sheet.gap) || sheet.gap < 0)
          throw new CaptureError(`gap must be a whole number of pixels (got ${sheet.gap})`);
      }
      for (const id of assets.keys()) {
        const asset = project.assets.find((a) => a.id === id);
        if (asset === undefined || (asset.type !== "image" && asset.type !== "font"))
          throw new CaptureError(`assets: '${id}' is not an image or font asset of the document`);
      }
      const response = await render(
        {
          project,
          compositionId: composition ?? project.mainCompositionId,
          frames: [...frames],
          assets: [...assets.keys()],
          maxSize: maxSize ?? null,
          sheet,
        },
        assets,
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
    async close() {
      closed = true;
      await browser.close();
    },
  };
}
