import { stripTypeScriptTypes } from "node:module";
import { Worker } from "node:worker_threads";

export interface ScriptLimits {
  /** Largest accepted script source, in UTF-8 bytes. Checked first, on the host. */
  sourceBytes: number;
  /** QuickJS heap limit. */
  memoryBytes: number;
  /** QuickJS stack limit. */
  stackBytes: number;
  /** CPU budget: calls of the QuickJS interrupt handler (made every fixed number of branches). */
  interrupts: number;
  /** Largest accepted result of the SDK's `__collect()`, in UTF-8 bytes. Checked on the host. */
  resultBytes: number;
  /** Wall-clock backstop for native built-ins the interrupt handler cannot reach. */
  deadlineMs: number;
  /** Intent calls (animate, preset, stagger, retime) per run; each already takes up to 50 targets. */
  maxIntentCalls: number;
}

/**
 * Calibration (Node 22.23, Linux x64, dev container): `for (;;) {}` takes about 1.3 s to reach
 * 20 000 interrupts and 270 ms to reach 2 000, i.e. about 65 us per interrupt on top of ~85 ms
 * fixed cost per run (worker + WebAssembly instance). 15 000 interrupts is therefore roughly
 * 1 s of CPU here. The count is machine independent; the milliseconds are informative only.
 */
export const SCRIPT_LIMITS: Readonly<ScriptLimits> = Object.freeze({
  sourceBytes: 65_536,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  interrupts: 15_000,
  resultBytes: 2 * 1024 * 1024,
  deadlineMs: 5_000,
  maxIntentCalls: 50,
});

export interface RunInput {
  /** TypeScript (types are erased, never compiled) or JavaScript. */
  source: string;
  /** uint32; exposed to the SDK as `__SEED`. */
  seed: number;
  /** Trusted JavaScript evaluated before the user code. Must declare `const __collect = () => <JSON string>`. */
  sdk: string;
  /** JSON value exposed to the SDK as `__DATA`. */
  data: unknown;
}

export type ScriptErrorKind =
  | "source_too_large"
  | "unsupported_typescript"
  | "syntax"
  | "runtime"
  | "async"
  | "cpu_limit"
  | "memory_limit"
  | "stack_limit"
  | "deadline"
  | "result_too_large";

export interface ScriptError {
  kind: ScriptErrorKind;
  message: string;
  /** 1-based position in the TypeScript source, when the error is located in the script. */
  line?: number;
  column?: number;
}

export type RunResult =
  | { ok: true; output: unknown; interrupts: number }
  | { ok: false; error: ScriptError; interrupts: number };

/** Mirrors `WorkerInput` in worker.ts (the worker cannot import this file). */
interface WorkerInput {
  js: string;
  sdk: string;
  seed: number;
  dataJson: string;
  memoryBytes: number;
  stackBytes: number;
  interrupts: number;
}

/** Mirrors `WorkerOutput` in worker.ts. */
type WorkerOutput =
  | { ok: true; value: unknown; interrupts: number }
  | {
      ok: false;
      kind: Exclude<
        ScriptErrorKind,
        "source_too_large" | "unsupported_typescript" | "deadline" | "result_too_large"
      >;
      message: string;
      line?: number;
      column?: number;
      interrupts: number;
    };

const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
  import.meta.url,
);

const fail = (
  kind: ScriptErrorKind,
  message: string,
  interrupts: number,
  line?: number,
  column?: number,
): RunResult => {
  const error: ScriptError = { kind, message };
  if (line !== undefined) error.line = line;
  if (column !== undefined) error.column = column;
  return { ok: false, error, interrupts };
};

const TS_HINTS: Record<string, string> = {
  enum: "enum needs code generation; scripts only allow TypeScript whose types can be erased (use a union of string literals or a const object)",
  namespace:
    "namespace needs code generation; scripts only allow TypeScript whose types can be erased (use plain objects and functions)",
  module:
    "namespace needs code generation; scripts only allow TypeScript whose types can be erased (use plain objects and functions)",
  "parameter property":
    "parameter properties need code generation; scripts only allow TypeScript whose types can be erased (declare the field and assign it in the constructor)",
};

function describeStripError(e: unknown): ScriptError {
  const err = e as { code?: unknown; message?: unknown; loc?: unknown };
  const raw = typeof err.message === "string" ? err.message : String(e);
  const lower = raw.toLowerCase();
  if (err.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
    const key = lower.includes("enum")
      ? "enum"
      : lower.includes("namespace")
        ? "namespace"
        : lower.includes("module")
          ? "module"
          : lower.includes("parameter")
            ? "parameter property"
            : undefined;
    const hint =
      (key !== undefined ? TS_HINTS[key] : undefined) ??
      `${raw}; scripts only allow TypeScript whose types can be erased`;
    return { kind: "unsupported_typescript", message: hint, ...location(raw, e) };
  }
  return { kind: "syntax", message: `SyntaxError: ${raw}`, ...location(raw, e) };
}

function location(raw: string, e: unknown): { line?: number; column?: number } {
  const loc = (e as { loc?: { line?: unknown; column?: unknown } }).loc;
  if (loc && typeof loc.line === "number") {
    return { line: loc.line, ...(typeof loc.column === "number" ? { column: loc.column } : {}) };
  }
  const m = /:(\d+):(\d+)/.exec(raw);
  return m?.[1] ? { line: Number(m[1]), column: Number(m[2]) } : {};
}

/**
 * Runs one script once in a fresh QuickJS instance inside a worker thread and returns the JSON
 * value the SDK's `__collect()` produced. Never throws for script faults.
 */
export async function runScript(
  input: RunInput,
  limits: Partial<ScriptLimits> = {},
): Promise<RunResult> {
  const lim: ScriptLimits = { ...SCRIPT_LIMITS, ...limits };

  // (1) Checked on the host before anything else.
  if (Buffer.byteLength(input.source, "utf8") > lim.sourceBytes) {
    return fail(
      "source_too_large",
      `script is larger than the ${lim.sourceBytes}-byte source limit`,
      0,
    );
  }

  // (2) Erase types on the host. Positions are preserved, so lines match the TS source.
  let js: string;
  try {
    js = stripTypeScriptTypes(input.source, { mode: "strip" });
  } catch (e) {
    const { kind, message, line, column } = describeStripError(e);
    return fail(kind, message, 0, line, column);
  }

  const workerInput: WorkerInput = {
    js,
    sdk: input.sdk,
    seed: input.seed >>> 0,
    dataJson: JSON.stringify(input.data ?? null),
    memoryBytes: lim.memoryBytes,
    stackBytes: lim.stackBytes,
    interrupts: lim.interrupts,
  };

  const outcome = await runInWorker(workerInput, lim.deadlineMs);
  if (outcome.type === "deadline") {
    return fail(
      "deadline",
      `script hit the ${lim.deadlineMs} ms wall-clock backstop (a large native built-in such as sort can run without being metered by the CPU budget)`,
      0,
    );
  }
  if (outcome.type === "died") {
    return fail("runtime", `sandbox worker stopped unexpectedly: ${outcome.reason}`, 0);
  }

  const out = outcome.output;
  if (!out.ok) return fail(out.kind, out.message, out.interrupts, out.line, out.column);

  // (9) The result limit is enforced here: a check inside the sandbox runs code the script can replace.
  // A non-string (the script tampered with what `__collect` reads) is refused with the same kind.
  const value = out.value;
  if (typeof value !== "string") {
    return fail("result_too_large", "the script result was not a JSON string", out.interrupts);
  }
  if (Buffer.byteLength(value, "utf8") > lim.resultBytes) {
    return fail(
      "result_too_large",
      `script result is larger than the ${lim.resultBytes}-byte limit`,
      out.interrupts,
    );
  }
  try {
    return { ok: true, output: JSON.parse(value) as unknown, interrupts: out.interrupts };
  } catch {
    return fail("result_too_large", "the script result was not valid JSON", out.interrupts);
  }
}

type Outcome =
  | { type: "done"; output: WorkerOutput }
  | { type: "deadline" }
  | { type: "died"; reason: string };

function runInWorker(workerData: WorkerInput, deadlineMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    // `env: {}`: the worker must not inherit the server's environment (secrets).
    const worker = new Worker(WORKER_URL, { workerData, env: {} });
    let settled = false;
    const finish = (outcome: Outcome) => {
      if (settled) return; // a completed result is never changed by the deadline or an exit
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ type: "deadline" }), deadlineMs);
    worker.once("message", (output: WorkerOutput) => finish({ type: "done", output }));
    worker.once("error", (e: Error) => finish({ type: "died", reason: e.message }));
    worker.once("exit", (code) => finish({ type: "died", reason: `exit code ${code}` }));
  });
}
