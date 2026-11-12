import { createRequire } from "node:module";
import { cpus, release } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ORIGIN } from "../../packages/capture/dist/protocol.js";
import { openCapturePage } from "../../packages/capture/dist/session.js";

const fromCapture = createRequire(new URL("../../packages/capture/package.json", import.meta.url));
const { chromium } = fromCapture("playwright");
const { build } = await import(pathToFileURL(fromCapture.resolve("vite")).href);
const smoke = process.argv.includes("--smoke");
const hardware = process.argv.includes("--hardware");
const full = process.argv.includes("--full") || (hardware && !process.argv.includes("--compact"));
const warmup = smoke ? 2 : full && !hardware ? 4 : 12;
const samples = smoke ? 4 : full && !hardware ? 12 : 60;
const stats = (values) => values.map((value) => value.toFixed(2)).join(" / ");

const bundle = await build({
  configFile: false,
  root: fileURLToPath(new URL(".", import.meta.url)),
  logLevel: "error",
  build: {
    write: false,
    minify: false,
    lib: { entry: "playback-page.mjs", formats: ["iife"], name: "KynimoCapture" },
  },
});
const outputs = Array.isArray(bundle) ? bundle : [bundle];
const pageScript = outputs
  .flatMap(({ output }) => output)
  .find(({ type }) => type === "chunk")?.code;
if (!pageScript) throw new Error("Vite did not produce the playback page");

// Reuse capture's pinned assets for both paths. Its actual capture API deliberately requires SwiftShader.
const capture = await openCapturePage({ pageScript });
let browser = capture.browser;
let page = capture.page;
let gpu = capture.gpu;
try {
  if (hardware) {
    await capture.browser.close();
    browser = await chromium.launch({ channel: "chromium", args: ["--enable-gpu"] });
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const file = url.origin === ORIGIN ? capture.files.get(url.pathname) : undefined;
      return file ? route.fulfill({ contentType: file.type, body: file.body }) : route.abort();
    });
    page = await context.newPage();
    await page.goto(ORIGIN);
    gpu = await page.evaluate(() => globalThis.KynimoCapture.init());
    if (/swiftshader|microsoft basic|llvmpipe|software/i.test(gpu))
      throw new Error(`Hardware WebGL was requested, but Chromium reports ${gpu}`);
  }
  console.log(
    `${process.platform} ${release()} ${process.arch} | ${cpus()[0].model.trim()} | Node ${process.version}`,
  );
  console.log(`Chromium ${browser.version()} | ${gpu}`);
  const result = await page.evaluate((options) => globalThis.KynimoCapture.play(options), {
    width: full ? 1920 : 640,
    height: full ? 1080 : 360,
    warmup,
    samples,
  });
  console.log(
    `${result.size} at 60 Hz | ${warmup} drawing warmup frames, ${samples} measured | ${result.fps.toFixed(2)} drawn fps`,
  );
  console.log("p50 / p95 / max (ms)");
  console.log(`  Evaluation round trip  ${stats(result.evaluation)}`);
  console.log(`  Evaluator worker       ${stats(result.worker)}`);
  console.log(`  Drawing and readback   ${stats(result.drawing)}`);
  console.log(`  Combined frame work    ${stats(result.total)}`);
  console.log(`  Animation tick gap     ${stats(result.cadence)}`);
  console.log(`  Exceeded 16.67 ms       ${result.missedDeadlines}/${samples} animation ticks`);
  console.log(`  Skipped frames         ${result.skippedFrames}`);
} finally {
  await browser.close();
}
