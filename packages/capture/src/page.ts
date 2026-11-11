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
    for (const frame of frames) {
      const plan = rasterizeFrame(
        ck,
        evaluateFrame(project, frame, compositionId, { components }),
        {
          images,
          fonts,
          videos,
        },
      );
      const full = compositor.composite(plan);
      const size = fitSize(full.width, full.height, maxSize);
      out.push({ frame, ...size, pixels: downscale(ck, full, size), ...reports(plan) });
    }
    return out;
  } finally {
    fonts.delete();
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
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
