import {
  BUNDLED_FONTS,
  createCompositor,
  FontLibrary,
  ImageLibrary,
  loadCanvasKit,
  rasterizeFrame,
} from "../../packages/renderer/dist/index.js";
import { FRAME_COUNT } from "./fixtures.mjs";
import EvaluatorWorker from "./playback-worker.mjs?worker&inline";

const FRAME_MS = 1000 / 60;
let renderer;

export async function init() {
  const ck = await loadCanvasKit({ locateFile: (name) => `/canvaskit/${name}` });
  const gl = document.createElement("canvas").getContext("webgl2", { antialias: false });
  if (!gl) throw new Error("WebGL2 is unavailable");
  const compositor = createCompositor(gl);
  const fonts = new FontLibrary(ck);
  try {
    for (const { family, file } of BUNDLED_FONTS) {
      const response = await fetch(`/fonts/${file}`);
      if (!response.ok) throw new Error(`Bundled font ${file} returned ${response.status}`);
      await fonts.addBundled(family, new Uint8Array(await response.arrayBuffer()));
    }
  } catch (error) {
    fonts.delete();
    compositor.dispose();
    throw error;
  }
  renderer = { ck, compositor, libraries: { fonts, images: new ImageLibrary(ck) } };
  return compositor.renderer;
}

function request(worker, input) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Evaluation worker exceeded 1 second")), 1000);
    const finish = (callback, data) => {
      clearTimeout(timer);
      callback(data);
    };
    worker.onmessage = ({ data }) =>
      data.error ? finish(reject, new Error(data.error)) : finish(resolve, data);
    worker.onerror = ({ message }) => finish(reject, new Error(message));
    worker.onmessageerror = () => finish(reject, new Error("Frame could not be cloned"));
    worker.postMessage(input);
  });
}

function summarize(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return [
    sorted[Math.ceil(sorted.length * 0.5) - 1],
    sorted[Math.ceil(sorted.length * 0.95) - 1],
    sorted.at(-1),
  ];
}

export async function play({ width, height, warmup, samples }) {
  if (!renderer) throw new Error("The playback renderer has not been initialized");
  const { ck, compositor, libraries } = renderer;
  const worker = new EvaluatorWorker();
  const evaluation = [];
  const workerTimings = [];
  const drawing = [];
  const total = [];
  const cadence = [];
  let missedDeadlines = 0;
  let skippedFrames = 0;
  let clockStart;
  let previousTick;
  let previousFrame = -1;
  let firstStart;
  let lastEnd;
  let size;
  try {
    await request(worker, { width, height });
    // Warm the evaluator separately before measuring it alongside drawing.
    for (let i = 0; i < 60; i++) await request(worker, i);
    for (let i = 0; i < warmup + samples; ) {
      const tick = await new Promise(requestAnimationFrame);
      clockStart ??= tick;
      const frame = Math.round((tick - clockStart) / FRAME_MS);
      if (frame <= previousFrame) continue;
      const start = performance.now();
      const { result, workerMs } = await request(worker, frame % FRAME_COUNT);
      const evaluated = performance.now();
      const plan = rasterizeFrame(ck, result, libraries);
      const image = compositor.composite(plan);
      const end = performance.now();
      if (plan.skipped.length > 0) throw new Error("The playback renderer skipped layers");
      const skipped = frame - previousFrame - 1;
      previousFrame = frame;
      if (i++ < warmup) continue;
      if (firstStart === undefined) {
        if (
          result.layers.length !== 8 ||
          result.layers.flatMap(({ composition }) => composition.layers).length !== 68
        )
          throw new Error("Expected eight instances emitting 68 layers");
        size = `${image.width} × ${image.height}`;
        firstStart = start;
      }
      if (previousTick !== undefined) {
        cadence.push(tick - previousTick);
        skippedFrames += skipped;
      }
      previousTick = tick;
      lastEnd = end;
      evaluation.push(evaluated - start);
      workerTimings.push(workerMs);
      drawing.push(end - evaluated);
      total.push(end - start);
      if (end - tick > FRAME_MS) missedDeadlines++;
    }
    return {
      size,
      evaluation: summarize(evaluation),
      worker: summarize(workerTimings),
      drawing: summarize(drawing),
      total: summarize(total),
      cadence: summarize(cadence),
      missedDeadlines,
      skippedFrames,
      fps: (samples * 1000) / (lastEnd - firstStart),
    };
  } finally {
    worker.terminate();
    libraries.fonts.delete();
    compositor.dispose();
    renderer = undefined;
  }
}
