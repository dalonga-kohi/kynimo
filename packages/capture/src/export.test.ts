import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { SCENE_FORMAT_VERSION, type ShaderDefinition } from "@kynimo/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchTestCapture } from "./launch.test-util.js";
import { CHECKER_PNG, DETERMINISM_ASSETS, DETERMINISM_SCENE } from "./scene.test-util.js";
import { CaptureError, type CaptureSession, type ExportSession } from "./session.js";

let capture: CaptureSession;
beforeAll(async () => {
  capture = await launchTestCapture();
}, 60_000);
afterAll(async () => {
  await capture?.close();
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const REFERENCE = new URL("../reference/", import.meta.url);
function reference(scene: string) {
  const dir = new URL(`${scene}/`, REFERENCE);
  const document = JSON.parse(readFileSync(new URL("scene.json", dir), "utf8")) as {
    assets: { id: string; type: string; uri: string }[];
  };
  const { frames } = JSON.parse(readFileSync(new URL("reference.json", dir), "utf8")) as {
    frames: number[];
  };
  const assets = new Map(
    document.assets
      .filter((a) => a.type === "image" || a.type === "font")
      .map((a) => [a.id, new Uint8Array(readFileSync(new URL(a.uri, dir)))] as const),
  );
  return { document, frames, assets };
}

async function exportAll(
  session: ExportSession,
  frames: readonly number[],
): Promise<Awaited<ReturnType<ExportSession["frame"]>>[]> {
  const out = [];
  for (const f of frames) out.push(await session.frame(f));
  return out;
}

describe("export sessions: premultiplied frames match captureFrames", () => {
  it.each([
    ["title-card", undefined],
    ["product-card", undefined],
    ["product-card", 200],
    ["components", undefined],
  ] as const)(
    "%s (maxSize %s)",
    async (scene, maxSize) => {
      const { document, frames, assets } = reference(scene);
      const captured = await capture.captureFrames(document, frames, {
        assets,
        ...(maxSize === undefined ? {} : { maxSize }),
      });
      const session = await capture.openExport(document, {
        assets,
        alpha: "premultiplied",
        ...(maxSize === undefined ? {} : { maxSize }),
      });
      try {
        const exported = await exportAll(session, frames);
        expect(
          exported.map((f) => ({ frame: f.frame, w: f.width, h: f.height, sha: sha(f.rgba) })),
        ).toEqual(
          captured.map((f) => ({ frame: f.frame, w: f.width, h: f.height, sha: f.pixelsSha256 })),
        );
        expect(session.width).toBe(captured[0]?.width);
        expect(session.height).toBe(captured[0]?.height);
        expect(exported.map((f) => [f.skipped, f.warnings])).toEqual(
          captured.map((f) => [f.skipped, f.warnings]),
        );
      } finally {
        await session.close();
      }
    },
    120_000,
  );

  it("the determinism scene, in a different frame order than captured", async () => {
    const frames = [29, 0, 12, 12];
    const captured = await capture.captureFrames(DETERMINISM_SCENE, frames, {
      assets: DETERMINISM_ASSETS,
    });
    const session = await capture.openExport(DETERMINISM_SCENE, {
      assets: DETERMINISM_ASSETS,
      alpha: "premultiplied",
    });
    try {
      const exported = await exportAll(session, frames);
      expect(exported.map((f) => sha(f.rgba))).toEqual(captured.map((f) => f.pixelsSha256));
    } finally {
      await session.close();
    }
  }, 60_000);
});

const prop = (value: unknown) => ({ value });
const layer = (
  type: string,
  fields: Record<string, unknown>,
  position: unknown = prop([8, 8]),
) => ({
  id: "l",
  name: "l",
  inFrame: 0,
  outFrame: 4,
  startFrame: 0,
  hidden: false,
  solo: false,
  editor: { locked: false, shy: false, label: null },
  markers: [],
  parent: null,
  transform: {
    anchorPoint: prop([0, 0]),
    position,
    scale: prop([1, 1]),
    rotation: prop(0),
    skew: prop(0),
    opacity: prop(0.5),
  },
  blendMode: "normal",
  matte: null,
  masks: [],
  type,
  ...fields,
});
const doc = (l: unknown, asset: unknown, background: string | null = null) => ({
  formatVersion: SCENE_FORMAT_VERSION,
  name: "Export",
  mainCompositionId: "main",
  style: null,
  assets: [asset],
  compositions: [
    {
      id: "main",
      name: "main",
      width: 32,
      height: 32,
      fps: { num: 30, den: 1 },
      durationFrames: 4,
      background,
      layers: [l],
      markers: [],
    },
  ],
});
it("exports frame-driven shader pins with the same pixels as frame capture", async () => {
  const definition: ShaderDefinition = {
    id: "custom-export",
    version: "1.0.0",
    title: "Export shader",
    kind: "generator",
    source: "return vec4(frame / 4.0, uv.x, 0.25, 1.0);",
    hash: "0".repeat(64),
    uniforms: {},
  };
  const generator = {
    type: "custom-shader",
    shaderId: definition.id,
    shaderVersion: definition.version,
    uniforms: {},
  };
  const document = {
    ...doc(layer("generator", { generator, width: 16, height: 16 }), null),
    assets: [],
  };
  const frames = [3, 0, 1];
  const shaders = [definition];
  const captured = await capture.captureFrames(document, frames, { shaders });
  const session = await capture.openExport(document, { shaders, alpha: "premultiplied" });
  try {
    expect(new Set(captured.map((frame) => frame.pixelsSha256)).size).toBe(frames.length);
    expect((await exportAll(session, frames)).map((frame) => sha(frame.rgba))).toEqual(
      captured.map((frame) => frame.pixelsSha256),
    );
  } finally {
    await session.close();
  }
}, 60_000);

const imageAsset = {
  id: "pic",
  name: "pic",
  type: "image",
  uri: "assets/checker.png",
  sha256: "5113dec02407ff3dd104d5d72ab7b0e166d26b5461e1a28f30d73565cfa336a1",
  width: 16,
  height: 16,
};
const still = doc(layer("image", { assetId: "pic" }), imageAsset);
const moving = doc(
  layer(
    "image",
    { assetId: "pic" },
    {
      keyframes: [
        { frame: 0, value: [0, 0], interpolation: { type: "linear" } },
        { frame: 3, value: [12, 0], interpolation: { type: "linear" } },
      ],
    },
  ),
  imageAsset,
);
const PIC = new Map([["pic", CHECKER_PNG]]);

/** The PNG's straight-alpha RGBA (8-bit RGBA, non-interlaced, as CanvasKit writes it). */
function decodePng(png: Uint8Array): Uint8Array {
  const buf = Buffer.from(png);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  expect([buf[24], buf[25], buf[28]]).toEqual([8, 6, 0]);
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    if (buf.toString("latin1", at + 4, at + 8) === "IDAT")
      idat.push(buf.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x] as number;
      const a = x >= 4 ? (out[y * stride + x - 4] as number) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] as number) : 0;
      const c = x >= 4 && y > 0 ? (out[(y - 1) * stride + x - 4] as number) : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter] as number;
      out[y * stride + x] = (v + predictor) & 255;
    }
  }
  return out;
}

describe("export sessions: alpha", () => {
  it("straight alpha equals the PNG's pixels; premultiplied differs only where alpha is partial", async () => {
    const [captured] = await capture.captureFrames(still, [0], { assets: PIC });
    const straight = await capture.openExport(still, { assets: PIC, alpha: "straight" });
    const premul = await capture.openExport(still, { assets: PIC, alpha: "premultiplied" });
    try {
      const s = await straight.frame(0);
      const p = await premul.frame(0);
      const fromPng = decodePng((captured as { png: Uint8Array }).png);
      expect(Buffer.from(s.rgba).equals(Buffer.from(fromPng))).toBe(true);
      expect(sha(p.rgba)).toBe((captured as { pixelsSha256: string }).pixelsSha256);
      // The image is drawn at half opacity, so its pixels are partly transparent.
      let partial = 0;
      let brighter = 0;
      for (let at = 0; at < s.rgba.length; at += 4) {
        const alpha = s.rgba[at + 3] as number;
        if (alpha === 0 || alpha === 255) continue;
        partial++;
        expect(p.rgba[at + 3]).toBe(alpha);
        for (let c = 0; c < 3; c++) {
          expect(s.rgba[at + c]).toBeGreaterThanOrEqual(p.rgba[at + c] as number);
          if ((s.rgba[at + c] as number) > (p.rgba[at + c] as number)) brighter++;
        }
      }
      expect(partial).toBeGreaterThan(0);
      expect(brighter).toBeGreaterThan(0);
      // Outside: fully transparent in both.
      expect(Array.from(s.rgba.subarray(0, 4))).toEqual([0, 0, 0, 0]);
      expect(Array.from(p.rgba.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    } finally {
      await straight.close();
      await premul.close();
    }
  }, 60_000);
});

describe("export sessions: held frames", () => {
  it("returns the same object for an identical frame, and draws when anything animates", async () => {
    const held = await capture.openExport(still, { assets: PIC, alpha: "premultiplied" });
    const anim = await capture.openExport(moving, { assets: PIC, alpha: "premultiplied" });
    try {
      const a = await held.frame(0);
      const b = await held.frame(1);
      const c = await held.frame(3);
      expect([a.repeated, b.repeated, c.repeated]).toEqual([false, true, true]);
      expect(b.rgba).toBe(a.rgba);
      expect(c.rgba).toBe(a.rgba);
      expect(b.frame).toBe(1);
      const m = await Promise.all([0, 1, 2, 3].map((f) => anim.frame(f)));
      expect(m.map((f) => f.repeated)).toEqual([false, false, false, false]);
      expect(new Set(m.map((f) => sha(f.rgba))).size).toBe(4);
      const [again] = await capture.captureFrames(moving, [2], { assets: PIC });
      expect(sha((m[2] as { rgba: Uint8Array }).rgba)).toBe(again?.pixelsSha256);
    } finally {
      await held.close();
      await anim.close();
    }
  }, 60_000);
});

describe("export sessions: grain", () => {
  const grained = (animated: boolean) =>
    doc(
      layer("solid", {
        width: 32,
        height: 32,
        color: "#336699",
        effects: [
          {
            id: "g",
            type: "grain",
            amount: prop(0.5),
            size: 1,
            seed: 7,
            animated,
            monochrome: false,
          },
        ],
      }),
      imageAsset,
    );

  it("animated grain on a static layer is drawn every frame and matches captureFrames", async () => {
    const document = grained(true);
    const frames = [0, 1, 2, 3];
    const captured = await capture.captureFrames(document, frames, { assets: PIC });
    const session = await capture.openExport(document, { assets: PIC, alpha: "premultiplied" });
    try {
      const exported = await exportAll(session, frames);
      expect(exported.map((f) => f.repeated)).toEqual([false, false, false, false]);
      expect(exported.map((f) => sha(f.rgba))).toEqual(captured.map((f) => f.pixelsSha256));
      expect(new Set(exported.map((f) => sha(f.rgba))).size).toBe(4);
    } finally {
      await session.close();
    }
  }, 60_000);

  it("static grain on a static layer is repeated", async () => {
    const session = await capture.openExport(grained(false), {
      assets: PIC,
      alpha: "premultiplied",
    });
    try {
      const exported = await exportAll(session, [0, 1, 2]);
      expect(exported.map((f) => f.repeated)).toEqual([false, true, true]);
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe("export sessions: video frames", () => {
  const video = doc(layer("video", { assetId: "clip" }, prop([8, 8])), {
    id: "clip",
    name: "clip",
    type: "video",
    uri: `assets/${"0".repeat(64)}.json`,
    sha256: "0".repeat(64),
    width: 16,
    height: 16,
    fps: { num: 15, den: 1 },
    frameCount: 1,
  });

  it("uses the frames supplied per call and releases the rest", async () => {
    const captured = await capture
      .captureFrames(video, [0, 2], {
        videoFrames: new Map([["clip/0", CHECKER_PNG]]),
      })
      .catch(() => undefined);
    const session = await capture.openExport(video, { alpha: "premultiplied" });
    try {
      const frames = new Map([["clip/0", CHECKER_PNG]]);
      const f0 = await session.frame(0, frames);
      const f1 = await session.frame(1, frames);
      expect(f1.repeated).toBe(true);
      if (captured) expect(sha(f0.rgba)).toBe(captured[0]?.pixelsSha256);
      // Past the clip nothing is shown, so no frame is needed; the earlier one is released.
      const f2 = await session.frame(2);
      expect(f2.repeated).toBe(false);
      expect(sha(f2.rgba)).not.toBe(sha(f0.rgba));
      await expect(session.frame(0)).rejects.toThrow(/was not loaded/);
    } finally {
      await session.close();
    }
  }, 60_000);

  it("refuses frames that do not belong to a video asset", async () => {
    const session = await capture.openExport(video, { alpha: "premultiplied" });
    try {
      await expect(session.frame(0, new Map([["pic/0", CHECKER_PNG]]))).rejects.toThrow(
        CaptureError,
      );
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe("export sessions: lifecycle", () => {
  it("validates like captureFrames", async () => {
    const open = (
      document: unknown,
      o: Partial<Parameters<CaptureSession["openExport"]>[1]> = {},
    ) => capture.openExport(document, { alpha: "premultiplied", ...o });
    await expect(open({ nope: true })).rejects.toThrow(/the document is invalid/);
    await expect(open(still, { maxSize: 0 })).rejects.toThrow(/maxSize must be a positive integer/);
    await expect(open(still, { maxSize: 1.5 })).rejects.toThrow(CaptureError);
    await expect(open(still, { composition: "nope" })).rejects.toThrow(/unknown composition/);
    await expect(open(still, { assets: new Map([["other", CHECKER_PNG]]) })).rejects.toThrow(
      /is not an image or font asset/,
    );
    await expect(open(still, { alpha: "weird" as never })).rejects.toThrow(/alpha must be/);
    // A wrong pin is reported by the page when the export opens.
    await expect(
      open(still, { assets: new Map([["pic", new Uint8Array([1, 2, 3])]]) }),
    ).rejects.toThrow(CaptureError);
  }, 60_000);

  it("reports a bad frame number and keeps working", async () => {
    const session = await capture.openExport(still, { assets: PIC, alpha: "premultiplied" });
    try {
      await expect(session.frame(99)).rejects.toThrow(/frame must be an integer/);
      expect((await session.frame(0)).repeated).toBe(false);
    } finally {
      await session.close();
    }
  }, 60_000);

  it("lets captureFrames run while an export is open, interleaved", async () => {
    const session = await capture.openExport(moving, { assets: PIC, alpha: "premultiplied" });
    try {
      const e0 = await session.frame(0);
      const [c] = await capture.captureFrames(moving, [3], { assets: PIC });
      const e3 = await session.frame(3);
      expect(sha(e3.rgba)).toBe(c?.pixelsSha256);
      expect(e0.repeated).toBe(false);
      // Concurrent calls on one export are queued, not interleaved.
      const both = await Promise.all([session.frame(1), session.frame(2)]);
      expect(both.map((f) => f.frame)).toEqual([1, 2]);
    } finally {
      await session.close();
    }
  }, 60_000);

  it("closing the capture session closes its exports", async () => {
    const own = await launchTestCapture();
    const session = await own.openExport(still, { assets: PIC, alpha: "premultiplied" });
    await session.frame(0);
    await own.close();
    expect(session.closed).toBe(true);
    await expect(session.frame(1)).rejects.toThrow(CaptureError);
    await expect(own.openExport(still, { alpha: "premultiplied" })).rejects.toThrow(/closed/);
  }, 120_000);

  it("rejects frames once the export is closed", async () => {
    const session = await capture.openExport(still, { assets: PIC, alpha: "premultiplied" });
    await session.close();
    expect(session.closed).toBe(true);
    await expect(session.frame(0)).rejects.toThrow(/closed/);
    await session.close();
  }, 60_000);
});

describe("export speed (informational)", () => {
  it("records ms per frame for the raw export and for captureFrames on product-card", async () => {
    const { document, assets } = reference("product-card");
    const session = await capture.openExport(document, { assets, alpha: "premultiplied" });
    try {
      const n = 10;
      let t = performance.now();
      for (let f = 0; f < n; f++) await session.frame(f);
      const exportMs = (performance.now() - t) / n;
      t = performance.now();
      for (let f = 0; f < n; f++) await capture.captureFrames(document, [f], { assets });
      const captureMs = (performance.now() - t) / n;
      console.info(
        `product-card ${session.width}x${session.height}: export ${exportMs.toFixed(0)} ms/frame, captureFrames(1 frame) ${captureMs.toFixed(0)} ms/frame`,
      );
    } finally {
      await session.close();
    }
  }, 120_000);
});
