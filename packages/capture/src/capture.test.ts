import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { loadCanvasKit } from "@kynimo/renderer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchTestCapture } from "./launch.test-util.js";
import { DETERMINISM_ASSETS, DETERMINISM_SCENE } from "./scene.test-util.js";
import { type CapturedFrame, CaptureError, type CaptureSession } from "./session.js";

/**
 * Golden hashes of the determinism scene (ADR-0016). They hold only for the pins they record:
 * bumping Chromium (Playwright), CanvasKit or a bundled font regenerates them in the same PR, with
 * `KYNIMO_UPDATE_GOLDEN=1 pnpm --filter @kynimo/capture test`. A mismatch writes the frames to
 * `renders/capture/` so a person can look at what changed.
 */
const GOLDEN_FILE = new URL("../golden/determinism.json", import.meta.url);
const UPDATE = process.env.KYNIMO_UPDATE_GOLDEN === "1";
const FRAMES = [0, 12, 29];

interface Golden {
  chromium: string;
  frames: Record<string, { pixelsSha256: string; pngSha256: string }>;
}

let capture: CaptureSession;
beforeAll(async () => {
  capture = await launchTestCapture();
}, 60_000);
afterAll(async () => {
  await capture?.close();
});

const render = (frames = FRAMES, session = capture) =>
  session.captureFrames(DETERMINISM_SCENE, frames, { assets: DETERMINISM_ASSETS });

const hashes = (frames: CapturedFrame[]) =>
  Object.fromEntries(
    frames.map((f) => [String(f.frame), { pixelsSha256: f.pixelsSha256, pngSha256: f.pngSha256 }]),
  );

describe("captureFrames: determinism (ADR-0016)", () => {
  it("matches the golden hashes", async () => {
    const frames = await render();
    const actual: Golden = { chromium: capture.browserVersion, frames: hashes(frames) };
    if (UPDATE) {
      writeFileSync(GOLDEN_FILE, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Golden;
    try {
      expect(actual).toEqual(golden);
    } catch (error) {
      const out = new URL("../../../renders/capture/", import.meta.url);
      mkdirSync(out, { recursive: true });
      for (const f of frames) writeFileSync(new URL(`frame-${f.frame}.png`, out), f.png);
      throw error;
    }
  }, 60_000);

  it("renders identical bytes in any order, and after a fresh browser launch", async () => {
    const first = hashes(await render());
    expect(hashes(await render([...FRAMES].reverse()))).toEqual(first);
    const fresh = await launchTestCapture();
    try {
      expect(hashes(await render(FRAMES, fresh))).toEqual(first);
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it("is not identical by being blank: frames differ and report what they drew", async () => {
    const frames = await render();
    expect(new Set(frames.map((f) => f.pixelsSha256)).size).toBe(FRAMES.length);
    for (const f of frames) {
      expect([f.width, f.height]).toEqual([320, 180]);
      expect(f.skipped).toEqual([]);
      // The scene's "ﬁ" ligature character is not in Inter: drawn with, and reported as, fallback.
      expect(f.warnings).toEqual([
        expect.objectContaining({ id: "title", kind: "font-fallback", codepoints: [0xfb01] }),
      ]);
    }
  }, 60_000);
});

describe("captureFrames: PNG output", () => {
  const require = createRequire(import.meta.url);
  const bin = dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));

  it("decodes back to exactly the hashed pixels", async () => {
    const ck = await loadCanvasKit({ locateFile: (file) => join(bin, file) });
    for (const f of await render()) {
      expect(f.pngSha256).toBe(createHash("sha256").update(f.png).digest("hex"));
      const image = ck.MakeImageFromEncoded(f.png);
      if (image === null) throw new Error("the PNG does not decode");
      try {
        expect([image.width(), image.height()]).toEqual([f.width, f.height]);
        const pixels = image.readPixels(0, 0, {
          width: f.width,
          height: f.height,
          colorType: ck.ColorType.RGBA_8888,
          alphaType: ck.AlphaType.Premul,
          colorSpace: ck.ColorSpace.SRGB,
        });
        if (!(pixels instanceof Uint8Array)) throw new Error("no pixels");
        // The background is opaque, so un-premultiplying for the file loses nothing.
        expect(createHash("sha256").update(pixels).digest("hex")).toBe(f.pixelsSha256);
      } finally {
        image.delete();
      }
    }
  }, 60_000);
});

describe("captureFrames: errors", () => {
  const fails = async (promise: Promise<unknown>, message: RegExp, pageError: string | null) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CaptureError);
    expect((error as CaptureError).message).toMatch(message);
    expect((error as CaptureError).pageError).toBe(pageError);
  };

  it("refuses an invalid document with every schema error's path", async () => {
    await fails(
      capture.captureFrames({ ...DETERMINISM_SCENE, mainCompositionId: 7 }, [0]),
      /document is invalid: mainCompositionId: /,
      null,
    );
  });

  it("refuses an empty frame list, out-of-range frames and unknown compositions", async () => {
    await fails(render([]), /at least one frame/, null);
    await fails(render([30]), /frame must be an integer from 0 to 29/, "RangeError");
    await fails(
      capture.captureFrames(DETERMINISM_SCENE, [0], { composition: "nope" }),
      /unknown composition 'nope'/,
      "RangeError",
    );
  });

  it("refuses asset bytes the document does not declare, or that do not match its pin", async () => {
    await fails(
      capture.captureFrames(DETERMINISM_SCENE, [0], {
        assets: new Map([["other", new Uint8Array()]]),
      }),
      /'other' is not an image or font asset/,
      null,
    );
    await fails(
      capture.captureFrames(DETERMINISM_SCENE, [0], {
        assets: new Map([["checker", new Uint8Array([1, 2, 3])]]),
      }),
      /asset 'checker': bytes hash to .*, but the document pins/,
      "ImageAssetError",
    );
  });

  it("reports an image layer whose asset bytes were not given", async () => {
    await fails(
      capture.captureFrames(DETERMINISM_SCENE, [0]),
      /'pic' shows image asset 'checker', which was not loaded/,
      "RenderError",
    );
  });

  it("keeps working after a failed call, and runs concurrent calls one at a time", async () => {
    const [a, b] = await Promise.all([render([0]), render([29]), render([]).catch(() => null)]);
    const [c] = await render([0, 29]).then((f) => [hashes(f)]);
    expect({ ...hashes(a ?? []), ...hashes(b ?? []) }).toEqual(c);
  }, 60_000);
});
