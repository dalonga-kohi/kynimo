import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bridgePath } from "./external.js";
import { mediaEnv, mediaPaths, noticesDir } from "./media-paths.js";

const RESOURCES = join("install", "Kynimo", "resources");

describe("mediaPaths", () => {
  it("is empty in development: the PATH's FFmpeg and Playwright's browsers", () => {
    expect(mediaPaths({ isPackaged: false }, RESOURCES, "win32")).toEqual({});
  });

  it("points a packaged Windows app at the files in its resources folder", () => {
    expect(mediaPaths({ isPackaged: true }, RESOURCES, "win32")).toEqual({
      ffmpeg: join(RESOURCES, "media", "ffmpeg.exe"),
      ffprobe: join(RESOURCES, "media", "ffprobe.exe"),
      browsers: join(RESOURCES, "browsers"),
    });
  });
});

describe("noticesDir", () => {
  it("is the notices folder when packaged and nothing in development", () => {
    expect(noticesDir({ isPackaged: true }, RESOURCES)).toBe(join(RESOURCES, "notices"));
    expect(noticesDir({ isPackaged: false }, RESOURCES)).toBeUndefined();
  });
});

describe("bridgePath", () => {
  it("is bridge.mjs in the resources folder when packaged", () => {
    expect(bridgePath({ isPackaged: true }, RESOURCES, join("app.asar", "out", "main"))).toBe(
      join(RESOURCES, "bridge.mjs"),
    );
  });

  it("is next to the main bundle in development", () => {
    expect(bridgePath({ isPackaged: false }, RESOURCES, join("repo", "out", "main"))).toBe(
      join("repo", "out", "main", "bridge.mjs"),
    );
  });
});

describe("mediaEnv", () => {
  it("sets the three server settings for a packaged app and none in development", () => {
    const media = mediaPaths({ isPackaged: true }, RESOURCES, "win32");
    expect(mediaEnv(media)).toEqual({
      KYNIMO_FFMPEG: join(RESOURCES, "media", "ffmpeg.exe"),
      KYNIMO_FFPROBE: join(RESOURCES, "media", "ffprobe.exe"),
      PLAYWRIGHT_BROWSERS_PATH: join(RESOURCES, "browsers"),
    });
    expect(mediaEnv({})).toEqual({});
  });
});
