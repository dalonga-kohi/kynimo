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
globalThis.drawScene(CK, surface.getCanvas(), fontBytes, W, H);
const nodeRaster = surface.getCanvas().readPixels(0, 0, {
  width: W,
  height: H,
  colorType: CK.ColorType.RGBA_8888,
  alphaType: CK.AlphaType.Premul,
  colorSpace: CK.ColorSpace.SRGB,
});
surface.delete();
const nodeCpuRaster = createHash("sha256").update(nodeRaster).digest("hex").slice(0, 16);

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
      ([w, h, f, o]) => globalThis.runExperiments(w, h, f, o),
      [W, H, font.toString("base64"), ORIGIN],
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
  ["GLSL shader pass identical across launches", allEqual("shaderPass")],
  ["RGBA16F two-pass chain identical across launches", allEqual("halfFloatChain")],
  ["Skia CPU raster identical across launches", allEqual("cpuRaster")],
  ["Skia CPU raster identical in Node and Chromium", first.cpuRaster === nodeCpuRaster],
  ["CPU raster -> WebGL2 composite identical across launches", allEqual("cpuComposite")],
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
  `INFO  timings (ms, first launch): CPU raster ${first.cpuRasterMs}, upload+composite+readback ` +
    `${first.uploadCompositeMs}; shared-context frames ${first.sharedFrame0Ms}, ${first.sharedFrame1Ms}, ${first.sharedFrame2Ms}`,
);
console.log(
  `INFO  hashes: shader ${first.shaderPass}, half-float ${first.halfFloatChain}, cpu raster ${first.cpuRaster}, composite ${first.cpuComposite}`,
);

process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
