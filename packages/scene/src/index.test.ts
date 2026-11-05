import { describe, expect, it } from "vitest";
import { SCENE_FORMAT_VERSION } from "./index.js";

describe("@kynimo/scene", () => {
  it("exposes a non-negative integer format version", () => {
    expect(Number.isInteger(SCENE_FORMAT_VERSION)).toBe(true);
    expect(SCENE_FORMAT_VERSION).toBeGreaterThanOrEqual(0);
  });
});
