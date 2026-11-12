# M6 component sandbox spike

Measures `quickjs-emscripten` in the pinned Chromium with the real component host and engine. The spike uses the workspace lockfile and sits outside the application packages.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @kynimo/renderer exec playwright install chromium
pnpm exec turbo run build --filter=@kynimo/components
node spikes/component-sandbox/run.mjs
```

Run on an idle machine. The runner builds a Vite bundle, serves it on localhost, and launches three fresh Chromium processes. Each browser creates a dedicated worker and times startup through the ready message, Wasm initialization within the worker, and the first evaluated frame. The worker loads the synchronous release Wasm build pinned by `@kynimo/script`.

The representative 60 fps composition has eight active instances and produces 68 text and solid layers per frame. It contains three lower thirds, three bar charts, and two particle fields. It exercises animated numeric props, resolved style roles, non-ASCII text, frame arithmetic, and seeded randomness. The stress case repeats the mix four times. Each measurement warms up with 60 requests and samples 240 requests with one frame in flight.

| Row       | What runs                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `quickjs` | Fresh QuickJS runtime and context for each instance, one Wasm instance per worker                                                      |
| `reused`  | One QuickJS runtime for the benchmark mode, fresh context for each instance                                                            |
| `minimal` | Same as `reused`, with only base objects, evaluation and JSON intrinsics enabled                                                       |
| `cached`  | Trusted control with a persistent context and a compile-once fixture. Guest state can persist, so this mode is excluded from the gate. |
| `native`  | The same fixture function in the browser worker's JavaScript engine                                                                    |
| `scrub`   | The fresh-runtime path with the same frames requested in a different order                                                             |
| `stress`  | The fresh-runtime path with 32 instances                                                                                               |

Round-trip timings start at the browser's request and end when the resolved frame arrives. They include scheduling, structured cloning, prop and style resolution, input serialization, guest initialization and evaluation, output serialization and validation, and engine evaluation. Worker timings end before the reply is posted. Drawing, asset loading, and player work are outside the measurement. The browser clock is used only by the harness.

The gate is a round-trip p95 of at most 4 ms for eight instances in every launch. `MISS` is a benchmark result and keeps the process exit code at zero. A runtime or output parity failure exits nonzero. Five frames, including the first and last, must match across cold and warm evaluation, browser launches, runtime variants, the native baseline, scrub order, and Node QuickJS. The pinned versions and hardware print with the results.

The harness runs repository-owned fixture source. It models a data-only boundary and sets experimental resource limits to measure the evaluation path. A production evaluator needs its own limit validation and isolation review.
