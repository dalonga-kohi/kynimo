import { describe, expect, it } from "vitest";
import { mediaUrl, parseMediaUrl } from "./media-url.js";

const ID = `p-${"a1".repeat(16)}`;

describe("parseMediaUrl", () => {
  it("accepts thumbnails and previews of a store id", () => {
    expect(parseMediaUrl(`kynimo-media://thumb/${ID}/3`)).toEqual({
      kind: "thumb",
      id: ID,
      version: 3,
    });
    expect(parseMediaUrl(`kynimo-media://preview/${ID}/120`)).toEqual({
      kind: "preview",
      id: ID,
      version: 120,
    });
  });

  it("round-trips the URLs the preload builds", () => {
    expect(parseMediaUrl(mediaUrl("thumb", ID, 7))).toEqual({ kind: "thumb", id: ID, version: 7 });
  });

  it("ignores a query or hash", () => {
    expect(parseMediaUrl(`kynimo-media://thumb/${ID}/1?x=2#y`)).toMatchObject({ id: ID });
  });

  it.each([
    ["wrong scheme", `https://thumb/${ID}/1`],
    ["file scheme", `file:///C:/Windows/win.ini`],
    ["unknown kind", `kynimo-media://export/${ID}/1`],
    ["dot dot", `kynimo-media://thumb/../${ID}/1`],
    ["dot dot as id", `kynimo-media://thumb/../1`],
    ["slash in id", `kynimo-media://thumb/p-aa/../../${ID}/1`],
    ["encoded slash", `kynimo-media://thumb/${ID.slice(0, 10)}%2F..%2F${ID.slice(10)}/1`],
    ["encoded dots", `kynimo-media://thumb/%2e%2e/1`],
    ["backslash", `kynimo-media://thumb/..%5C..%5Cwin.ini/1`],
    ["path as id", `kynimo-media://thumb/C:%5CWindows%5Cwin.ini/1`],
    ["short id", `kynimo-media://thumb/p-abc/1`],
    ["uppercase id", `kynimo-media://thumb/${ID.toUpperCase()}/1`],
    ["no version", `kynimo-media://thumb/${ID}`],
    ["trailing slash", `kynimo-media://thumb/${ID}/1/`],
    ["extra segment", `kynimo-media://thumb/${ID}/1/extra`],
    ["version zero", `kynimo-media://thumb/${ID}/0`],
    ["version not a number", `kynimo-media://thumb/${ID}/latest`],
    ["negative version", `kynimo-media://thumb/${ID}/-1`],
    ["credentials", `kynimo-media://user:pw@thumb/${ID}/1`],
    ["not a URL", "thumb"],
    ["empty", ""],
  ])("rejects %s", (_name, url) => {
    expect(parseMediaUrl(url)).toBeUndefined();
  });
});
