import { describe, expect, it } from "vitest";
import { NAMED_COLOR_COUNT, parseColor, withOpacity } from "./color.js";

describe("parseColor", () => {
  it("reads every hex form and lowercases", () => {
    expect(parseColor("#abc")).toBe("#aabbcc");
    expect(parseColor("#ABCD")).toBe("#aabbccdd");
    expect(parseColor("#A1B2C3")).toBe("#a1b2c3");
    expect(parseColor("#A1B2C3D4")).toBe("#a1b2c3d4");
  });

  it("reads rgb() with commas, spaces, percentages and alpha", () => {
    expect(parseColor("rgb(255, 0, 128)")).toBe("#ff0080");
    expect(parseColor("rgb(255 0 128)")).toBe("#ff0080");
    expect(parseColor("rgb(100%, 0%, 50%)")).toBe("#ff0080");
    expect(parseColor("rgba(0, 0, 0, 0.5)")).toBe("#00000080");
    expect(parseColor("rgb(0 0 0 / 50%)")).toBe("#00000080");
    expect(parseColor("rgb(0 0 0 / 1)")).toBe("#000000");
    expect(parseColor("rgb(300, -5, 0)")).toBe("#ff0000");
  });

  it("reads hsl()", () => {
    expect(parseColor("hsl(0, 100%, 50%)")).toBe("#ff0000");
    expect(parseColor("hsl(120 100% 25%)")).toBe("#008000");
    expect(parseColor("hsla(240, 100%, 50%, 0.5)")).toBe("#0000ff80");
    expect(parseColor("hsl(0.5turn 100% 50%)")).toBe("#00ffff");
  });

  it("reads all 148 named colors, case-insensitively", () => {
    expect(NAMED_COLOR_COUNT).toBe(148);
    expect(parseColor("red")).toBe("#ff0000");
    expect(parseColor("RebeccaPurple")).toBe("#663399");
    expect(parseColor("grey")).toBe(parseColor("gray"));
  });

  it("reads transparent, none and currentColor", () => {
    expect(parseColor("transparent")).toBe("#00000000");
    expect(parseColor("none")).toBe("none");
    expect(parseColor("currentColor", "#123456")).toBe("#123456");
    expect(parseColor("currentcolor")).toBe("#000000");
  });

  it("rejects what is not a color", () => {
    for (const bad of [
      "",
      "#12",
      "#12345",
      "#ggg",
      "rgb(1, 2)",
      "rgb(a b c)",
      "bluish",
      "hsl(0 1 2)",
      "url(#a)",
    ]) {
      expect(parseColor(bad), bad).toBeUndefined();
    }
  });
});

describe("withOpacity", () => {
  it("multiplies alpha", () => {
    expect(withOpacity("#ff0000", 0.5)).toBe("#ff000080");
    expect(withOpacity("#ff000080", 0.5)).toBe("#ff000040");
    expect(withOpacity("#ff0000", 1)).toBe("#ff0000");
  });
});
