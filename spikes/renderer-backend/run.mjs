// ADR-0016 spike runner. Usage (from this directory):
//   pnpm install --ignore-workspace
//   pnpm spike            # or: node run.mjs [launches]
// Exits non-zero if any determinism claim the ADR relies on does not hold.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import CanvasKitInit from "canvaskit-wasm";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ckBin = dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const fontPath = join(
  dirname(require.resolve("dejavu-fonts-ttf/package.json")),
  "ttf/DejaVuSans.ttf",
);
const font = readFileSync(fontPath);
const fontBytes = font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength);
const W = 1920;
const H = 1080;
const LAUNCHES = Number(process.argv[2] ?? 3);
// Workers must force SwiftShader: with a GPU present Chromium would use it instead.
const CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const ORIGIN = "https://spike.local"; // https so crypto.subtle is available

await import("./scene.js");

// Skia CPU raster in Node: must match the browser byte for byte.
const CK = await CanvasKitInit({ locateFile: (f) => join(ckBin, f) });
const surface = CK.MakeSurface(W, H);
const { longestLine: nodeLongestLine } = globalThis.drawScene(
  CK,
  surface.getCanvas(),
  fontBytes,
  W,
  H,
);
const nodeRaster = surface.getCanvas().readPixels(0, 0, {
  width: W,
  height: H,
  colorType: CK.ColorType.RGBA_8888,
  alphaType: CK.AlphaType.Premul,
  colorSpace: CK.ColorSpace.SRGB,
});
surface.delete();
const shortHash = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const nodeCpuRaster = shortHash(nodeRaster);

// Sanity: identical hashes mean nothing if the scene drew nothing. Require laid-out text, ink in
// the text area and a non-uniform frame.
const alphaPixels = (px, x0, y0, x1, y1) => {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (px[(y * W + x) * 4 + 3]) n++;
  return n;
};
const textInk = alphaPixels(nodeRaster, Math.round(W * 0.08), 0, W, Math.round(H * 0.15));
const distinctPixels = new Set();
for (let i = 0; i < nodeRaster.length && distinctPixels.size < 1000; i += 4 * 97) {
  distinctPixels.add(nodeRaster.subarray(i, i + 4).join(","));
}

// Test images: a procedural gradient + shape, encoded once here as PNG and JPEG with CanvasKit's
// "full" build (the default build has no JPEG encoder), then decoded with the default build's
// codecs in Node and in Chromium.
const encoder = await require("canvaskit-wasm/bin/full/canvaskit.js")({
  locateFile: (f) => join(ckBin, "full", f),
});
const imageSurface = encoder.MakeSurface(257, 173);
{
  const c = imageSurface.getCanvas();
  const paint = new encoder.Paint();
  paint.setShader(
    encoder.Shader.MakeRadialGradient(
      [90, 70],
      160,
      [encoder.Color(250, 220, 60, 1), encoder.Color(20, 40, 160, 0.7)],
      null,
      encoder.TileMode.Mirror,
    ),
  );
  c.drawPaint(paint);
  paint.setShader(null);
  paint.setAntiAlias(true);
  paint.setColor(encoder.Color(255, 255, 255, 0.5));
  c.drawCircle(180, 100, 50, paint);
  paint.delete();
}
const snapshot = imageSurface.makeImageSnapshot();
const images = {
  png: snapshot.encodeToBytes(encoder.ImageFormat.PNG, 100),
  jpeg: snapshot.encodeToBytes(encoder.ImageFormat.JPEG, 85),
};
snapshot.delete();
imageSurface.delete();
const nodeDecoded = Object.fromEntries(
  Object.entries(images).map(([f, bytes]) => [f, shortHash(globalThis.decodeImage(CK, bytes))]),
);
const imagesB64 = Object.fromEntries(
  Object.entries(images).map(([f, bytes]) => [f, Buffer.from(bytes).toString("base64")]),
);

const runs = [];
let version;
for (let i = 0; i < LAUNCHES; i++) {
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  version = browser.version();
  const page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const file = new URL(route.request().url()).pathname.slice(1);
    if (!file)
      return route.fulfill({
        body: "<!doctype html><title>spike</title>",
        contentType: "text/html",
      });
    return route.fulfill({
      body: readFileSync(join(ckBin, file)),
      contentType: file.endsWith(".wasm") ? "application/wasm" : "text/javascript",
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ url: `${ORIGIN}/canvaskit.js` });
  await page.addScriptTag({ path: join(here, "scene.js") });
  await page.addScriptTag({ path: join(here, "page.js") });
  runs.push(
    await page.evaluate(
      ([w, h, f, img, o]) => globalThis.runExperiments(w, h, f, img, o),
      [W, H, font.toString("base64"), imagesB64, ORIGIN],
    ),
  );
  await browser.close();
}

const allEqual = (key) =>
  runs.every((r) => JSON.stringify(r[key]) === JSON.stringify(runs[0][key]));
const distinct = (arr) => new Set(arr).size;
const first = runs[0];
const checks = [
  ["WebGL2 runs on SwiftShader", /SwiftShader/.test(first.renderer)],
  [
    `Scene is not blank (text line ${Math.round(nodeLongestLine)} px, ${textInk} inked text-area px)`,
    nodeLongestLine > 0 &&
      first.longestLine === nodeLongestLine &&
      textInk > 1000 &&
      distinctPixels.size > 50,
  ],
  ["GLSL shader pass identical across launches", allEqual("shaderPass")],
  ["RGBA16F two-pass chain identical across launches", allEqual("halfFloatChain")],
  ["Skia CPU raster identical across launches", allEqual("cpuRaster")],
  ["Skia CPU raster identical in Node and Chromium", first.cpuRaster === nodeCpuRaster],
  ["CPU raster -> WebGL2 composite identical across launches", allEqual("cpuComposite")],
  ["PNG + JPEG decode identical across launches", allEqual("decoded")],
  [
    "PNG + JPEG decode identical in Node and Chromium",
    JSON.stringify(first.decoded) === JSON.stringify(nodeDecoded),
  ],
  ["Experiment 3 really shares our WebGL2 context", first.sharedSameContextObject === true],
  ["Skia GPU alone: redraws identical", distinct(first.skiaGpuAloneFrames) === 1],
];
// Recorded, not required: the rejected shared-context path.
const sharedStable = distinct(first.sharedSkiaFrames) === 1;

console.log(`Chromium ${version} | ${first.renderer}`);
console.log(`float render targets: ${first.floatTargets} | MSAA samples: ${first.maxSamples}`);
console.log(`launches: ${LAUNCHES} | frame: ${W}x${H}\n`);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
console.log(
  `\nINFO  Skia GPU on shared context, redraw-stable after a raw GL pass: ${sharedStable}` +
    ` (MAE vs CPU raster per frame: ${first.sharedSkiaVsCpuMae.join(", ")})`,
);
console.log(
  `INFO  timings (ms, first launch): CPU raster ${first.cpuRasterMs}, upload+composite+readback (incl. shader compile) ` +
    `${first.uploadCompositeMs}; shared-context frames ${first.sharedFrame0Ms}, ${first.sharedFrame1Ms}, ${first.sharedFrame2Ms}`,
);
console.log(
  `INFO  hashes: shader ${first.shaderPass}, half-float ${first.halfFloatChain}, cpu raster ${first.cpuRaster}, composite ${first.cpuComposite}, png ${nodeDecoded.png}, jpeg ${nodeDecoded.jpeg}`,
);

process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
