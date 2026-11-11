import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { importSvg } from "@kynimo/svg";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testPageScript } from "./launch.test-util.js";
import { type CaptureSession, launchCapture, openCapturePage } from "./session.js";

/**
 * SVG import fidelity (ADR-0043): each fixture is imported with `importSvg`, rendered by our
 * pipeline in the pinned Chromium, and compared with the same SVG rasterized natively by that
 * Chromium (an <img> drawn on a canvas over white). Only edge anti-aliasing may differ. A failing
 * fixture writes both images and a diff to `renders/svg-fidelity/`.
 */
const SIZE = 320;
const FIXTURES = new URL("./fixtures/svg/", import.meta.url);
const RENDERS = new URL("../../../renders/svg-fidelity/", import.meta.url);

/** Fraction of pixels differing by more than `PIXEL_DELTA` (max channel), and the mean channel difference. */
const PIXEL_DELTA = 48;
const MAX_FRACTION = 0.005;
const MAX_MEAN = 1.5;

/** Per-fixture overrides: only for a documented rasterizer difference, never for a converter bug. */
const LOOSER: Record<string, { fraction?: number; mean?: number }> = {};

const NAMES = ["paths", "gradients", "transforms", "strokes", "shapes"] as const;

const prop = (value: unknown) => ({ value });

/** The document `import_svg` builds for a 320x320 SVG on a 320x320 composition, centred. */
function documentFor(svg: string): unknown {
  const result = importSvg(svg);
  expect(result.report.entries).toEqual([]); // The fixtures use only what is carried exactly.
  return {
    formatVersion: SCENE_FORMAT_VERSION,
    name: "svg fidelity",
    mainCompositionId: "main",
    style: null,
    assets: [],
    compositions: [
      {
        id: "main",
        name: "main",
        width: SIZE,
        height: SIZE,
        fps: { num: 30, den: 1 },
        durationFrames: 1,
        background: "#ffffff",
        markers: [],
        layers: [
          {
            id: "svg",
            name: "svg",
            type: "shape",
            inFrame: 0,
            outFrame: 1,
            startFrame: 0,
            hidden: false,
            solo: false,
            editor: { locked: false, shy: false, label: null },
            markers: [],
            parent: null,
            transform: {
              anchorPoint: prop(result.anchorPoint),
              position: prop([SIZE / 2, SIZE / 2]),
              scale: prop(result.scale),
              rotation: prop(0),
              skew: prop(0),
              opacity: prop(1),
            },
            blendMode: "normal",
            matte: null,
            masks: [],
            contents: result.contents,
          },
        ],
      },
    ],
  };
}

interface Comparison {
  fraction: number;
  mean: number;
  native: string;
  diff: string;
}

/** Runs in the page: decodes our PNG, rasterizes the SVG natively, and compares the RGBA pixels. */
async function compareInPage(
  page: Page,
  ours: string,
  svgBase64: string,
  size: number,
  delta: number,
) {
  return page.evaluate(
    async ({ ours, svgBase64, size, delta }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("image failed to load"));
          img.src = src;
        });
      const pixels = (img: HTMLImageElement, white: boolean) => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx === null) throw new Error("no 2d context");
        if (white) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, size, size);
        }
        ctx.drawImage(img, 0, 0, size, size);
        return ctx.getImageData(0, 0, size, size).data;
      };
      const a = pixels(await load(`data:image/png;base64,${ours}`), false);
      const nativeImage = await load(`data:image/svg+xml;base64,${svgBase64}`);
      const b = pixels(nativeImage, true);
      const diff = document.createElement("canvas");
      diff.width = size;
      diff.height = size;
      const dctx = diff.getContext("2d");
      if (dctx === null) throw new Error("no 2d context");
      const out = dctx.createImageData(size, size);
      let over = 0;
      let sum = 0;
      for (let i = 0; i < a.length; i += 4) {
        let max = 0;
        for (let c = 0; c < 4; c++) {
          const d = Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0));
          sum += d;
          if (d > max) max = d;
        }
        if (max > delta) over++;
        out.data[i] = max > delta ? 255 : 255 - Math.min(255, max * 4);
        out.data[i + 1] = max > delta ? 0 : 255 - Math.min(255, max * 4);
        out.data[i + 2] = max > delta ? 0 : 255 - Math.min(255, max * 4);
        out.data[i + 3] = 255;
      }
      dctx.putImageData(out, 0, 0);
      const native = document.createElement("canvas");
      native.width = size;
      native.height = size;
      const nctx = native.getContext("2d");
      if (nctx === null) throw new Error("no 2d context");
      nctx.drawImage(nativeImage, 0, 0, size, size);
      const flat = document.createElement("canvas");
      flat.width = size;
      flat.height = size;
      const fctx = flat.getContext("2d");
      if (fctx === null) throw new Error("no 2d context");
      fctx.fillStyle = "#fff";
      fctx.fillRect(0, 0, size, size);
      fctx.drawImage(nativeImage, 0, 0, size, size);
      const strip = (url: string) => url.slice(url.indexOf(",") + 1);
      return {
        fraction: over / (size * size),
        mean: sum / a.length,
        native: strip(flat.toDataURL("image/png")),
        diff: strip(diff.toDataURL("image/png")),
      };
    },
    { ours, svgBase64, size, delta },
  ) as Promise<Comparison>;
}

let capture: CaptureSession;
let page: Page;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  const pageScript = await testPageScript();
  capture = await launchCapture({ pageScript });
  const opened = await openCapturePage({ pageScript });
  // A plain page of the same Chromium: no scene is rendered here, only SVGs rasterized natively.
  page = opened.page;
  closeBrowser = () => opened.browser.close();
}, 60_000);
afterAll(async () => {
  await capture?.close();
  await closeBrowser?.();
});

describe("SVG import against Chromium's own rasterizer (ADR-0043)", () => {
  it.each(NAMES)(
    "%s matches the native rasterization",
    async (name) => {
      const svg = readFileSync(new URL(`${name}.svg`, FIXTURES), "utf8");
      const [frame] = await capture.captureFrames(documentFor(svg), [0]);
      if (frame === undefined) throw new Error("no frame");
      expect(frame.skipped).toEqual([]);
      expect(frame.warnings).toEqual([]);
      const ours = Buffer.from(frame.png).toString("base64");
      const result = await compareInPage(
        page,
        ours,
        Buffer.from(svg, "utf8").toString("base64"),
        SIZE,
        PIXEL_DELTA,
      );
      console.warn(
        `svg-fidelity ${name}: ${(result.fraction * 100).toFixed(3)}% of pixels differ by more than ${PIXEL_DELTA}, mean channel difference ${result.mean.toFixed(3)}`,
      );
      const limits = { fraction: MAX_FRACTION, mean: MAX_MEAN, ...LOOSER[name] };
      const ok = result.fraction < limits.fraction && result.mean < limits.mean;
      if (!ok) {
        mkdirSync(RENDERS, { recursive: true });
        writeFileSync(new URL(`${name}.ours.png`, RENDERS), frame.png);
        writeFileSync(new URL(`${name}.native.png`, RENDERS), Buffer.from(result.native, "base64"));
        writeFileSync(new URL(`${name}.diff.png`, RENDERS), Buffer.from(result.diff, "base64"));
      }
      expect({
        fraction: result.fraction < limits.fraction,
        mean: result.mean < limits.mean,
      }).toEqual({ fraction: true, mean: true });
    },
    60_000,
  );
});
