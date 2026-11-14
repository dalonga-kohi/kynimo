import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The renderer alone, in a normal browser, with the mock `window.kynimo` and the design's demo
// content: `pnpm dev:web`, then open http://localhost:5174/?screen=welcome|connect|animations|player|empty
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  plugins: [react()],
  define: { __KYNIMO_MOCK__: true },
  server: { port: 5174, strictPort: true },
});
