import { describe, expect, it } from "vitest";
import { dashPattern } from "./shapes.js";

describe("dashPattern", () => {
  it("is null for a solid stroke", () => {
    expect(dashPattern([], 3)).toBeNull();
    expect(dashPattern([0, 0], 0)).toBeNull();
  });

  it("repeats odd lists once, as SVG does", () => {
    expect(dashPattern([4, 2, 1], 0)?.intervals).toEqual([4, 2, 1, 4, 2, 1]);
  });

  it("wraps the offset into one pattern length, negative offsets included", () => {
    expect(dashPattern([4, 2], 13)?.phase).toBe(1);
    expect(dashPattern([4, 2], -1)?.phase).toBe(5);
  });
});
