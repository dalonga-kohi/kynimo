// These clocks only measure the benchmark in the browser host. They never enter frame inputs.
const FRAME_COUNT = 240;
const WARMUP_FRAMES = 60;

function receive(worker, timeoutMs, send = () => {}) {
  return new Promise((resolve, reject) => {
    const complete = (done, value) => {
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      done(value);
    };
    const timer = setTimeout(() => {
      worker.terminate();
      complete(reject, new Error(`Worker exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    worker.onmessage = ({ data }) => {
      if (data.error) complete(reject, new Error(data.error));
      else complete(resolve, data);
    };
    worker.onerror = (event) => complete(reject, new Error(event.message));
    worker.onmessageerror = () => complete(reject, new Error("Worker result could not be cloned"));
    send();
  });
}

globalThis.runComponentSpike = async () => {
  const start = performance.now();
  const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  try {
    const { wasmMs } = await receive(worker, 10_000);
    const readyMs = performance.now() - start;
    const frame = async (mode, scene, index) => {
      const sent = performance.now();
      const message = await receive(worker, 1_000, () =>
        worker.postMessage({ mode, scene, frame: index }),
      );
      return { ...message, totalMs: performance.now() - sent };
    };
    const first = await frame("quickjs", "representative", 0);
    const sampledFrames = [0, 29, 88, 157, 239];
    const results = { quickjs: {}, reused: {}, minimal: {}, cached: {}, native: {}, scrub: {} };
    const timings = {};
    for (const [name, mode, scene, scrub] of [
      ["quickjs", "quickjs", "representative", false],
      ["reused", "reused", "representative", false],
      ["minimal", "minimal", "representative", false],
      ["cached", "cached", "representative", false],
      ["native", "native", "representative", false],
      ["scrub", "quickjs", "representative", true],
      ["stress", "quickjs", "stress", false],
    ]) {
      for (let i = 0; i < WARMUP_FRAMES; i++) await frame(mode, scene, i);
      timings[name] = [];
      for (let i = 0; i < FRAME_COUNT; i++) {
        // 137 is coprime with 240, so this visits every frame once in a different order.
        const index = scrub ? (i * 137 + 91) % FRAME_COUNT : i;
        const { result, totalMs, workMs } = await frame(mode, scene, index);
        timings[name].push({ totalMs, workMs });
        if (results[name] && sampledFrames.includes(index)) {
          results[name][index] = JSON.stringify(result);
        }
      }
    }
    return {
      readyMs,
      wasmMs,
      firstMs: first.totalMs,
      timings,
      results,
      coldOutput: JSON.stringify(first.result),
    };
  } finally {
    worker.terminate();
  }
};
