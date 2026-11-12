import { readFileSync } from "node:fs";
import { applyOps, migrateProject, type Project } from "@kynimo/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchTestCapture } from "./launch.test-util.js";
import type { CaptureSession } from "./session.js";

const SCENE = new URL("../reference/masked-matted-reveal/scene.json", import.meta.url);

let capture: CaptureSession;
beforeAll(async () => {
  capture = await launchTestCapture();
}, 60_000);
afterAll(async () => {
  await capture?.close();
});

describe("precompose", () => {
  it("leaves every pixel as it was", async () => {
    const migrated = migrateProject(JSON.parse(readFileSync(SCENE, "utf8")));
    if (!migrated.ok) throw new Error(JSON.stringify(migrated.errors));
    const before = migrated.doc;
    const result = applyOps(before, [
      // Mattes inside the selection move with it; a masked layer on its own; layers in between stay.
      { op: "precompose", layers: ["ink", "headline", "underline", "sweep"] },
      { op: "precompose", layers: ["ring"] },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const after: Project = result.doc;
    expect(after.compositions).toHaveLength(3);

    const frames = [8, 24, 59];
    const [a, b] = await Promise.all([
      capture.captureFrames(before, frames),
      capture.captureFrames(after, frames),
    ]);
    for (const [k, frame] of a.entries()) {
      expect(b[k]?.skipped).toEqual([]);
      expect(
        Buffer.from(b[k]?.png ?? []).equals(Buffer.from(frame.png)),
        `frame ${frame.frame}`,
      ).toBe(true);
    }
  }, 60_000);
});
