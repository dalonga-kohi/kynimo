/**
 * The capture page (browser only). Vite bundles it into `dist/page/capture.js`, which the host
 * loads into the pinned Chromium. The whole pipeline runs here, on the path ADR-0016 guarantees:
 * evaluate → CanvasKit raster → WebGL2 compositor → PNG.
 */
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
} from "@kynimo/renderer";
import { ORIGIN, type PageFrame, type PageRequest, type PageResponse } from "./protocol.js";

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
    return { ok: true, frames: await renderFrames(request) };
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    return { ok: false, name: e.name, message: e.message };
  }
}

async function renderFrames({
  project,
  compositionId,
  frames,
  assets,
}: PageRequest): Promise<PageFrame[]> {
  if (state === undefined) throw new Error("capture page: init() has not run");
  const { ck, compositor, bundled } = state;
  const provided = new Set(assets);
  const images = new ImageLibrary(ck);
  const fonts = new FontLibrary(ck);
  try {
    for (const [i, font] of BUNDLED_FONTS.entries())
      await fonts.addBundled(font.family, bundled[i] as Uint8Array);
    for (const asset of project.assets) {
      if (!provided.has(asset.id)) continue;
      const bytes = await fetchBytes(`assets/${encodeURIComponent(asset.id)}`);
      if (asset.type === "image") await images.add(asset, bytes);
      else if (asset.type === "font") await fonts.add(asset, bytes);
    }
    const out: PageFrame[] = [];
    for (const frame of frames) {
      const plan = rasterizeFrame(ck, evaluateFrame(project, frame, compositionId), {
        images,
        fonts,
      });
      const { width, height, pixels } = compositor.composite(plan);
      out.push({
        frame,
        width,
        height,
        png: toBase64(encodePng(ck, width, height, pixels)),
        pixelsSha256: await sha256(pixels),
        ...reports(plan),
      });
    }
    return out;
  } finally {
    fonts.delete();
  }
}

/** CanvasKit's PNG encoder, pinned with CanvasKit; it un-premultiplies for the file's straight alpha. */
function encodePng(ck: CanvasKit, width: number, height: number, pixels: Uint8Array): Uint8Array {
  const image = ck.MakeImage(
    {
      width,
      height,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Premul,
      colorSpace: ck.ColorSpace.SRGB,
    },
    pixels,
    width * 4,
  );
  if (image === null) throw new Error("capture page: CanvasKit could not wrap the frame");
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
