import { describe, expect, it } from "vitest";
import { parseLength } from "./units.js";

const vp = { width: 200, height: 100 };

describe("parseLength", () => {
  it("converts absolute units at 96 dpi", () => {
    expect(parseLength("10", "x", vp)).toEqual({ value: 10, relative: false });
    expect(parseLength("10px", "x", vp)?.value).toBe(10);
    expect(parseLength("72pt", "x", vp)?.value).toBeCloseTo(96);
    expect(parseLength("1pc", "x", vp)?.value).toBe(16);
    expect(parseLength("25.4mm", "x", vp)?.value).toBeCloseTo(96);
    expect(parseLength("2.54cm", "x", vp)?.value).toBeCloseTo(96);
    expect(parseLength("1in", "x", vp)?.value).toBe(96);
  });

  it("resolves percentages against the viewBox", () => {
    expect(parseLength("50%", "x", vp)?.value).toBe(100);
    expect(parseLength("50%", "y", vp)?.value).toBe(50);
    expect(parseLength("100%", "r", vp)?.value).toBeCloseTo(Math.sqrt((200 ** 2 + 100 ** 2) / 2));
  });

  it("flags em and ex as approximated", () => {
    expect(parseLength("2em", "x", vp)).toEqual({ value: 32, relative: true });
    expect(parseLength("2ex", "x", vp)).toEqual({ value: 16, relative: true });
  });

  it("reads exponents and signs, rejects the rest", () => {
    expect(parseLength("-1.5e1", "x", vp)?.value).toBe(-15);
    expect(parseLength("abc", "x", vp)).toBeUndefined();
    expect(parseLength("10furlongs", "x", vp)).toBeUndefined();
    expect(parseLength("", "x", vp)).toBeUndefined();
  });
});
