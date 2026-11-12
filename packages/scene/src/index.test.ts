import { describe, expect, it } from "vitest";
import { SCENE_FORMAT_VERSION } from "./index.js";

describe("@kynimo/scene", () => {
  it("exposes the current scene format version", () => {
    expect(SCENE_FORMAT_VERSION).toBe(13);
  });
});
