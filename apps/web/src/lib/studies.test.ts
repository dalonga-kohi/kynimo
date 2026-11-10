import { describe, expect, it } from "vitest";
import { drawStudy, PACKS, progress, STUDY, type StudyId, seeded } from "./studies";

/** A fake 2D context that logs every call and property write, in order. */
function recorder() {
  const log: string[] = [];
  const state: Record<string, unknown> = {};
  const target = {
    measureText: (text: string) => {
      log.push(`measureText(${text})`);
      return { width: text.length * 40 };
    },
    createRadialGradient: (...args: number[]) => {
      log.push(`createRadialGradient(${args.join(",")})`);
      return { addColorStop: (o: number, c: string) => log.push(`stop(${o},${c})`) };
    },
  };
  const ctx = new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key as keyof typeof t];
      if (key in state) return state[key];
      return (...args: unknown[]) => {
        log.push(`${key}(${args.map(String).join(",")})`);
      };
    },
    set(_t, key: string, value) {
      state[key] = value;
      log.push(`${key}=${String(value)}`);
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

const draw = (id: StudyId, frame: number) => {
  const { ctx, log } = recorder();
  drawStudy(ctx, 1920, 1080, id, frame);
  return log;
};

describe("drawStudy", () => {
  const ids = PACKS.map((p) => p.id);

  it("draws the same calls for the same frame", () => {
    for (const id of ids)
      for (const frame of [0, 37, 141, 222, 299]) expect(draw(id, frame)).toEqual(draw(id, frame));
  });

  it("wraps frames around the ten-second loop", () => {
    for (const id of ids) {
      expect(draw(id, STUDY.frames)).toEqual(draw(id, 0));
      expect(draw(id, -1)).toEqual(draw(id, STUDY.frames - 1));
    }
  });

  it("keeps the Brutalist study to at most 3 large changes a second", () => {
    // A frame's signature: every fill covering a quarter of the frame or more, and every
    // word set at 300 px or larger. A change of signature is one large change.
    const signature = (frame: number) => {
      const log = draw("brutalist", frame);
      const parts: string[] = [];
      let fill = "";
      let big = false;
      for (const line of log) {
        if (line.startsWith("fillStyle=")) fill = line;
        else if (line.startsWith("font=")) big = Number(/(\d+)px/.exec(line)?.[1] ?? 0) >= 300;
        else if (line.startsWith("fillRect(")) {
          const [, , w, h] = line.slice(9, -1).split(",").map(Number);
          if ((w ?? 0) * (h ?? 0) >= (1920 * 1080) / 4) parts.push(`${fill}:${w}x${h}`);
        } else if (line.startsWith("fillText(") && big) parts.push(line.split(",")[0] ?? "");
      }
      return parts.join("|");
    };
    const changes: number[] = [];
    for (let f = 0; f < STUDY.frames; f++)
      if (signature(f) !== signature((f + STUDY.frames - 1) % STUDY.frames)) changes.push(f);
    for (const start of changes) {
      const inWindow = changes.filter((f) => f >= start && f < start + STUDY.fps);
      expect(inWindow.length, `changes from frame ${start}: ${inWindow}`).toBeLessThanOrEqual(3);
    }
  });
});

describe("seeded", () => {
  it("repeats the same sequence for the same seed", () => {
    const a = seeded(7);
    const b = seeded(7);
    const runA = Array.from({ length: 20 }, () => a());
    const runB = Array.from({ length: 20 }, () => b());
    expect(runA).toEqual(runB);
    for (const v of runA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("gives different sequences for different seeds", () => {
    expect(seeded(1)()).not.toBe(seeded(2)());
  });
});

describe("progress", () => {
  it("runs 0 to 1 over its window and clamps outside it", () => {
    expect(progress(0, 10, 20)).toBe(0);
    expect(progress(20, 10, 20)).toBe(0.5);
    expect(progress(40, 10, 20)).toBe(1);
  });
});
