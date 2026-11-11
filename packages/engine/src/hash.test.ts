import { describe, expect, it } from "vitest";
import { hashLattice } from "./behavior.js";
import { hashWords } from "./hash.js";

describe("hashWords", () => {
  it("pins known outputs (the GLSL mirror must match these)", () => {
    expect(hashWords(0, [])).toBe(0);
    expect(hashWords(0, [0])).toBe(593689054);
    expect(hashWords(1, [2, 3])).toBe(2920678231);
    expect(hashWords(99, [0, 1, 2, 3])).toBe(282495089);
    expect(hashWords(0xffffffff, [-1, 0x7fffffff, 0xffffffff])).toBe(1446301171);
  });

  it("returns unsigned 32-bit values", () => {
    for (let i = -5; i < 50; i++) {
      const h = hashWords(i, [i, i * 7919]);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("treats a signed word as its two's-complement bit pattern", () => {
    expect(hashWords(5, [-1])).toBe(hashWords(5, [0xffffffff]));
    expect(hashWords(5, [-2])).toBe(hashWords(5, [0xfffffffe]));
  });

  it("depends on the seed, every word and the word order", () => {
    const base = hashWords(1, [1, 2, 3]);
    expect(hashWords(2, [1, 2, 3])).not.toBe(base);
    expect(hashWords(1, [1, 2, 4])).not.toBe(base);
    expect(hashWords(1, [3, 2, 1])).not.toBe(base);
    expect(hashWords(1, [1, 2, 3, 0])).not.toBe(base);
  });

  it("leaves hashLattice unchanged", () => {
    expect(hashLattice(0, 0, 0, 0)).toBe(3187378880);
    expect(hashLattice(7, 0, 0, 1)).toBe(1199243789);
    expect(hashLattice(7, 1, 0, 1)).toBe(2757665726);
    expect(hashLattice(7, 0, 2, 1)).toBe(172208487);
  });
});
