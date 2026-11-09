# Spike: scripts in a sandbox (ADR-0036)

Evidence for [ADR-0036](../../docs/decisions/0036-scripts.md). It checks that TypeScript written by an agent can run once inside QuickJS (compiled to WebAssembly), with no clock, randomness, network or host access and under counted CPU, memory and stack limits, and produce a batch of scene operations that is identical on every run.

This directory is a standalone package, outside the pnpm workspace. It is not built, tested or shipped with the product.

## Run

```bash
pnpm install --ignore-workspace
```

```bash
pnpm spike
```

The script exits non-zero if any `PASS` check fails. Needs Node 22.13 or newer (`module.stripTypeScriptTypes`).

## What it does

| #   | Experiment                                                                 | Result (Node 22, x64)                            |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | `script.example.ts` (a title and three staggered chips) → ops              | 14 ops from a 1.2 KB script                      |
| 2   | Same script and seed in fresh sandboxes; another seed                      | Identical bytes; other seed differs              |
| 3   | `Date`, `Math.random`, `fetch`, `require`, `process`, timers, `WeakRef`, … | All `undefined`; `import()` is refused           |
| 4   | `for (;;) {}`                                                              | Interrupted at the same tick count every run     |
| 5   | Unbounded allocation; unbounded recursion; a script after both             | Each fails its own script only                   |
| 6   | Script tries to replace the SDK                                            | No effect                                        |
| 6b  | Script replaces `JSON.stringify` to return 20 000 ops; 64 KB+ source       | Rejected on the host                             |
| 6d  | Ops recorded in a promise callback                                         | The run is an error, nothing is dropped silently |
| 7   | Script error                                                               | Reported with its message                        |
| 8   | TypeScript that needs code generation (`enum`)                             | Refused: types are erased, never compiled        |
| 9   | Cost of a run: fresh WebAssembly instance + SDK + script                   | About 6 ms                                       |

## Findings

- **One WebAssembly instance per script.** After a script hits the memory limit, QuickJS can't free its runtime and the instance aborts. With a shared instance that would take down every later script; with one instance per run it costs nothing (experiment 5, and the 6 ms in experiment 9 already includes creating the instance).
- **Count the budget, don't time it.** The interrupt handler is called every fixed number of branches. Counting its calls stops a script at the same point on any machine; a wall-clock deadline would not.
- **Limits on the result belong on the host.** A count checked inside the sandbox is checked by code the script can replace (experiment 6b).
- **Scripts are synchronous.** Promise jobs are never run, so pending work is reported as an error (experiment 6d).
- **The SDK is not the security boundary.** A script can reach the SDK's internals and push any object as an op. The boundary is the sandbox (nothing ambient to reach) plus the host validating every op against the scene schemas before applying the batch.

## Not covered

- A wall-clock backstop. QuickJS doesn't call the interrupt handler inside native built-ins, so a large `sort` runs unmetered until the memory limit stops it. ADR-0036 adds a worker thread with a deadline; the spike doesn't build it.
- The ops here are simplified stand-ins, not Kynimo's real operations, so the script-to-ops size ratio is indicative only.
- Running the sandbox per frame in the browser for custom components (ADR-0012). That is M6's question: this spike runs a script once, in Node.
- Type checking. Types are stripped, not checked.
