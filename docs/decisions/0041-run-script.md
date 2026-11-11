# 0041 — run_script

- Status: accepted (extends ADR-0036; amends its op cap and the source-persistence line, see below)
- Date: 2026-11-11

## Context

ADR-0036 decided that agents send TypeScript to `run_script`, which runs once in a QuickJS sandbox and yields a batch of operations. The intent tools (ADR-0040) now exist, so the feature could be built. Building it settled the points ADR-0036 left open: the final limits, how types are erased, how intent calls from a script become operations, and what is stored.

## Decision

- **`@kynimo/script`.** One worker thread per run, with a fresh QuickJS WebAssembly instance inside it (`quickjs-emscripten` pinned to 0.32.0). The worker is ended at the wall-clock deadline. Scripts are global scripts: no `import` or `export`.
- **Types are erased on the host with `module.stripTypeScriptTypes`.** It is built in, so there is no dependency. It is still experimental in Node; an upgrade that changes its output shows up in the tests. This settles the open question in PLAN.md.
- **Final limits** (`SCRIPT_LIMITS`): source 64 KB, memory 32 MB, stack 512 KB, CPU 15 000 interrupts, result 2 MB, wall-clock backstop 5 s. 15 000 interrupts take about 1 s on the dev container (about 65 µs each); the count is the same on any machine. Operations per run are capped at `MAX_BATCH_OPS` (500). This **amends ADR-0036's starting value of 5 000**: a run is one `apply_ops` batch, so it has the batch's cap, and a second batch path with a larger cap is not worth its own rules. A run costs about 85–100 ms, mostly the worker spawn (the spike's 6 ms had no worker).
- **The host replays; the sandbox only records.** The sandbox records entries: raw ops, and `animate`, `apply_preset`, `stagger` and `retime` calls with the intent tools' own inputs, plus the script line of each. The host replays the entries in order against a working document with `@kynimo/intent`, validating each entry with `applyOps`, then writes the concatenation as one batch through the intent write path (`base_version`, idempotency on the tool input, one undo step). The intent code is shared exactly and the sandbox stays small. Cost: a script cannot read what an intent call produced; its snapshot is the document as it was.
- **The SDK** is the `kynimo` global, deep-frozen. Reads come from a frozen snapshot: compositions, layers with static transform values, assets without bytes, and the tokens of the pinned pack (Keynote's when none is pinned). Layer ids are `layer-<n>`, skipping used ids, or explicit. `Composition.add` fills the same defaults as `add_layer` (`withLayerDefaults`, moved to `@kynimo/scene` so both share it); `kynimo.op` stays raw, like `apply_ops`. A test derived from `OpSchema` fails if an operation is not reachable from the SDK.
- **Declarations** are served as `kynimo://sdk` (about 22 KB), generated from the input JSON Schemas by a small emitter. Errors carry a kind and line/column (`script_error` in the tool error); a rejected entry is reported against `expanded_ops`.
- **`dry_run`** returns the ops and `describe_motion` of the main composition as it would be after the batch. Nothing is stored.
- **Listing.** `tools/list` grew to about 71.2 KB. The budget in `server.test.ts` moves from 70 KB to 75 KB; getting back to 60 KB stays the M8 item.
- **Deferred, amending ADR-0036's contract: the source is not yet kept with the change record.** It needs per-version storage in all three stores, a Postgres migration and a read tool. It is a roadmap item (M4). Until then the ops a script produced are in the change record, and the document never depended on the source.

Considered and not adopted:

- **Bundling `@kynimo/intent` into the sandbox.** A larger sandbox image, a second copy of the guideline data, and the risk of the two diverging. Replay shares the code.
- **`amaro` as a pinned type stripper.** A dependency for what Node does; revisit if `stripTypeScriptTypes` is removed.
- **A separate 5 000-op batch path.** See the cap above.

## Consequences

- An agent can build a scene with loops and arithmetic in one call, and gets ordinary layers and keyframes back, undoable as one step.
- Errors from the type stripper (syntax errors) have no line and column; errors from the sandbox and the replay do.
- Replay validates each entry against the working document. The cost on very large documents is untested.
- The experimental Node API is a known upgrade risk, caught by the tests.
- Follow-ups: keep the source per version; the brief suite's with/without comparison (ADR-0035); a cheaper listing (M8).
