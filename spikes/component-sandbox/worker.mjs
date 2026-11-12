import wasmUrl from "quickjs-wasm-url?url";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-core";
import RELEASE_SYNC from "quickjs-release-sync";
import { createFrameEvaluator, source } from "./fixtures.mjs";
import { createSandbox, createTrustedCachedFixture } from "./sandbox.mjs";

const started = performance.now();
const quickJS = await newQuickJSWASMModuleFromVariant(
  newVariant(RELEASE_SYNC, { wasmLocation: wasmUrl }),
);
const wasmMs = performance.now() - started;
let cached;
const evaluate = {
  quickjs: createFrameEvaluator(createSandbox(quickJS, source)),
  reused: createFrameEvaluator(createSandbox(quickJS, source, { reuseRuntime: true })),
  minimal: createFrameEvaluator(
    createSandbox(quickJS, source, { reuseRuntime: true, minimal: true }),
  ),
  cached: (scene, frame) => {
    cached ??= createFrameEvaluator(createTrustedCachedFixture(quickJS, source));
    return cached(scene, frame);
  },
  native: createFrameEvaluator(),
  bounded: createFrameEvaluator(undefined, { bounded: true }),
};

self.onmessage = ({ data: { mode, scene, frame } }) => {
  try {
    const start = performance.now();
    const result = evaluate[mode](scene, frame);
    self.postMessage({ result, workMs: performance.now() - start });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
self.postMessage({ wasmMs });
