import { describe, expect, it } from "vitest";
import { type RunResult, runScript, SCRIPT_LIMITS } from "./index.js";

/** A tiny SDK that records pushed values and exposes the seed and data. */
const SDK = `
"use strict";
const __out = [];
Object.defineProperty(globalThis, "rec", { value: Object.freeze({
  push: (v) => { __out.push(v); },
  seed: () => __SEED,
  data: () => __DATA,
}) });
const __collect = () => JSON.stringify(__out);
`;

const run = (source: string, seed = 1, data: unknown = null, limits = {}) =>
  runScript({ source, seed, sdk: SDK, data }, limits);

const errorOf = (r: RunResult) => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.output)}`);
  return r.error;
};

describe("runScript", () => {
  it("runs TypeScript with types and returns what the SDK collected", async () => {
    const r = await run(`
interface Chip { label: string; width: number }
const chips: Chip[] = [{ label: "a", width: 10 }, { label: "b", width: 20 }];
for (const c of chips as Chip[]) rec.push(c satisfies Chip);
`);
    expect(r).toMatchObject({
      ok: true,
      output: [
        { label: "a", width: 10 },
        { label: "b", width: 20 },
      ],
    });
  });

  it("is repeatable and exposes __SEED and __DATA", async () => {
    const source = "rec.push({ seed: rec.seed(), data: rec.data(), sum: rec.data().n * 2 });";
    for (let seed = 0; seed < 20; seed++) {
      const a = await run(source, seed, { n: seed, s: "x '`${}" });
      const b = await run(source, seed, { n: seed, s: "x '`${}" });
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(JSON.stringify(a.output)).toBe(JSON.stringify(b.output));
        expect(a.output).toEqual([{ seed, data: { n: seed, s: "x '`${}" }, sum: seed * 2 }]);
      }
    }
  });

  it("exposes nothing ambient", async () => {
    const r = await run(`rec.push({
      Date: typeof Date, random: typeof Math.random, fetch: typeof fetch, require: typeof require,
      process: typeof process, setTimeout: typeof setTimeout, performance: typeof performance,
      WebAssembly: typeof WebAssembly, console: typeof console, WeakRef: typeof WeakRef,
      FinalizationRegistry: typeof FinalizationRegistry,
    });`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const seen = (r.output as Record<string, string>[])[0] ?? {};
      expect(Object.keys(seen)).toHaveLength(11);
      expect(Object.values(seen).every((t) => t === "undefined")).toBe(true);
    }
  });

  it("refuses import() as pending async work", async () => {
    const e = errorOf(await run(`import("node:fs");`));
    expect(e.kind).toBe("async");
    expect(e.message).toMatch(/synchronous/);
  });

  it("refuses import and export statements with a modules message", async () => {
    for (const source of [`import x from "y";`, `import { a } from "y";`, "export const a = 1;"]) {
      const e = errorOf(await run(source));
      expect(e.kind).toBe("syntax");
      expect(e.message).toBe(
        "scripts are not modules: no import or export; the SDK is the global `kynimo`",
      );
    }
    const e = errorOf(await run("const a = 1;\nexport const b = 2;"));
    expect(e.line).toBe(2);
  });

  it("reports ordinary syntax errors", async () => {
    const e = errorOf(await run("const a = ;"));
    expect(e.kind).toBe("syntax");
    expect(e.message).not.toMatch(/modules/);
  });

  it("interrupts an endless loop at the same count every time", async () => {
    const a = await run("for (;;) {}");
    const b = await run("for (;;) {}");
    expect(errorOf(a).kind).toBe("cpu_limit");
    expect(errorOf(b).kind).toBe("cpu_limit");
    expect(a.interrupts).toBe(b.interrupts);
    expect(a.interrupts).toBe(SCRIPT_LIMITS.interrupts + 1);
  });

  it("stops memory blowups and runaway recursion, and later runs are unaffected", async () => {
    const source = "rec.push(rec.data().n);";
    const before = await run(source, 1, { n: 5 });
    const mem = await run("const a = []; for (;;) a.push(new Array(1e5).fill(1));");
    expect(errorOf(mem).kind).toBe("memory_limit");
    const deep = await run("const f = () => f(); f();");
    expect(errorOf(deep).kind).toBe("stack_limit");
    const after = await run(source, 1, { n: 5 });
    expect(before.ok && after.ok).toBe(true);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("cannot rebind __collect or replace a frozen SDK global", async () => {
    const e = errorOf(await run("__collect = () => '[1]';"));
    expect(e.kind).toBe("runtime");
    const r = await run(`
      try { rec.push = () => {}; } catch {}
      try { (globalThis as any).rec = {}; } catch {}
      rec.push(1);`);
    expect(r).toMatchObject({ ok: true, output: [1] });
  });

  it("enforces the result limit on the host even if the script replaces JSON.stringify", async () => {
    const r = await run(`JSON.stringify = () => "x".repeat(3 * 1024 * 1024);`, 1, null, {
      memoryBytes: 64 * 1024 * 1024,
    });
    expect(errorOf(r).kind).toBe("result_too_large");
  });

  it("refuses a result that is not a string", async () => {
    const r = await runScript({
      source: "",
      seed: 1,
      data: null,
      sdk: "const __collect = () => ({ not: 'a string' });",
    });
    expect(errorOf(r).kind).toBe("result_too_large");
  });

  it("refuses oversized sources before spawning anything", async () => {
    const r = await run(`// ${"x".repeat(SCRIPT_LIMITS.sourceBytes)}`);
    expect(errorOf(r).kind).toBe("source_too_large");
    expect(r.interrupts).toBe(0);
  });

  it("counts source size in bytes, not characters", async () => {
    const r = await run("// ééé", 1, null, { sourceBytes: 6 });
    expect(errorOf(r).kind).toBe("source_too_large");
  });

  it("refuses pending promise work", async () => {
    const e = errorOf(await run("Promise.resolve().then(() => rec.push('late'));"));
    expect(e.kind).toBe("async");
  });

  it("reports runtime errors at the TypeScript line", async () => {
    const e = errorOf(
      await run(`interface A { x: number }
const a: A = { x: 1 };
throw new Error("boom");`),
    );
    expect(e.kind).toBe("runtime");
    expect(e.message).toBe("Error: boom");
    expect(e.line).toBe(3);
    expect(typeof e.column).toBe("number");
  });

  it("reports a thrown non-Error as a runtime error", async () => {
    const e = errorOf(await run(`throw "plain";`));
    expect(e.kind).toBe("runtime");
    expect(e.message).toContain("plain");
  });

  it("refuses TypeScript that needs code generation", async () => {
    const cases: [string, RegExp][] = [
      ["enum A { B }", /enum/],
      ["namespace N { export const a = 1 }", /namespace/],
      ["class C { constructor(private x: number) {} }", /parameter propert/],
    ];
    for (const [source, re] of cases) {
      const e = errorOf(await run(source));
      expect(e.kind).toBe("unsupported_typescript");
      expect(e.message).toMatch(re);
      expect(e.message).toMatch(/erased/);
    }
  });

  it("reports invalid TypeScript as a syntax error", async () => {
    const e = errorOf(await run("const a: = 1;"));
    expect(e.kind).toBe("syntax");
  });

  it("falls back to the wall-clock deadline", async () => {
    const r = await run("for (;;) {}", 1, null, {
      interrupts: Number.MAX_SAFE_INTEGER,
      deadlineMs: 100,
    });
    const e = errorOf(r);
    expect(e.kind).toBe("deadline");
    expect(e.message).toMatch(/wall-clock/);
  });

  it("does not let a generous deadline change a completed result", async () => {
    const r = await run("rec.push(1);", 1, null, { deadlineMs: 20_000 });
    expect(r).toMatchObject({ ok: true, output: [1] });
  });
});
