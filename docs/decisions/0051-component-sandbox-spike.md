# 0051 — Per-frame custom component sandbox spike

- Status: accepted (resolves the M6 performance question left by ADR-0036)
- Date: 2026-11-12

## Context

[ADR-0012](0012-code-authoring.md) calls for user-authored TypeScript components that derive a layer subtree at each frame. Preview, capture, and quality checks need to agree on that subtree regardless of evaluation order. [ADR-0046](0046-component-model.md) provides the host that resolves animated props and style tokens and validates the returned subtree. [ADR-0036](0036-scripts.md) and [ADR-0041](0041-run-script.md) use QuickJS WebAssembly for scripts that run once at authoring time. A 60 fps preview has 16.67 ms for the entire frame. The agreed gate for evaluating eight simultaneous custom instances is a browser round-trip p95 of at most 4 ms, leaving about 12.7 ms for drawing and the rest of the player.

## Decision

Defer adopting the measured QuickJS designs for live custom component evaluation. Keep ADR-0046's host and deterministic output contract. Before enabling project-defined component evaluation in `define_component`, benchmark a design that can preserve frame isolation and meet the same gate. Possible follow-up work includes measuring a way to reuse compiled code across fresh realms and reducing the cost of the data boundary. Treat both as hypotheses. The existing script sandbox continues to serve authoring-time work.

Each production candidate needs bounded execution and output, data-only inputs, seeded randomness, a worker deadline, and host validation. Its output must agree when the same frame is reached by playback, scrubbing, capture, or replay. A persistent mutable guest context can make its output depend on previously evaluated frames. The compile-once persistent context in this spike serves as a throughput control for the repository's fixture.

## Evidence

The [reproducible spike](../../spikes/component-sandbox/README.md) uses QuickJS 0.32.0, Chromium 153.0.8010.12, Node 24.19.0, and Windows 11 x64 on a Ryzen 5 3600. The representative composition has eight instances producing 68 layers per frame. It includes lower thirds, charts, and particle fields, with animated props, resolved style tokens, Unicode text, and seeded randomness. Three fresh browser launches each warmed up for 60 requests and measured 240 frames per mode. All cases use the actual component host and engine. The round trip includes scheduling, the JSON boundary, subtree validation, evaluation, and structured cloning. Rasterization and asset loading are outside the measurement.

| Case | Launch 1 p95 (ms) | Launch 2 p95 (ms) | Launch 3 p95 (ms) |
| --- | ---: | ---: | ---: |
| QuickJS, fresh runtime and context | 14.1 | 17.8 | 19.7 |
| QuickJS, reused runtime and fresh context | 13.3 | 17.4 | 17.4 |
| QuickJS, reused runtime and minimal fresh context | 12.7 | 13.8 | 19.1 |
| QuickJS, compile-once persistent context (trusted control) | 7.7 | 7.6 | 9.1 |
| Native JavaScript (trusted baseline) | 3.9 | 4.2 | 4.3 |
| QuickJS, fresh runtime and shuffled scrubbing | 16.1 | 19.1 | 17.3 |
| QuickJS, fresh runtime and 32 instances | 63.6 | 64.6 | 50.5 |

Cold worker readiness took 94.7–110.6 ms, including 16.3–19.5 ms for Wasm initialization. The first evaluated frame added 47.3–50.5 ms. Every fresh-context variant missed the gate even with worker transport excluded. The native baseline approached the budget by itself, so follow-up work should profile the full evaluation path alongside guest execution. The persistent-context control also missed the gate.

Five sampled resolved frames matched across browser launches, first-frame evaluation, sequential playback, shuffled scrubbing, all QuickJS variants, native browser execution, and Node QuickJS. The outputs differed between the first and last frames, and the first contained all eight instances and 68 child layers. This establishes parity for the fixture on the tested host and browser.

## Consequences

- The sandbox spike is complete. `define_component` still needs an evaluator that meets the performance and isolation requirements. Shader validation and definition work can proceed independently.
- These measurements characterize one desktop Chromium setup. Before shipping an evaluator, repeat the gate on the supported preview device baseline and measure it together with drawing under playback load.
- Until a candidate meets the gate, the built-in component library and authoring-time scripts remain available for editable motion.
