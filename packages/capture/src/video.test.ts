import { SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchTestCapture } from "./launch.test-util.js";
import { CHECKER_PNG } from "./scene.test-util.js";
import { CaptureError, type CaptureSession } from "./session.js";

let capture: CaptureSession;
beforeAll(async () => {
  capture = await launchTestCapture();
}, 60_000);
afterAll(async () => {
  await capture?.close();
});

const SHA = "5113dec02407ff3dd104d5d72ab7b0e166d26b5461e1a28f30d73565cfa336a1";
const prop = (value: unknown) => ({ value });
const layer = (type: string, fields: Record<string, unknown>) => ({
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
    position: prop([8, 8]),
    scale: prop([1, 1]),
    rotation: prop(0),
    skew: prop(0),
    opacity: prop(1),
  },
  blendMode: "normal",
  matte: null,
  masks: [],
  type,
  ...fields,
});
const doc = (l: unknown, asset: unknown) => ({
  formatVersion: SCENE_FORMAT_VERSION,
  name: "Video",
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
      background: "#000000",
      layers: [l],
      markers: [],
    },
  ],
});

const image = doc(layer("image", { assetId: "pic" }), {
  id: "pic",
  name: "pic",
  type: "image",
  uri: "assets/checker.png",
  sha256: SHA,
  width: 16,
  height: 16,
});
const video = doc(layer("video", { assetId: "clip" }), {
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

describe("video layers in the capture page", () => {
  it("draw a supplied frame exactly like an image of the same bytes, and nothing past the clip", async () => {
    const [still] = await capture.captureFrames(image, [0], {
      assets: new Map([["pic", CHECKER_PNG]]),
    });
    const frames = await capture.captureFrames(video, [0, 1, 2], {
      videoFrames: new Map([["clip/0", CHECKER_PNG]]),
    });
    expect(frames.map((f) => f.pixelsSha256 === still?.pixelsSha256)).toEqual([true, true, false]);
    expect(frames.every((f) => f.skipped.length === 0)).toBe(true);
  }, 60_000);

  it("refuses frames that do not belong to a video asset, and reports missing ones", async () => {
    await expect(
      capture.captureFrames(video, [0], { videoFrames: new Map([["pic/0", CHECKER_PNG]]) }),
    ).rejects.toThrow(CaptureError);
    await expect(
      capture.captureFrames(video, [0], { videoFrames: new Map([["clip/x", CHECKER_PNG]]) }),
    ).rejects.toThrow(/does not name a frame/);
    await expect(capture.captureFrames(video, [0])).rejects.toThrow(
      /frame 0 of video asset 'clip', which was not loaded/,
    );
  }, 60_000);
});
