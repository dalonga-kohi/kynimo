import { resolve } from "node:path";
import { defineConfig } from "vite";

// The stdio bridge as one self-contained file (out/main/bridge.mjs), run by clients with
// ELECTRON_RUN_AS_NODE. It ships next to the app, outside the asar archive, so it cannot share
// chunks with the main build: it has its own build, which runs after electron-vite's.
export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, "src/bridge/stdio-bridge.ts"),
    outDir: resolve(import.meta.dirname, "out/main"),
    emptyOutDir: false,
    target: "node24",
    minify: false,
    rollupOptions: { output: { format: "es", entryFileNames: "bridge.mjs" } },
  },
});
