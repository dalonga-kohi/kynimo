import { defineConfig } from "vite";

// The capture page bundle (src/page.ts) as one classic script defining `KynimoCapture`. It runs
// in the pinned Chromium, never in Node; tsc builds the Node host next to it. Vite notes that it
// stubs `fs` and `path` for CanvasKit: CanvasKit only reaches them when it runs under Node.
export default defineConfig({
  build: {
    outDir: "dist/page",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: "src/page.ts",
      formats: ["iife"],
      name: "KynimoCapture",
      fileName: () => "capture.js",
    },
  },
});
