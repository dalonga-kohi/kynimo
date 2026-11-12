import { createFrameEvaluator } from "./fixtures.mjs";

let evaluate;
self.onmessage = ({ data }) => {
  try {
    if (typeof data === "object") {
      evaluate = createFrameEvaluator(undefined, { bounded: true, ...data });
      self.postMessage({ ready: true });
      return;
    }
    const start = performance.now();
    const result = evaluate("representative", data);
    self.postMessage({ result, workerMs: performance.now() - start });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
