import { describe, expect, it } from "vitest";
import { AssetSchema, MAX_BEATS } from "./index.js";

const audio = (beats: unknown) => ({
  id: "music",
  type: "audio",
  name: "Music",
  uri: "assets/music.mp3",
  sha256: "b".repeat(64),
  durationMs: 5000,
  ...(beats === undefined ? {} : { beats }),
});
const beats = (timesMs: number[]) => ({ bpm: 120, confidence: 0.8, timesMs });

const messages = (input: unknown) => {
  const r = AssetSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("audio asset beats", () => {
  it("accepts an asset without beats and with a detector-shaped result", () => {
    expect(AssetSchema.safeParse(audio(undefined)).success).toBe(true);
    expect(AssetSchema.safeParse(audio(beats([250, 750, 1250, 1750]))).success).toBe(true);
    expect(AssetSchema.safeParse(audio(beats([]))).success).toBe(true);
  });

  it("rejects descending and duplicate times", () => {
    expect(messages(audio(beats([500, 250])))).toContain(
      "beats.timesMs must be strictly ascending",
    );
    expect(messages(audio(beats([250, 250])))).toContain(
      "beats.timesMs must be strictly ascending",
    );
  });

  it("rejects a time at or after the duration", () => {
    expect(messages(audio(beats([250, 5000])))).toContain(
      "beats.timesMs must be before durationMs",
    );
    expect(AssetSchema.safeParse(audio(beats([250, 4999]))).success).toBe(true);
  });

  it("rejects more than 1000 beats and out-of-range values", () => {
    const many = Array.from({ length: MAX_BEATS + 1 }, (_, i) => i);
    expect(AssetSchema.safeParse({ ...audio(beats(many)), durationMs: 9999 }).success).toBe(false);
    expect(AssetSchema.safeParse(audio({ ...beats([1]), bpm: 10 })).success).toBe(false);
    expect(AssetSchema.safeParse(audio({ ...beats([1]), confidence: 2 })).success).toBe(false);
    expect(AssetSchema.safeParse(audio(beats([1.5]))).success).toBe(false);
  });
});
