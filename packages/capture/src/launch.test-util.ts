import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type CaptureSession, launchCapture } from "./session.js";

const root = fileURLToPath(new URL("..", import.meta.url));
let bundle: Promise<string> | undefined;

/** The page bundled from the current sources, so tests never run a stale `dist`. */
function pageScript(): Promise<string> {
  bundle ??= (async () => {
    const result = await build({ root, logLevel: "silent", build: { write: false } });
    for (const output of Array.isArray(result) ? result : [result])
      if ("output" in output)
        for (const chunk of output.output) if (chunk.type === "chunk") return chunk.code;
    throw new Error("vite produced no capture page bundle");
  })();
  return bundle;
}

export const launchTestCapture = async (): Promise<CaptureSession> =>
  launchCapture({ pageScript: await pageScript() });
