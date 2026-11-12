import { mulberry32 } from "@kynimo/engine";
import { describe, expect, it } from "vitest";
import { BEAT_LIMITS, type DetectedBeats, detectBeats } from "./beats.js";

interface TrackOptions {
  bpm: number;
  seconds: number;
  offsetMs: number;
  rate?: number;
  channels?: number;
  /** Sound of each beat; default is a 1 kHz click. */
  kick?: boolean;
}

/** Click (or kick plus off-beat click) track on silence, deterministic. Returns pcm and true beat times. */
function track({
  bpm,
  seconds,
  offsetMs,
  rate = 48_000,
  channels = 2,
  kick = false,
}: TrackOptions) {
  const frames = Math.round(seconds * rate);
  const pcm = new Float32Array(frames * channels);
  const put = (startMs: number, hz: number, tauMs: number, lenMs: number, amp: number) => {
    const start = Math.round((startMs * rate) / 1000);
    const len = Math.round((lenMs * rate) / 1000);
    for (let i = 0; i < len && start + i < frames; i++) {
      const t = i / rate;
      const v = amp * Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / (tauMs / 1000));
      for (let c = 0; c < channels; c++)
        pcm[(start + i) * channels + c] = (pcm[(start + i) * channels + c] ?? 0) + v;
    }
  };
  const period = 60_000 / bpm;
  const truth: number[] = [];
  for (let ms = offsetMs; ms < seconds * 1000 - 50; ms += period) {
    truth.push(ms);
    if (kick) {
      put(ms, 60, 80, 200, 0.8);
      put(ms + period / 2, 1000, 5, 20, 0.3);
    } else put(ms, 1000, 5, 20, 0.8);
  }
  return { pcm, truth, durationMs: Math.floor((frames * 1000) / rate) };
}

function noise(seconds: number, seed: number): Float32Array {
  const next = mulberry32(seed);
  const pcm = new Float32Array(Math.round(seconds * 48_000) * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (next() / 0xffffffff) * 0.2 - 0.1;
  return pcm;
}

function expectInvariants(r: DetectedBeats, durationMs: number) {
  expect(r.bpm).toBeGreaterThanOrEqual(BEAT_LIMITS.minBpm);
  expect(r.bpm).toBeLessThanOrEqual(BEAT_LIMITS.maxBpm);
  expect(r.confidence).toBeGreaterThanOrEqual(0);
  expect(r.confidence).toBeLessThanOrEqual(1);
  expect(r.timesMs.length).toBeGreaterThanOrEqual(BEAT_LIMITS.minBeats);
  r.timesMs.forEach((t, i) => {
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeLessThan(durationMs);
    if (i > 0) expect(t).toBeGreaterThan(r.timesMs[i - 1] as number);
  });
}

function expectTracksClicks(opts: TrackOptions) {
  const { pcm, truth, durationMs } = track(opts);
  const r = detectBeats(pcm);
  expect(r).toBeDefined();
  if (r === undefined) return;
  expect(Math.abs(r.bpm - opts.bpm)).toBeLessThanOrEqual(1);
  expectInvariants(r, durationMs);
  const judged = truth.filter((t) => t >= 1000);
  for (const t of judged) {
    const nearest = Math.min(...r.timesMs.map((b) => Math.abs(b - t)));
    expect(nearest, `click at ${t} ms`).toBeLessThanOrEqual(25);
  }
  expect(Math.abs(r.timesMs.length - truth.length)).toBeLessThanOrEqual(1);
}

describe("detectBeats on click tracks", () => {
  it("finds 120 bpm with a 250 ms offset", () => {
    expectTracksClicks({ bpm: 120, seconds: 10, offsetMs: 250 });
  });

  it("finds 90 bpm", () => {
    expectTracksClicks({ bpm: 90, seconds: 12, offsetMs: 250 });
  });

  it("finds 140 bpm", () => {
    expectTracksClicks({ bpm: 140, seconds: 12, offsetMs: 250 });
  });

  it("finds the tempo of a kick pattern with off-beat clicks", () => {
    const { pcm, durationMs } = track({ bpm: 100, seconds: 12, offsetMs: 250, kick: true });
    const r = detectBeats(pcm);
    expect(r).toBeDefined();
    if (r === undefined) return;
    expect(Math.abs(r.bpm - 100)).toBeLessThanOrEqual(1);
    expectInvariants(r, durationMs);
  });

  it("works on mono input and at another sample rate", () => {
    const mono = track({ bpm: 120, seconds: 10, offsetMs: 250, channels: 1 });
    const r = detectBeats(mono.pcm, 1);
    expect(r && Math.abs(r.bpm - 120)).toBeLessThanOrEqual(1);
    const slow = track({ bpm: 120, seconds: 10, offsetMs: 250, rate: 44_100 });
    const r2 = detectBeats(slow.pcm, 2, 44_100);
    expect(r2 && Math.abs(r2.bpm - 120)).toBeLessThanOrEqual(1);
  });

  it("is deterministic", () => {
    const { pcm } = track({ bpm: 120, seconds: 8, offsetMs: 100 });
    expect(detectBeats(pcm)).toEqual(detectBeats(pcm));
  });
});

describe("detectBeats without a beat", () => {
  it("returns undefined for silence, constant DC and too little audio", () => {
    expect(detectBeats(new Float32Array(48_000 * 2 * 5))).toBeUndefined();
    expect(detectBeats(new Float32Array(48_000 * 2 * 5).fill(0.5))).toBeUndefined();
    expect(detectBeats(new Float32Array(1023 * 2))).toBeUndefined();
    expect(detectBeats(new Float32Array(0))).toBeUndefined();
  });

  it("treats non-finite samples as silence", () => {
    expect(detectBeats(new Float32Array(48_000 * 2 * 3).fill(Number.NaN))).toBeUndefined();
  });

  it("finds no beat in seeded white noise", () => {
    for (const seed of [1, 7, 42]) expect(detectBeats(noise(10, seed))).toBeUndefined();
  });
});

describe("detectBeats input checks", () => {
  it("rejects a length that does not match the channel count", () => {
    expect(() => detectBeats(new Float32Array(7), 2)).toThrow(RangeError);
  });

  it("rejects bad channels and rate", () => {
    expect(() => detectBeats(new Float32Array(8), 0)).toThrow(RangeError);
    expect(() => detectBeats(new Float32Array(8), 2, 0)).toThrow(RangeError);
  });

  it("rejects audio longer than 61 s and accepts 61 s", () => {
    expect(() => detectBeats(new Float32Array(62 * 48_000 * 2))).toThrow(/61/);
    expect(() => detectBeats(new Float32Array(61 * 48_000 * 2))).not.toThrow();
  });
});

describe("detectBeats performance", () => {
  it("analyses 61 s of stereo audio in under 3 s", () => {
    const { pcm, durationMs } = track({ bpm: 128, seconds: 61, offsetMs: 100 });
    const started = performance.now();
    const r = detectBeats(pcm);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(r).toBeDefined();
    if (r) expectInvariants(r, durationMs);
  }, 20_000);
});
