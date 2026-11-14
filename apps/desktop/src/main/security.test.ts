import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { mediaPaths } from "./media-paths.js";
import { isAppUrl } from "./security.js";

describe("isAppUrl", () => {
  const indexFile = join(process.cwd(), "out", "renderer", "index.html");
  const built = { devUrl: undefined, indexFile };
  const dev = { devUrl: "http://localhost:5173/", indexFile };

  it("accepts the built page, with a hash or query", () => {
    const url = pathToFileURL(indexFile).toString();
    expect(isAppUrl(url, built)).toBe(true);
    expect(isAppUrl(`${url}#/animations`, built)).toBe(true);
  });

  it("rejects everything else when built", () => {
    expect(isAppUrl("https://example.com/", built)).toBe(false);
    expect(isAppUrl("http://localhost:5173/", built)).toBe(false);
    expect(isAppUrl(pathToFileURL(join(process.cwd(), "secret.html")).toString(), built)).toBe(
      false,
    );
    expect(isAppUrl("not a url", built)).toBe(false);
  });

  it("accepts the dev server's origin only in development", () => {
    expect(isAppUrl("http://localhost:5173/some/page", dev)).toBe(true);
    expect(isAppUrl("http://localhost:5174/", dev)).toBe(false);
    expect(isAppUrl("https://example.com/", dev)).toBe(false);
  });
});

describe("mediaPaths", () => {
  it("is empty in development", () => {
    expect(mediaPaths({ isPackaged: false }, "C:\\res", "win32")).toEqual({});
  });

  it("points a packaged app at its own FFmpeg and browsers", () => {
    const paths = mediaPaths({ isPackaged: true }, join("C:", "res"), "win32");
    expect(paths.ffmpeg).toBe(join("C:", "res", "media", "ffmpeg.exe"));
    expect(paths.ffprobe).toBe(join("C:", "res", "media", "ffprobe.exe"));
    expect(paths.browsers).toBe(join("C:", "res", "browsers"));
  });
});
