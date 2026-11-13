import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { CSP, DEV_CSP } from "./src/shared/csp.js";

const src = (path: string) => resolve(import.meta.dirname, "src", path);

// Main, preload and renderer in one config. The main build has three entries: the app (index),
// the server host that main starts in a utility process (host) and the stdio bridge that
// clients launch with ELECTRON_RUN_AS_NODE (bridge). Dependencies (@kynimo/mcp and what it
// brings: Playwright, the FFmpeg wrappers) stay external, never bundled.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: src("main/index.ts"),
          host: src("host/index.ts"),
          bridge: src("bridge/stdio-bridge.ts"),
        },
        output: {
          format: "es",
          entryFileNames: "[name].mjs",
          chunkFileNames: "chunks/[name]-[hash].mjs",
        },
      },
    },
  },
  // A sandboxed preload cannot be an ES module.
  preload: {
    build: {
      rollupOptions: {
        input: { index: src("preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: src("renderer"),
    plugins: [
      react(),
      {
        // The policy goes into the page itself: strict when built, with the dev server's needs in dev.
        name: "kynimo-csp",
        transformIndexHtml: {
          order: "pre",
          handler: (html: string, ctx: { server?: unknown }) =>
            html.replace("<!--CSP-->", () => {
              const policy = ctx.server === undefined ? CSP : DEV_CSP;
              return `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
            }),
        },
      },
    ],
    build: {
      rollupOptions: {
        input: { index: src("renderer/index.html") },
      },
    },
  },
});
