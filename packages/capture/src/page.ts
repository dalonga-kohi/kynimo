/**
 * The capture page (browser only). Vite bundles it into `dist/page/capture.js`, which the host
 * loads into the pinned Chromium. The whole pipeline runs here, on the path ADR-0016 guarantees:
 * evaluate → CanvasKit raster → WebGL2 compositor → PNG.
 */
import { createComponentHost, createProjectComponentRegistry } from "@kynimo/components";
import { type EvaluateOptions, evaluateFrame, indexShaderDefinitions } from "@kynimo/engine";
import {
  BUNDLED_FONTS,
  type CanvasKit,
  type CompositePrefix,
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
  type PageTimings,
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
  shaders,
  components,
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
    const options = evaluationOptions({ project, shaders, components });
    for (const frame of frames)
      out.push(
        drawFrame(ck, compositor, project, compositionId, frame, maxSize, options, {
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

const evaluationOptions = ({
  project,
  shaders,
  components,
}: Pick<PageRequest, "project" | "shaders" | "components">): EvaluateOptions => ({
  components: createComponentHost(project, createProjectComponentRegistry(components)),
  ...(shaders.length === 0 ? {} : { shaders: indexShaderDefinitions(shaders) }),
});

/** Evaluates, rasterizes, composites and downscales one frame; shared by `render` and exports. */
function drawFrame(
  ck: CanvasKit,
  compositor: Compositor,
  project: PageRequest["project"],
  compositionId: string,
  frame: number,
  maxSize: number | null,
  options: EvaluateOptions,
  libraries: { images: ImageLibrary; fonts: FontLibrary; videos: VideoFrameLibrary },
  evaluated = evaluateFrame(project, frame, compositionId, options),
  reuse?: FrameReuse,
): Pixels & { below?: Reports } {
  const t0 = now();
  const plan = rasterizeFrame(ck, evaluated, libraries);
  const t1 = now();
  let prefix: CompositePrefix | undefined;
  let below: Reports | undefined;
  if (reuse !== undefined && "use" in reuse) prefix = { use: reuse.use };
  else if (reuse !== undefined) {
    // The plan keeps the evaluated order, so the saved layers are its last ones.
    let layers = 0;
    for (let i = plan.layers.length - 1; i >= 0 && reuse.ids.has(plan.layers[i]?.id ?? ""); i--)
      layers++;
    prefix = { save: reuse.save, layers };
    below = reports(plan, reuse.ids);
  }
  const full = compositor.composite(plan, prefix);
  const t2 = now();
  const size = fitSize(full.width, full.height, maxSize);
  const pixels = downscale(ck, full, size);
  timings.rasterMs += t1 - t0;
  timings.compositeMs += t2 - t1;
  timings.downscaleMs += now() - t2;
  const own = reports(plan);
  const all =
    reuse !== undefined && "use" in reuse
      ? {
          skipped: [...own.skipped, ...reuse.below.skipped],
          warnings: [...own.warnings, ...reuse.below.warnings],
        }
      : own;
  return { frame, ...size, pixels, ...all, ...(below === undefined ? {} : { below }) };
}

interface Reports {
  skipped: SkippedLayer[];
  warnings: RenderWarning[];
}

/**
 * How an export frame reuses its unchanged bottom layers (`CompositePrefix` in the compositor).
 * `save`: the frame is whole, and the layers with these ids, its bottom ones, are kept. `use`: the
 * frame holds only the layers above the kept ones, whose reports are `below`.
 */
type FrameReuse = { save: number; ids: ReadonlySet<string> } | { use: number; below: Reports };

/**
 * Where the page's time went, summed since the last `takeTimings`. Wall-clock, read only to report
 * how long stages took: nothing here reaches evaluation or the pixels.
 */
let timings = emptyTimings();
const now = () => performance.now();

function emptyTimings(): PageTimings {
  return {
    frames: 0,
    repeated: 0,
    evaluateMs: 0,
    rasterMs: 0,
    compositeMs: 0,
    downscaleMs: 0,
    transferMs: 0,
    reused: 0,
  };
}

/** The stage timings since the previous call; resets them. */
export function takeTimings(): PageTimings {
  const out = timings;
  timings = emptyTimings();
  return out;
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
  options: EvaluateOptions;
  shaderKeys: ReadonlyMap<object, string>;
  images: ImageLibrary;
  fonts: FontLibrary;
  videos: VideoFrameLibrary;
  loaded: Set<string>;
  previousKey: string | undefined;
  /** The frame-level key and the layer keys (bottom first) of the frame drawn last. */
  previousLayers: { frame: string; layers: string[] } | undefined;
  /** The bottom layers the compositor holds: their keys (bottom first) and reports. */
  kept: { token: number; frame: string; layers: string[]; below: Reports } | undefined;
  /** The last token given to the compositor. */
  tokens: number;
  /** The output pixels of the frame drawn last, kept for `exportSlice`. */
  pixels: Uint8Array | undefined;
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
    const options = evaluationOptions(request);
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
      options,
      shaderKeys: new Map(
        request.shaders.map((definition) => [
          definition,
          `${definition.id}@${definition.version}:${definition.hash}`,
        ]),
      ),
      images,
      fonts,
      videos,
      loaded: new Set(),
      previousKey: undefined,
      previousLayers: undefined,
      kept: undefined,
      tokens: 0,
      pixels: undefined,
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
): Promise<ExportFrameHeader | ErrorResponse> {
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
    const started = now();
    timings.frames++;
    const evaluated = evaluateFrame(e.project, frame, e.compositionId, e.options);
    // Sound because the evaluated frame carries everything that decides the pixels: effects,
    // grain, generators and video source frames are all resolved into it, and rendering reads
    // nothing else that changes between frames (the libraries only gain the frames it names).
    // It is plain data (numbers, strings, arrays, objects); a non-finite number serializes as
    // null, which cannot make two different frames look equal in practice. Only the frame
    // root frame index and the sign of `layerFrame` differ by definition and are neutralized; every
    // nested `frame` (grain, precomps) stays, which can only miss a dedupe, never repeat wrong pixels.
    const replacer = (key: string, value: unknown) => {
      // Shared precomps can reference one definition thousands of times. Keep its immutable pin
      // in the key and leave per-frame values (frame, seed, uniforms) in the resolved instance.
      if (key === "definition" && value !== null && typeof value === "object")
        return e.shaderKeys.get(value) ?? value;
      return frameIndependent(key, value);
    };
    // One key per layer, bottom first, and one for the rest of the frame. A layer's key holds its
    // whole matte chain and nested composition, which the evaluated layer carries. No key holds a
    // raw line break, so the joined key is equal exactly when every part is.
    const frameKey = JSON.stringify({ ...evaluated, frame: 0, layers: [] }, replacer);
    const count = evaluated.layers.length;
    const layerKeys: string[] = [];
    for (let i = count - 1; i >= 0; i--)
      layerKeys.push(JSON.stringify(evaluated.layers[i], replacer));
    const key = `${frameKey}\n${layerKeys.join("\n")}`;
    timings.evaluateMs += now() - started;
    if (e.previousKey !== undefined && key === e.previousKey) {
      timings.repeated++;
      return { frame, repeated: true, bytes: 0, ...e.previous };
    }
    // Bottom layers that equal the previous frame's are composited once and kept (the same pixels:
    // the kept frame is what compositing them again would give). `stable` counts them. The kept
    // ones are reused while they still match and no longer run of layers has become stable.
    const run = (other: readonly string[]) => {
      let n = 0;
      while (n < other.length && n < count && other[n] === layerKeys[n]) n++;
      return n;
    };
    const stable = e.previousLayers?.frame === frameKey ? run(e.previousLayers.layers) : 0;
    const kept = e.kept;
    const hit =
      kept !== undefined &&
      kept.frame === frameKey &&
      kept.layers.length >= stable &&
      run(kept.layers) === kept.layers.length &&
      compositor.hasPrefix(kept.token);
    let reuse: FrameReuse | undefined;
    let drawing = evaluated;
    if (hit) {
      reuse = { use: kept.token, below: kept.below };
      drawing = { ...evaluated, layers: evaluated.layers.slice(0, count - kept.layers.length) };
      timings.reused++;
    } else if (stable > 0) {
      e.tokens++;
      reuse = {
        save: e.tokens,
        ids: new Set(evaluated.layers.slice(count - stable).map((layer) => layer.id)),
      };
    }
    if (!hit) e.kept = undefined;
    const drawn = drawFrame(
      ck,
      compositor,
      e.project,
      e.compositionId,
      frame,
      e.maxSize,
      e.options,
      e,
      drawing,
      reuse,
    );
    if (reuse !== undefined && "save" in reuse && drawn.below !== undefined)
      e.kept = {
        token: reuse.save,
        frame: frameKey,
        layers: layerKeys.slice(0, stable),
        below: drawn.below,
      };
    e.previousLayers = { frame: frameKey, layers: layerKeys };
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
    e.pixels = pixels;
    return { frame, repeated: false, bytes: pixels.byteLength, ...e.previous };
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Bytes `start` to `end` of the frame `exportFrame` drew last, base64. The host reads a frame as
 * many small slices: one protocol message holding a whole 1080p frame costs about twice as much.
 */
export function exportSlice(start: number, end: number): string {
  const pixels = exporting?.pixels;
  if (pixels === undefined) throw new Error("capture page: no export frame to read");
  const started = now();
  const out = toBase64(pixels.subarray(start, end));
  timings.transferMs += now() - started;
  return out;
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
function reports(root: FramePlan, only?: ReadonlySet<string>): Reports {
  const skipped: SkippedLayer[] = [];
  const warnings: RenderWarning[] = [];
  const seen = new Set<FramePlan>([root]);
  const stack = [root];
  for (let plan = stack.pop(); plan !== undefined; plan = stack.pop()) {
    // With `only`: of the root, just what belongs to those layers; nested plans are whole.
    const within = (id: string) => only === undefined || plan !== root || only.has(id);
    skipped.push(...plan.skipped.filter((s) => within(s.id)));
    warnings.push(...plan.warnings.filter((w) => within(w.id)));
    for (const layer of plan.layers.filter((l) => within(l.id)))
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
