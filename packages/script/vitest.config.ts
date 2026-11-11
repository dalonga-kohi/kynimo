import { defineConfig } from "vitest/config";

// Every script run starts a worker thread and a WebAssembly instance (~100 ms, more when the
// test files run in parallel), so the default 5 s is tight for tests that run many scripts.
export default defineConfig({ test: { testTimeout: 30_000 } });
