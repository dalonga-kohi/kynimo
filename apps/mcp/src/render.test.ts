import type { CaptureSession } from "@kynimo/capture";
import { describe, expect, it } from "vitest";
import { aggregateReports, CaptureRenderer, RenderCache, sampleFrames } from "./render.js";

describe("RenderCache", () => {
  it("evicts the least recently used entries past its byte budget", () => {
    const cache = new RenderCache<string>(10);
    cache.set("a", "A", 4);
    cache.set("b", "B", 4);
    expect(cache.get("a")).toBe("A"); // a is now the most recent
    cache.set("c", "C", 4);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
    expect(cache.bytes).toBe(8);
  });

  it("replaces an entry under the same key and never stores one larger than the budget", () => {
    const cache = new RenderCache<string>(10);
    cache.set("a", "A", 4);
    cache.set("a", "A2", 6);
    expect([cache.get("a"), cache.bytes, cache.size]).toEqual(["A2", 6, 1]);
    cache.set("big", "X", 11);
    expect([cache.get("big"), cache.size]).toEqual([undefined, 1]);
  });
});

describe("sampleFrames", () => {
  it("spreads frames evenly, both ends included", () => {
    expect(sampleFrames(0, 89, 4)).toEqual([0, 30, 59, 89]);
    expect(sampleFrames(10, 20, 2)).toEqual([10, 20]);
  });

  it("drops duplicates when the range is shorter than the count", () => {
    expect(sampleFrames(0, 2, 6)).toEqual([0, 1, 2]);
    expect(sampleFrames(5, 5, 4)).toEqual([5]);
  });
});

describe("aggregateReports", () => {
  it("lists each skipped layer and warning once, with the frames it applies to", () => {
    const skipped = [{ id: "fx", type: "adjustment" as const, reason: "effects render in M4" }];
    const warnings = [
      { id: "t", kind: "font-fallback" as const, codepoints: [0xfb01], message: "fallback" },
    ];
    expect(
      aggregateReports([
        { frame: 0, skipped, warnings: [] },
        { frame: 5, skipped, warnings },
        { frame: 9, skipped: [], warnings },
      ]),
    ).toEqual({
      skipped: [
        { layer: "fx", type: "adjustment", reason: "effects render in M4", frames: [0, 5] },
      ],
      warnings: [
        {
          layer: "t",
          kind: "font-fallback",
          message: "fallback",
          codepoints: [0xfb01],
          frames: [5, 9],
        },
      ],
    });
  });
});

describe("CaptureRenderer", () => {
  const fakeSession = (buildId: string) => {
    const s = {
      buildId,
      closed: false,
      close: async () => {
        s.closed = true;
      },
    };
    return s as unknown as CaptureSession & { closed: boolean };
  };

  it("launches on first use only, and once for concurrent calls", async () => {
    let launches = 0;
    const renderer = new CaptureRenderer(async () => fakeSession(`b${++launches}`));
    expect(launches).toBe(0);
    expect(await Promise.all([renderer.build(), renderer.build()])).toEqual(["b1", "b1"]);
    expect(launches).toBe(1);
  });

  it("relaunches after the browser is gone, and retries a failed launch", async () => {
    let launches = 0;
    const sessions: (CaptureSession & { closed: boolean })[] = [];
    const renderer = new CaptureRenderer(async () => {
      launches++;
      if (launches === 1) throw new Error("no browser");
      const s = fakeSession(`b${launches}`);
      sessions.push(s);
      return s;
    });
    await expect(renderer.build()).rejects.toThrow("no browser");
    expect(await renderer.build()).toBe("b2");
    (sessions[0] as { closed: boolean }).closed = true; // crashed
    expect(await renderer.build()).toBe("b3");
  });

  it("closes its session and refuses calls afterwards", async () => {
    const session = fakeSession("b");
    const renderer = new CaptureRenderer(async () => session);
    await renderer.build();
    await renderer.close();
    expect(session.closed).toBe(true);
    await expect(renderer.build()).rejects.toThrow(/closed/);
  });
});
