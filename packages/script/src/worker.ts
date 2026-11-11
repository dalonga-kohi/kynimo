// Worker entry for the script sandbox (ADR-0036). Self-contained on purpose: it imports only
// from `quickjs-emscripten` and `node:` modules and uses erasable-only TypeScript, so Node can
// run this file directly from source (tests) and as `dist/worker.js` (built).
// The message shapes below are mirrored in `run.ts`; keep them in sync.
import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModule } from "quickjs-emscripten";

/** Mirrors `WorkerInput` in run.ts. */
interface WorkerInput {
  js: string;
  sdk: string;
  seed: number;
  dataJson: string;
  memoryBytes: number;
  stackBytes: number;
  interrupts: number;
}

type FailureKind = "syntax" | "runtime" | "async" | "cpu_limit" | "memory_limit" | "stack_limit";

/** Mirrors `WorkerOutput` in run.ts. `value` is whatever `__collect()` returned; the host checks it. */
type WorkerOutput =
  | { ok: true; value: unknown; interrupts: number }
  | {
      ok: false;
      kind: FailureKind;
      message: string;
      line?: number;
      column?: number;
      interrupts: number;
    };

class Failure extends Error {
  readonly kind: FailureKind;
  readonly line: number | undefined;
  readonly column: number | undefined;
  constructor(kind: FailureKind, message: string, line?: number, column?: number) {
    super(message);
    this.kind = kind;
    this.line = line;
    this.column = column;
  }
}

const MODULES_MESSAGE =
  "scripts are not modules: no import or export; the SDK is the global `kynimo`";

/** Removes the ambient sources of non-determinism, then binds the seed and data as values. */
const PRELUDE = `
delete globalThis.Date;
delete Math.random;
delete globalThis.WeakRef;
delete globalThis.FinalizationRegistry;
const __SEED = globalThis.__seedIn >>> 0;
const __DATA = JSON.parse(globalThis.__dataIn);
delete globalThis.__seedIn;
delete globalThis.__dataIn;
`;

const input = workerData as WorkerInput;

async function run(): Promise<WorkerOutput> {
  // A fresh WebAssembly instance per run, never shared: a script that exhausts memory can leave
  // QuickJS unable to free its runtime (the module aborts).
  const QuickJS = await newQuickJSWASMModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(input.memoryBytes);
  runtime.setMaxStackSize(input.stackBytes);
  let interrupts = 0;
  runtime.setInterruptHandler(() => ++interrupts > input.interrupts);
  const vm = runtime.newContext();
  try {
    const evalOrThrow = (code: string, file: string): unknown => {
      const r = vm.evalCode(code, file, { type: "global" });
      if (r.error) {
        const err = vm.dump(r.error) as unknown;
        r.error.dispose();
        throw toFailure(err, file);
      }
      // Only the collect step's value is read; a script's completion value is ignored.
      const v = file === "collect.js" ? (vm.dump(r.value) as unknown) : undefined;
      r.value.dispose();
      return v;
    };

    const toFailure = (err: unknown, file: string): Failure => {
      if (typeof err !== "object" || err === null) {
        return new Failure("runtime", String(err));
      }
      const e = err as { name?: unknown; message?: unknown; stack?: unknown };
      const name = typeof e.name === "string" ? e.name : "Error";
      const message = typeof e.message === "string" ? e.message : "";
      const stack = typeof e.stack === "string" ? e.stack : "";
      // The first frame in the user's script is the useful position, even when the error was
      // thrown deeper inside the SDK.
      let line: number | undefined;
      let column: number | undefined;
      if (file === "script.ts" || stack.includes("script.ts")) {
        const m = /script\.ts:(\d+)(?::(\d+))?/.exec(stack);
        if (m?.[1]) {
          line = Number(m[1]);
          if (m[2]) column = Number(m[2]);
        }
      }
      let failure: Failure;
      if (/interrupted/i.test(message)) {
        failure = new Failure("cpu_limit", "script exceeded its CPU budget");
      } else if (/out of memory/i.test(message)) {
        failure = new Failure("memory_limit", "script exceeded its memory limit");
      } else if (/stack overflow/i.test(message)) {
        failure = new Failure(
          "stack_limit",
          "script exceeded its stack limit (recursion too deep)",
        );
      } else if (name === "SyntaxError") {
        const modules = file === "script.ts" && looksLikeModule(line);
        failure = new Failure("syntax", modules ? MODULES_MESSAGE : `SyntaxError: ${message}`);
      } else {
        failure = new Failure("runtime", `${name}: ${message}`);
      }
      if (line !== undefined) return new Failure(failure.kind, failure.message, line, column);
      return failure;
    };

    const looksLikeModule = (line: number | undefined): boolean => {
      const lines = input.js.split("\n");
      const test = (text: string) => /^\s*(import\s*[\w{*'"]|export\b)/.test(text);
      if (line !== undefined) return test(lines[line - 1] ?? "");
      return lines.some(test);
    };

    const seed = vm.newNumber(input.seed >>> 0);
    vm.setProp(vm.global, "__seedIn", seed);
    seed.dispose();
    const data = vm.newString(input.dataJson);
    vm.setProp(vm.global, "__dataIn", data);
    data.dispose();

    evalOrThrow(PRELUDE, "prelude.js");
    evalOrThrow(input.sdk, "sdk.js");
    evalOrThrow(input.js, "script.ts");
    // Scripts are synchronous. Work left in a promise would be dropped silently, so it is an error.
    if (runtime.hasPendingJob()) {
      throw new Failure(
        "async",
        "scripts must be synchronous: a promise, await or import() is pending",
      );
    }
    const value = evalOrThrow("__collect()", "collect.js");
    return { ok: true, value, interrupts };
  } catch (e) {
    if (e instanceof Failure) {
      const out: WorkerOutput = { ok: false, kind: e.kind, message: e.message, interrupts };
      if (e.line !== undefined) out.line = e.line;
      if (e.column !== undefined) out.column = e.column;
      return out;
    }
    return {
      ok: false,
      kind: "runtime",
      message: `sandbox error: ${e instanceof Error ? e.message : String(e)}`,
      interrupts,
    };
  } finally {
    // After a limit was hit, disposal can abort the instance. The worker is discarded anyway.
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      // ignored
    }
  }
}

const output = await run();
parentPort?.postMessage(output);
