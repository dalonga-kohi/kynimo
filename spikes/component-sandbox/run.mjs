import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpus, release } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFrameEvaluator, SCENES, source } from "./fixtures.mjs";
import { createSandbox } from "./sandbox.mjs";

const fromCapture = createRequire(new URL("../../packages/capture/package.json", import.meta.url));
const fromScript = createRequire(new URL("../../packages/script/package.json", import.meta.url));
const { chromium } = fromCapture("playwright");
const quickJSPackage = pathToFileURL(fromScript.resolve("quickjs-emscripten/package.json"));
const fromQuickJS = createRequire(quickJSPackage);
const { newQuickJSWASMModule } = fromScript("quickjs-emscripten");
const { build, preview } = await import(pathToFileURL(fromCapture.resolve("vite")).href);
const root = fileURLToPath(new URL(".", import.meta.url));
const REPEATS = 3;
const FRAME_BUDGET_MS = 4;
const variants = ["quickjs", "reused", "minimal"];

function quickJSEntry(packageName) {
  const entry = fromQuickJS.resolve(packageName);
  return entry.replace(/\.js$/, ".mjs");
}

const config = {
  configFile: false,
  root,
  logLevel: "warn",
  resolve: {
    alias: [
      {
        find: "quickjs-core",
        replacement: quickJSEntry("quickjs-emscripten-core"),
      },
      {
        find: "quickjs-release-sync",
        replacement: quickJSEntry("@jitl/quickjs-wasmfile-release-sync"),
      },
      {
        find: /^quickjs-wasm-url(?=\?)/,
        replacement: fromQuickJS.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"),
      },
    ],
  },
  worker: { format: "es" },
  build: { minify: false },
};

function summary(samples, key) {
  const sorted = samples.map((s) => s[key]).sort((a, b) => a - b);
  const p50 = sorted[Math.ceil(sorted.length * 0.5) - 1];
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  return { p50, p95, max: sorted.at(-1) };
}

const ms = (n) => n.toFixed(2);
const stats = ({ p50, p95, max }) => `${ms(p50)} / ${ms(p95)} / ${ms(max)}`;

await build(config);
const server = await preview({ ...config, preview: { host: "127.0.0.1", port: 0 } });
try {
  const url = server.resolvedUrls.local[0];
  const quickJS = await newQuickJSWASMModule();
  const nodeFrame = createFrameEvaluator(createSandbox(quickJS, source));
  const worst = Object.fromEntries(variants.map((mode) => [mode, 0]));
  let previousResults;
  console.log(
    `${process.platform} ${release()} ${process.arch} | ${cpus()[0].model} | Node ${process.version}`,
  );
  for (let run = 1; run <= REPEATS; run++) {
    const browser = await chromium.launch();
    let evidence;
    try {
      if (run === 1)
        console.log(
          `Chromium ${browser.version()} | QuickJS ${fromQuickJS("./package.json").version}`,
        );
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => typeof globalThis.runComponentSpike === "function");
      evidence = await page.evaluate(() => globalThis.runComponentSpike());
    } finally {
      await browser.close();
    }

    const { results, timings, readyMs, wasmMs, firstMs, coldOutput } = evidence;
    assert.deepEqual(results.quickjs, results.native, "Browser QuickJS/native output differs");
    assert.deepEqual(results.quickjs, results.scrub, "Browser sequential/scrub output differs");
    assert.deepEqual(results.quickjs, results.reused, "Reused runtime output differs");
    assert.deepEqual(results.quickjs, results.minimal, "Minimal intrinsics output differs");
    assert.deepEqual(results.quickjs, results.cached, "Trusted cached fixture output differs");
    assert.equal(coldOutput, results.quickjs[0], "Cold/warm output differs");
    const composition = JSON.parse(coldOutput);
    assert.equal(composition.layers.length, SCENES.representative);
    assert.equal(composition.layers.flatMap((layer) => layer.composition.layers).length, 68);
    for (const [frame, expected] of Object.entries(results.quickjs)) {
      assert.equal(
        JSON.stringify(nodeFrame("representative", Number(frame))),
        expected,
        `Node parity failed at ${frame}`,
      );
    }
    assert.notEqual(results.quickjs[0], results.quickjs[239], "Fixture output did not animate");
    if (previousResults)
      assert.deepEqual(results.quickjs, previousResults, "Output differs across browser launches");
    previousResults = results.quickjs;

    console.log(
      `\nLaunch ${run} | worker ready ${ms(readyMs)} ms (Wasm ${ms(wasmMs)} ms) | first frame ${ms(firstMs)} ms`,
    );
    for (const [name, samples] of Object.entries(timings)) {
      const total = summary(samples, "totalMs");
      if (variants.includes(name)) worst[name] = Math.max(worst[name], total.p95);
      console.log(
        `  ${name.padEnd(8)} ${samples.length} frames | round trip ${stats(total)} ms | worker ${stats(summary(samples, "workMs"))} ms (p50 / p95 / max)`,
      );
    }
  }
  for (const [mode, p95] of Object.entries(worst)) {
    console.log(
      `${p95 <= FRAME_BUDGET_MS ? "PASS" : "MISS"} ${mode} ${SCENES.representative}-instance gate: worst launch p95 ${ms(p95)} ms, budget ${FRAME_BUDGET_MS} ms`,
    );
  }
  console.log(
    `PASS identical sampled frames across cold, warm, scrub, native, Node, and fresh Chromium launches (${createHash("sha256").update(JSON.stringify(previousResults)).digest("hex")})`,
  );
} finally {
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}
