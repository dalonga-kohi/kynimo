import type { CanvasKit, CanvasKitInitOptions } from "canvaskit-wasm";
import CanvasKitModule from "canvaskit-wasm";

export type { CanvasKit } from "canvaskit-wasm";

type Init = (options: CanvasKitInitOptions) => Promise<CanvasKit>;

// canvaskit-wasm is CommonJS typed with `export default`. Under NodeNext, TypeScript types the
// default import as the module namespace, but at runtime (Node and bundlers) it is the init function.
const init = CanvasKitModule as unknown as Init;

/**
 * Loads CanvasKit (Skia WASM, pinned in package.json). Only software raster surfaces are used:
 * its GPU backend corrupts a shared WebGL2 context (ADR-0016). `locateFile` maps CanvasKit's file
 * names (`canvaskit.wasm`) to where the host serves them: a URL in the browser, a path in Node.
 */
export function loadCanvasKit(options: {
  locateFile: NonNullable<CanvasKitInitOptions["locateFile"]>;
}): Promise<CanvasKit> {
  return init({ locateFile: options.locateFile });
}
