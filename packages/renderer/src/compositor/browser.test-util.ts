import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { build } from "vite";
import type { FramePlan, RasterImage } from "../raster.js";
import type { CompositePrefix } from "./webgl.js";

/** The worker launch flags (ADR-0016): WebGL2 on SwiftShader, never the host GPU. */
export const CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

const entry = fileURLToPath(new URL("./webgl.ts", import.meta.url));

/** The compositor bundled as one classic script that defines `KynimoCompositor`. */
async function bundle(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ["iife"], name: "KynimoCompositor", fileName: "compositor" },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs)
    if ("output" in output)
      for (const chunk of output.output) if (chunk.type === "chunk") return chunk.code;
  throw new Error("vite produced no compositor bundle");
}

export interface GpuSession {
  browser: Browser;
  page: Page;
  renderer: string;
  /** `prefix` saves or reuses the plan's bottom layers, as in the compositor. */
  composite(plan: FramePlan, prefix?: CompositePrefix): Promise<RasterImage>;
  close(): Promise<void>;
}

/**
 * Launches the pinned Chromium on SwiftShader with the compositor loaded into a blank page. Plans
 * cross into the page as JSON, with byte arrays as base64.
 */
export async function launchGpu(): Promise<GpuSession> {
  const code = await bundle();
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>compositor</title>");
  await page.addScriptTag({ content: code });
  const renderer = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false });
    if (gl === null) throw new Error("no WebGL2");
    const g = globalThis as unknown as {
      KynimoCompositor: { createCompositor(gl: WebGL2RenderingContext): unknown };
      compositor: { renderer: string };
    };
    g.compositor = g.KynimoCompositor.createCompositor(gl) as { renderer: string };
    return g.compositor.renderer;
  });
  return {
    browser,
    page,
    renderer,
    async composite(plan, prefix) {
      const json = JSON.stringify(plan, (_key, value) =>
        value instanceof Uint8Array ? { __bytes: Buffer.from(value).toString("base64") } : value,
      );
      const out = await page.evaluate(
        ([input, reuse]) => {
          const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const parsed = JSON.parse(input, (_key, value) =>
            value !== null && typeof value === "object" && "__bytes" in value
              ? decode(value.__bytes as string)
              : value,
          );
          const g = globalThis as unknown as {
            compositor: {
              composite(
                p: unknown,
                prefix?: unknown,
              ): { width: number; height: number; pixels: Uint8Array };
            };
          };
          const r = g.compositor.composite(parsed, reuse ?? undefined);
          let s = "";
          for (const byte of r.pixels) s += String.fromCharCode(byte);
          return { width: r.width, height: r.height, pixels: btoa(s) };
        },
        [json, prefix ?? null] as const,
      );
      return {
        width: out.width,
        height: out.height,
        pixels: new Uint8Array(Buffer.from(out.pixels, "base64")),
      };
    },
    close: () => browser.close(),
  };
}
