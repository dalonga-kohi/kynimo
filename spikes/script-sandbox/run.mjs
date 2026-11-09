// ADR-0036 spike: can agent-written TypeScript run once, safely and repeatably, and
// produce a batch of scene operations? Exits non-zero if any PASS check fails.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { performance } from "node:perf_hooks";
import { newQuickJSWASMModule } from "quickjs-emscripten";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The SDK, as source evaluated inside the sandbox. It only records ops; the host validates and applies them. */
const SDK = `
"use strict";
const __ops = [];
let __n = 0;
let __seed = __SEED >>> 0;
const __rand = () => {
  // mulberry32: seeded, identical in every engine.
  __seed = (__seed + 0x6d2b79f5) >>> 0;
  let t = __seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const __layer = (composition, id) => ({
  id,
  set(property, value) {
    __ops.push({ type: "setProperty", composition, layer: id, property, value });
    return this;
  },
  animate(property, spec) {
    __ops.push({ type: "animate", composition, layer: id, property, ...spec });
    return this;
  },
});
Object.defineProperty(globalThis, "kynimo", { writable: false, configurable: false, value: Object.freeze({
  random: __rand,
  composition(id) {
    const info = __DOC.compositions[id];
    if (!info) throw new Error("no composition '" + id + "'");
    return {
      id, fps: info.fps, width: info.width, height: info.height, frames: info.frames,
      text(content, props) {
        const layerId = "s" + (++__n);
        __ops.push({ type: "addLayer", composition: id, layer: { id: layerId, type: "text", content, ...props } });
        return __layer(id, layerId);
      },
    };
  },
}) });
`;

const LIMITS = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  interrupts: 2000,
  maxOps: 5000,
};

/**
 * Runs one script in a fresh runtime. The budget counts interrupt-handler calls (QuickJS
 * calls it every fixed number of branches), not wall-clock time, so the same script
 * stops at the same point on a fast and a slow machine.
 */
async function runScript(source, { seed = 1, typescript = true } = {}) {
  const js = typescript ? stripTypeScriptTypes(source, { mode: "strip" }) : source;
  // A fresh WebAssembly instance per run: a script that exhausts memory leaves QuickJS unable
  // to free its runtime (the module aborts), so no instance is ever shared between scripts.
  const QuickJS = await newQuickJSWASMModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(LIMITS.memoryBytes);
  runtime.setMaxStackSize(LIMITS.stackBytes);
  let ticks = 0;
  runtime.setInterruptHandler(() => ++ticks > LIMITS.interrupts);
  const vm = runtime.newContext();
  try {
    const evalOrThrow = (code, file) => {
      const r = vm.evalCode(code, file);
      if (r.error) {
        const err = vm.dump(r.error);
        r.error.dispose();
        throw Object.assign(new Error(err?.message ?? String(err)), { name: err?.name ?? "Error" });
      }
      const v = vm.dump(r.value);
      r.value.dispose();
      return v;
    };
    // Remove the two ambient sources of non-determinism before any user code runs.
    evalOrThrow(
      `delete globalThis.Date; Math.random = undefined; delete Math.random;
       const __SEED = ${seed};
       const __DOC = ${JSON.stringify({ compositions: { main: { fps: 30, width: 1920, height: 1080, frames: 300 } } })};`,
      "prelude.js",
    );
    evalOrThrow(SDK, "sdk.js");
    evalOrThrow(js, "script.ts");
    const json = evalOrThrow(
      `if (__ops.length > ${LIMITS.maxOps}) throw new RangeError("too many ops"); JSON.stringify(__ops)`,
      "collect.js",
    );
    return { ok: true, ops: JSON.parse(json), json, ticks };
  } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}`, ticks };
  } finally {
    // After a limit was hit, disposal can abort the instance. It is dropped either way.
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      disposeAborts++;
    }
  }
}

let failed = 0;
let disposeAborts = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const info = (name, detail) => console.log(`INFO  ${name}  — ${detail}`);

const example = readFileSync(new URL("./script.example.ts", import.meta.url), "utf8");

// 1. A realistic script produces a batch of ops.
const first = await runScript(example, { seed: 7 });
check(
  "1. TypeScript script → ops batch",
  first.ok && first.ops.length === 14,
  first.ok
    ? `${first.ops.length} ops, ${first.json.length} bytes of ops from ${example.length} bytes of script`
    : first.error,
);

// 2. Same script + same seed → identical bytes, in fresh runtimes; another seed differs.
const again = await runScript(example, { seed: 7 });
const other = await runScript(example, { seed: 8 });
check(
  "2. Repeatable: same seed → same bytes",
  first.json === again.json,
  `sha256 ${sha(first.json ?? "")}`,
);
check("2b. Seeded: another seed → other bytes", other.ok && other.json !== first.json);

// 3. Nothing ambient is reachable.
const probe = await runScript(
  `kynimo.composition("main").text(JSON.stringify({
     Date: typeof Date, random: typeof Math.random, fetch: typeof fetch, require: typeof require,
     process: typeof process, setTimeout: typeof setTimeout, performance: typeof performance,
     importFn: typeof globalThis.import, WebAssembly: typeof WebAssembly, console: typeof console,
   }), {});`,
  { typescript: false },
);
const seen = probe.ok ? JSON.parse(probe.ops[0].layer.content) : {};
check(
  "3. No clock, random, network, host or timers",
  probe.ok && Object.values(seen).every((t) => t === "undefined"),
  JSON.stringify(seen),
);
const dyn = await runScript(
  `import("node:fs").then(() => {}); kynimo.composition("main").text("x", {});`,
  { typescript: false },
);
info(
  "3b. dynamic import()",
  dyn.ok ? "evaluates, but no module loader is installed, so it can never resolve" : dyn.error,
);

// 4. CPU: an endless loop is stopped by the budget, at the same tick count every time.
const t0 = performance.now();
const loopA = await runScript("for (;;) {}", { typescript: false });
const loopMs = performance.now() - t0;
const loopB = await runScript("for (;;) {}", { typescript: false });
check(
  "4. Endless loop is interrupted",
  !loopA.ok && /interrupted/.test(loopA.error),
  `${loopA.error} after ${loopMs.toFixed(0)} ms`,
);
check(
  "4b. Budget is counted, not timed",
  loopA.ticks === loopB.ticks,
  `${loopA.ticks} ticks both runs`,
);

// 5. Memory and stack limits fail the script, not the process.
const mem = await runScript("const a = []; for (;;) a.push(new Array(1e5).fill(1));", {
  typescript: false,
});
check("5. Memory limit", !mem.ok, mem.error);
const deep = await runScript("const f = () => f(); f();", { typescript: false });
check("5b. Stack limit", !deep.ok, deep.error);

// 5c. After those failures a new script still runs: nothing was shared with the broken instances.
const after = await runScript(example, { seed: 7 });
check(
  "5c. Failures don't affect later scripts",
  after.ok && after.json === first.json,
  `${disposeAborts} instance(s) aborted on cleanup and were dropped`,
);

// 6. The script can't replace the SDK. (What it can do is push odd ops; the host validates
// every op against the scene schemas before applying, so the SDK is a convenience, not the boundary.)
const tamper = await runScript(
  `kynimo.random = () => 4; try { kynimo = {}; } catch {}
   kynimo.composition("main").text(String(kynimo.random()), {});`,
  { typescript: false },
);
check(
  "6. SDK can't be replaced",
  tamper.ok && tamper.ops[0].layer.content !== "4",
  tamper.ok ? `random() = ${tamper.ops[0].layer.content}` : tamper.error,
);

// 7. Errors point into the script.
const bad = await runScript(`kynimo.composition("nope");`, { typescript: false });
check("7. Errors are reported", !bad.ok && /no composition/.test(bad.error), bad.error);

// 8. TypeScript that needs code generation is refused (types are erased, never compiled).
let enumError = "";
try {
  stripTypeScriptTypes("enum A { B }", { mode: "strip" });
} catch (e) {
  enumError = e.code ?? e.message;
}
check("8. Non-erasable TypeScript is refused", enumError !== "", enumError);

// 9. Cost.
const N = 50;
const t1 = performance.now();
for (let i = 0; i < N; i++) await runScript(example, { seed: i });
info(
  "9. Cost per run (fresh WebAssembly instance + SDK + script)",
  `${((performance.now() - t1) / N).toFixed(2)} ms average over ${N} runs`,
);

process.exit(failed ? 1 : 0);
