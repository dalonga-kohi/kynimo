import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchTestCapture } from "./launch.test-util.js";
import type { CaptureSession } from "./session.js";

/**
 * Reference scenes (ADR-0018, ADR-0023): documents whose chosen frames a person has looked at and
 * approved. The approved PNG is the golden: CI renders each frame and compares the file bytes
 * exactly. `KYNIMO_UPDATE_GOLDEN=1 pnpm --filter @kynimo/capture test` re-approves them, and the
 * PR that changes a PNG shows it. A mismatch writes the new frames to `renders/reference/`.
 */
const REFERENCE = new URL("../reference/", import.meta.url);
const RENDERS = new URL("../../../renders/reference/", import.meta.url);
const UPDATE = process.env.KYNIMO_UPDATE_GOLDEN === "1";

/** Every reference scene. A folder that is not listed here fails the suite. */
const SCENES = [
  "title-card",
  "masked-matted-reveal",
  "nested-precomp-parenting",
  "product-card",
  "path-operators",
  "text-animators",
  "svg-import",
  "shader-backgrounds",
] as const;

interface Reference {
  description: string;
  frames: number[];
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

function readReference(dir: URL): Reference {
  const value = readJson(new URL("reference.json", dir)) as Partial<Reference>;
  const frames = value.frames;
  if (
    typeof value.description !== "string" ||
    !Array.isArray(frames) ||
    frames.length === 0 ||
    !frames.every((f) => Number.isInteger(f) && f >= 0) ||
    new Set(frames).size !== frames.length
  )
    throw new Error(`${dir.pathname}reference.json: needs a description and distinct frames`);
  return { description: value.description, frames };
}

/** The bytes of every image and font asset, read from its `uri` relative to the scene folder. */
function readAssets(dir: URL, document: unknown): Map<string, Uint8Array> {
  const assets = (document as { assets?: { id: string; type: string; uri: string }[] }).assets;
  return new Map(
    (assets ?? [])
      .filter((a) => a.type === "image" || a.type === "font")
      .map((a) => [a.id, new Uint8Array(readFileSync(new URL(a.uri, dir)))]),
  );
}

const frameFile = (frame: number) => `${String(frame).padStart(3, "0")}.png`;

let capture: CaptureSession;
beforeAll(async () => {
  capture = await launchTestCapture();
}, 60_000);
afterAll(async () => {
  await capture?.close();
});

describe("reference scenes (ADR-0018)", () => {
  it("lists every scene folder", () => {
    const folders = readdirSync(REFERENCE, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(folders.sort()).toEqual([...SCENES].sort());
  });

  it.each(SCENES)(
    "%s renders exactly its approved frames",
    async (scene) => {
      const dir = new URL(`${scene}/`, REFERENCE);
      const framesDir = new URL("frames/", dir);
      const document = readJson(new URL("scene.json", dir));
      const { frames } = readReference(dir);

      const captured = await capture.captureFrames(document, frames, {
        assets: readAssets(dir, document),
      });
      // A reference frame draws everything it holds, with no fallbacks.
      for (const f of captured)
        expect({ frame: f.frame, skipped: f.skipped, warnings: f.warnings }).toEqual({
          frame: f.frame,
          skipped: [],
          warnings: [],
        });

      if (UPDATE) {
        rmSync(framesDir, { recursive: true, force: true });
        mkdirSync(framesDir, { recursive: true });
        for (const f of captured) writeFileSync(new URL(frameFile(f.frame), framesDir), f.png);
        return;
      }

      const approved = readdirSync(framesDir).sort();
      const changed = captured.filter((f) => {
        const file = new URL(frameFile(f.frame), framesDir);
        return !approved.includes(frameFile(f.frame)) || !readFileSync(file).equals(f.png);
      });
      if (changed.length > 0) {
        const out = new URL(`${scene}/`, RENDERS);
        rmSync(out, { recursive: true, force: true }); // Never leave an older run's frames to look at.
        mkdirSync(out, { recursive: true });
        for (const f of changed) writeFileSync(new URL(frameFile(f.frame), out), f.png);
      }
      expect({
        changed: changed.map((f) => f.frame),
        approved,
      }).toEqual({ changed: [], approved: frames.map(frameFile).sort() });
    },
    60_000,
  );
});
