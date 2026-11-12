/**
 * The capture page (browser only). Vite bundles it into `dist/page/capture.js`, which the host
 * loads into the pinned Chromium. The whole pipeline runs here, on the path ADR-0016 guarantees:
 * evaluate → CanvasKit raster → WebGL2 compositor → PNG.
 */
import { createComponentHost } from "@kynimo/components";
import { evaluateFrame } from "@kynimo/engine";
import {
  BUNDLED_FONTS,
  type CanvasKit,
  type Compositor,
  createCompositor,
  FontLibrary,
  type FramePlan,
  ImageLibrary,
  loadCanvasKit,
  type RenderWarning,
  rasterizeFrame,
  type SkippedLayer,
  VideoFrameLibrary,
} from "@kynimo/renderer";
import type { Canvas } from "canvaskit-wasm";
import {
  type ExportFrameHeader,
  type ExportRequest,
  ORIGIN,
  type PageFrame,
  type PageRequest,
  type PageResponse,
  type PageSheet,
} from "./protocol.js";
import { fitSize, sheetSize } from "./size.js";

let state: { ck: CanvasKit; compositor: Compositor; bundled: Uint8Array[] } | undefined;

async function fetchBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(`${ORIGIN}/${path}`);
  if (!response.ok) throw new Error(`capture page: ${path} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function init(): Promise<string> {
  const ck = await loadCanvasKit({ locateFile: (file) => `${ORIGIN}/canvaskit/${file}` });
  const gl = document.createElement("canvas").getContext("webgl2", { antialias: false });
  if (gl === null) throw new Error("capture page: WebGL2 is unavailable");
  const compositor = createCompositor(gl);
  const bundled = await Promise.all(BUNDLED_FONTS.map((f) => fetchBytes(`fonts/${f.file}`)));
  state = { ck, compositor, bundled };
  return compositor.renderer;
}

export async function render(request: PageRequest): Promise<PageResponse> {
  try {
    const frames = await renderFrames(request);
    if (request.sheet !== null) return { ok: true, sheet: await tile(frames, request.sheet) };
    const out: PageFrame[] = [];
    for (const { frame, width, height, pixels, skipped, warnings } of frames)
      out.push({
        frame,
        width,
        height,
        png: toBase64(encodePng(ck(), width, height, pixels)),
        pixelsSha256: await sha256(pixels),
        skipped,
        warnings,
      });
    return { ok: true, frames: out };
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    return { ok: false, name: e.name, message: e.message };
  }
}

const ck = (): CanvasKit => {
  if (state === undefined) throw new Error("capture page: init() has not run");
  return state.ck;
};

/** One composited frame at its output size, premultiplied sRGB RGBA8. */
interface Pixels {
  frame: number;
  width: number;
  height: number;
  pixels: Uint8Array;
  skipped: SkippedLayer[];
  warnings: RenderWarning[];
}

async function renderFrames({
  project,
  compositionId,
  frames,
  assets,
  videoFrames,
  maxSize,
}: PageRequest): Promise<Pixels[]> {
  if (state === undefined) throw new Error("capture page: init() has not run");
  const { ck, compositor, bundled } = state;
  const provided = new Set(assets);
  const images = new ImageLibrary(ck);
  const fonts = new FontLibrary(ck);
  const videos = new VideoFrameLibrary(ck);
  try {
    for (const [i, font] of BUNDLED_FONTS.entries())
      await fonts.addBundled(font.family, bundled[i] as Uint8Array);
    for (const asset of project.assets) {
      if (!provided.has(asset.id)) continue;
      const bytes = await fetchBytes(`assets/${encodeURIComponent(asset.id)}`);
      if (asset.type === "image") await images.add(asset, bytes);
      else if (asset.type === "font") await fonts.add(asset, bytes);
    }
    for (const key of videoFrames) {
      const slash = key.lastIndexOf("/");
      const asset = project.assets.find((a) => a.id === key.slice(0, slash));
      if (asset?.type !== "video") throw new Error(`capture page: '${key}' is not a video frame`);
      videos.add(
        asset,
        Number(key.slice(slash + 1)),
        await fetchBytes(`assets/${encodeURIComponent(key)}`),
      );
    }
    const out: Pixels[] = [];
    const components = createComponentHost(project);
    for (const frame of frames)
      out.push(
        drawFrame(ck, compositor, project, compositionId, frame, maxSize, components, {
          images,
          fonts,
          videos,
        }),
      );
    return out;
  } finally {
    fonts.delete();
  }
}

type Components = ReturnType<typeof createComponentHost>;

/** Evaluates, rasterizes, composites and downscales one frame; shared by `render` and exports. */
function drawFrame(
  ck: CanvasKit,
  compositor: Compositor,
  project: PageRequest["project"],
  compositionId: string,
  frame: number,
  maxSize: number | null,
  components: Components,
  libraries: { images: ImageLibrary; fonts: FontLibrary; videos: VideoFrameLibrary },
  evaluated = evaluateFrame(project, frame, compositionId, { components }),
): Pixels {
  const plan = rasterizeFrame(ck, evaluated, libraries);
  const full = compositor.composite(plan);
  const size = fitSize(full.width, full.height, maxSize);
  return { frame, ...size, pixels: downscale(ck, full, size), ...reports(plan) };
}

const videoAssetOf = (project: PageRequest["project"], key: string) => {
  const slash = key.lastIndexOf("/");
  const asset = project.assets.find((a) => a.id === key.slice(0, slash));
  if (asset?.type !== "video") throw new Error(`capture page: '${key}' is not a video frame`);
  return { asset, frame: Number(key.slice(slash + 1)) };
};

interface ExportState {
  project: PageRequest["project"];
  compositionId: string;
  maxSize: number | null;
  alpha: ExportRequest["alpha"];
  components: Components;
  images: ImageLibrary;
  fonts: FontLibrary;
  videos: VideoFrameLibrary;
  loaded: Set<string>;
  previousKey: string | undefined;
  previous: { width: number; height: number; skipped: SkippedLayer[]; warnings: RenderWarning[] };
}

/** One export per page. */
let exporting: ExportState | undefined;

/** Loads the document's assets once; `exportFrame` then draws frames one at a time. */
export async function openExport(request: ExportRequest): Promise<{ ok: true } | ErrorResponse> {
  try {
    if (state === undefined) throw new Error("capture page: init() has not run");
    closeExport();
    const { ck, bundled } = state;
    const { project } = request;
    const provided = new Set(request.assets);
    const images = new ImageLibrary(ck);
    const fonts = new FontLibrary(ck);
    const videos = new VideoFrameLibrary(ck);
    try {
      for (const [i, font] of BUNDLED_FONTS.entries())
        await fonts.addBundled(font.family, bundled[i] as Uint8Array);
      for (const asset of project.assets) {
        if (!provided.has(asset.id)) continue;
        const bytes = await fetchBytes(`assets/${encodeURIComponent(asset.id)}`);
        if (asset.type === "image") await images.add(asset, bytes);
        else if (asset.type === "font") await fonts.add(asset, bytes);
      }
    } catch (error) {
      fonts.delete();
      throw error;
    }
    exporting = {
      project,
      compositionId: request.compositionId,
      maxSize: request.maxSize,
      alpha: request.alpha,
      components: createComponentHost(project),
      images,
      fonts,
      videos,
      loaded: new Set(),
      previousKey: undefined,
      previous: { width: 0, height: 0, skipped: [], warnings: [] },
    };
    return { ok: true };
  } catch (error) {
    return errorResponse(error);
  }
}

/** Frees the export's libraries. */
export function closeExport(): void {
  exporting?.fonts.delete();
  exporting = undefined;
}

/**
 * JSON replacer for the repeat check: reduces a numeric `layerFrame`, which the renderer reads
 * only as "has the layer started" (`>= 0`), to that boolean. Drops nothing else: a resolved
 * effect's own `frame` (animated grain) decides pixels and must stay in the key.
 */
function frameIndependent(key: string, value: unknown): unknown {
  if (key === "layerFrame" && typeof value === "number") return value >= 0;
  return value;
}

/**
 * One export frame. `videoFrameKeys` lists every video frame the frame shows. When the evaluated
 * frame equals the previous one the pixels are not drawn again and `repeated` is true.
 */
export async function exportFrame(
  frame: number,
  videoFrameKeys: string[],
): Promise<(ExportFrameHeader & { rgba: string | null }) | ErrorResponse> {
  try {
    const e = exporting;
    if (e === undefined || state === undefined) throw new Error("capture page: no export is open");
    const { ck, compositor } = state;
    const wanted = new Set(videoFrameKeys);
    for (const key of e.loaded)
      if (!wanted.has(key)) {
        const { asset, frame: n } = videoAssetOf(e.project, key);
        e.videos.delete(asset.id, n);
        e.loaded.delete(key);
      }
    for (const key of wanted) {
      if (e.loaded.has(key)) continue;
      const { asset, frame: n } = videoAssetOf(e.project, key);
      e.videos.add(asset, n, await fetchBytes(`assets/${encodeURIComponent(key)}`));
      e.loaded.add(key);
    }
    const evaluated = evaluateFrame(e.project, frame, e.compositionId, {
      components: e.components,
    });
    // Sound because the evaluated frame carries everything that decides the pixels: effects,
    // grain, generators and video source frames are all resolved into it, and rendering reads
    // nothing else that changes between frames (the libraries only gain the frames it names).
    // It is plain data (numbers, strings, arrays, objects); a non-finite number serializes as
    // null, which cannot make two different frames look equal in practice. Only the frame
    // root frame index and the sign of `layerFrame` differ by definition and are neutralized; every
    // nested `frame` (grain, precomps) stays, which can only miss a dedupe, never repeat wrong pixels.
    const key = JSON.stringify({ ...evaluated, frame: 0 }, frameIndependent);
    if (e.previousKey !== undefined && key === e.previousKey)
      return { frame, repeated: true, rgba: null, ...e.previous };
    const drawn = drawFrame(
      ck,
      compositor,
      e.project,
      e.compositionId,
      frame,
      e.maxSize,
      e.components,
      e,
      evaluated,
    );
    const pixels =
      e.alpha === "straight"
        ? unpremultiply(ck, drawn.width, drawn.height, drawn.pixels)
        : drawn.pixels;
    e.previousKey = key;
    e.previous = {
      width: drawn.width,
      height: drawn.height,
      skipped: drawn.skipped,
      warnings: drawn.warnings,
    };
    return { frame, repeated: false, rgba: toBase64(pixels), ...e.previous };
  } catch (error) {
    return errorResponse(error);
  }
}

type ErrorResponse = { ok: false; name: string; message: string };

function errorResponse(error: unknown): ErrorResponse {
  const e = error instanceof Error ? error : new Error(String(error));
  return { ok: false, name: e.name, message: e.message };
}

/** Straight-alpha RGBA8: CanvasKit's own un-premultiplying read, the conversion its PNG encode uses. */
function unpremultiply(
  ck: CanvasKit,
  width: number,
  height: number,
  pixels: Uint8Array,
): Uint8Array {
  const image = wrap(ck, width, height, pixels);
  try {
    const out = image.readPixels(0, 0, {
      width,
      height,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (!(out instanceof Uint8Array)) throw new Error("CanvasKit returned no RGBA8 pixels");
    return out;
  } finally {
    image.delete();
  }
}

const RGBA = (ck: CanvasKit, width: number, height: number) => ({
  width,
  height,
  colorType: ck.ColorType.RGBA_8888,
  alphaType: ck.AlphaType.Premul,
  colorSpace: ck.ColorSpace.SRGB,
});

/** Wraps premultiplied pixels as a CanvasKit image; the caller deletes it. */
function wrap(ck: CanvasKit, width: number, height: number, pixels: Uint8Array) {
  const image = ck.MakeImage(RGBA(ck, width, height), pixels, width * 4);
  if (image === null) throw new Error("capture page: CanvasKit could not wrap the frame");
  return image;
}

/** Draws onto a fresh transparent CPU raster surface and reads it back premultiplied. */
function drawPixels(
  ck: CanvasKit,
  width: number,
  height: number,
  draw: (canvas: Canvas) => void,
): Uint8Array {
  const surface = ck.MakeSurface(width, height);
  if (surface === null) throw new RangeError(`cannot allocate a ${width}×${height} surface`);
  try {
    const canvas = surface.getCanvas();
    canvas.clear(ck.TRANSPARENT);
    draw(canvas);
    const pixels = canvas.readPixels(0, 0, RGBA(ck, width, height));
    if (!(pixels instanceof Uint8Array)) throw new Error("CanvasKit returned no RGBA8 pixels");
    return pixels;
  } finally {
    surface.delete();
  }
}

/**
 * The frame resampled to `size` on the CPU (trilinear: linear filtering between mipmap levels,
 * so large reductions do not alias), or the frame itself when the size is unchanged.
 */
function downscale(
  ck: CanvasKit,
  full: { width: number; height: number; pixels: Uint8Array },
  size: { width: number; height: number },
): Uint8Array {
  if (size.width === full.width && size.height === full.height) return full.pixels;
  const image = wrap(ck, full.width, full.height, full.pixels);
  try {
    return drawPixels(ck, size.width, size.height, (canvas) => {
      canvas.drawImageRectOptions(
        image,
        ck.XYWHRect(0, 0, full.width, full.height),
        ck.XYWHRect(0, 0, size.width, size.height),
        ck.FilterMode.Linear,
        ck.MipmapMode.Linear,
        null,
      );
    });
  } finally {
    image.delete();
  }
}

/**
 * Tiles the frames row-major on a transparent sheet. Cells are copied at whole-pixel offsets
 * without resampling, so each cell holds exactly its frame's pixels.
 */
async function tile(
  frames: Pixels[],
  { columns, gap }: { columns: number; gap: number },
): Promise<PageSheet> {
  const kit = ck();
  const [first] = frames;
  if (first === undefined) throw new RangeError("a contact sheet needs at least one frame");
  const cell = { width: first.width, height: first.height };
  const layout = sheetSize(cell, frames.length, columns, gap);
  const pixels = drawPixels(kit, layout.width, layout.height, (canvas) => {
    frames.forEach((f, i) => {
      const image = wrap(kit, f.width, f.height, f.pixels);
      try {
        const x = (i % layout.columns) * (cell.width + gap);
        const y = Math.floor(i / layout.columns) * (cell.height + gap);
        canvas.drawImage(image, x, y, null);
      } finally {
        image.delete();
      }
    });
  });
  return {
    width: layout.width,
    height: layout.height,
    png: toBase64(encodePng(kit, layout.width, layout.height, pixels)),
    pixelsSha256: await sha256(pixels),
    cellWidth: cell.width,
    cellHeight: cell.height,
    frames: frames.map(({ frame, skipped, warnings }) => ({ frame, skipped, warnings })),
  };
}

/** CanvasKit's PNG encoder, pinned with CanvasKit; it un-premultiplies for the file's straight alpha. */
function encodePng(ck: CanvasKit, width: number, height: number, pixels: Uint8Array): Uint8Array {
  const image = wrap(ck, width, height, pixels);
  try {
    const png = image.encodeToBytes(ck.ImageFormat.PNG, 100);
    if (png === null) throw new Error("capture page: CanvasKit could not encode the PNG");
    return png;
  } finally {
    image.delete();
  }
}

/** Skipped layers and warnings of the frame and every nested precomp plan, each plan once. */
function reports(root: FramePlan): { skipped: SkippedLayer[]; warnings: RenderWarning[] } {
  const skipped: SkippedLayer[] = [];
  const warnings: RenderWarning[] = [];
  const seen = new Set<FramePlan>([root]);
  const stack = [root];
  for (let plan = stack.pop(); plan !== undefined; plan = stack.pop()) {
    skipped.push(...plan.skipped);
    warnings.push(...plan.warnings);
    for (const layer of plan.layers)
      for (let l: typeof layer | null = layer; l !== null; l = l.matte?.source ?? null)
        if (l.type === "precomp" && !seen.has(l.frame)) {
          seen.add(l.frame);
          stack.push(l.frame);
        }
  }
  return { skipped, warnings };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // The compositor's readback is a plain ArrayBuffer, never shared memory.
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
