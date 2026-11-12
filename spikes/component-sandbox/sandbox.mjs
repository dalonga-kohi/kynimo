import { mulberry32 } from "../../packages/engine/dist/index.js";

const SOURCE_BYTES = 64 * 1024;
const RESULT_BYTES = 256 * 1024;
const MEMORY_BYTES = 32 * 1024 * 1024;
const STACK_BYTES = 512 * 1024;
const INTERRUPTS = 64;
const MINIMAL_INTRINSICS = { BaseObjects: true, Eval: true, JSON: true };
const encoder = new TextEncoder();

function guestFunction(source) {
  if (encoder.encode(source).length > SOURCE_BYTES) throw new Error("Source budget exceeded");
  // Capture the JSON methods before the fixture runs. The host only receives a bounded string.
  return `"use strict"; ((input) => {
    for (const name of ["Date", "Temporal", "Intl", "WeakRef", "FinalizationRegistry", "Atomics", "SharedArrayBuffer"]) {
      delete globalThis[name];
    }
    delete Math.random;
    const stringify = JSON.stringify;
    const [props, ctx] = JSON.parse(input);
    const next = (${mulberry32.toString()})(ctx.seed);
    ctx.random = () => next() / 4294967296;
    const evaluate = (${source});
    const result = stringify(evaluate(props, ctx));
    return result !== undefined && result.length <= ${RESULT_BYTES} ? result : undefined;
  })`;
}

function newRuntime(quickJS) {
  const runtime = quickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_BYTES);
  runtime.setMaxStackSize(STACK_BYTES);
  return runtime;
}

function readResult(vm, result, interrupted) {
  const handle = result.error ?? result.value;
  try {
    if (interrupted) throw new Error("Instruction budget exceeded");
    if (result.error) throw new Error("Guest evaluation failed");
    if (vm.runtime.hasPendingJob()) throw new Error("Guest left pending jobs");
    if (vm.typeof(handle) !== "string") throw new Error("Expected a bounded JSON result");
    const json = vm.getString(handle);
    if (encoder.encode(json).length > RESULT_BYTES) throw new Error("Result budget exceeded");
    return JSON.parse(json);
  } finally {
    handle.dispose();
  }
}

export function createSandbox(quickJS, source, { reuseRuntime = false, minimal = false } = {}) {
  const prefix = guestFunction(source);
  let shared;
  return (props, ctx) => {
    const input = JSON.stringify(JSON.stringify([props, ctx]));
    const runtime = shared ?? newRuntime(quickJS);
    if (reuseRuntime) shared = runtime;
    let interrupts = 0;
    runtime.setInterruptHandler(() => ++interrupts > INTERRUPTS);
    try {
      const vm = runtime.newContext(minimal ? { intrinsics: MINIMAL_INTRINSICS } : undefined);
      try {
        const result = vm.evalCode(`${prefix}(${input})`, "component.js", { type: "global" });
        return readResult(vm, result, interrupts > INTERRUPTS);
      } finally {
        vm.dispose();
      }
    } catch (error) {
      // Pending jobs, exceptions and cleanup failures make this runtime ineligible for reuse.
      shared = undefined;
      throw error;
    } finally {
      if (!shared) runtime.dispose();
    }
  };
}

// A throughput control for repository-owned code. The worker owns this context until termination.
export function createTrustedCachedFixture(quickJS, source) {
  const runtime = newRuntime(quickJS);
  let interrupts = 0;
  runtime.setInterruptHandler(() => ++interrupts > INTERRUPTS);
  const vm = runtime.newContext();
  const callable = vm.unwrapResult(vm.evalCode(guestFunction(source), "component.js"));
  return (props, ctx) => {
    interrupts = 0;
    const input = vm.newString(JSON.stringify([props, ctx]));
    try {
      const result = vm.callFunction(callable, vm.undefined, input);
      return readResult(vm, result, interrupts > INTERRUPTS);
    } finally {
      input.dispose();
    }
  };
}
