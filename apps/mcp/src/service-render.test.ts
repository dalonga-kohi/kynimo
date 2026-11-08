import type { CapturedFrame, CapturedSheet } from "@kynimo/capture";
import type { Project } from "@kynimo/scene";
import { beforeEach, describe, expect, it } from "vitest";
import { withLayerDefaults } from "./defaults.js";
import type { FrameRenderer } from "./render.js";
import { KynimoService, ToolError } from "./service.js";
import { MemoryStore } from "./store.js";

/** Records every call and answers with fake PNGs that name what was drawn. */
class FakeRenderer implements FrameRenderer {
  calls: { kind: string; frames: number[]; size: number; columns?: number }[] = [];
  buildId = "build-1";
  fail: Error | null = null;

  async build() {
    return this.buildId;
  }

  async frames(doc: Project, composition: string, frames: readonly number[], maxSize: number) {
    if (this.fail) throw this.fail;
    this.calls.push({ kind: "frames", frames: [...frames], size: maxSize });
    const comp = doc.compositions.find((c) => c.id === composition);
    return frames.map(
      (frame): CapturedFrame => ({
        frame,
        width: Math.min(maxSize, comp?.width ?? 0),
        height: 1,
        png: new TextEncoder().encode(`frame ${frame}`),
        pixelsSha256: `px${frame}`,
        pngSha256: `png${frame}`,
        skipped: frame === 0 ? [{ id: "fx", type: "adjustment", reason: "not yet" }] : [],
        warnings: [],
      }),
    );
  }

  async sheet(
    _doc: Project,
    _composition: string,
    frames: readonly number[],
    layout: { maxSize: number; columns: number; gap: number },
  ): Promise<CapturedSheet> {
    if (this.fail) throw this.fail;
    this.calls.push({
      kind: "sheet",
      frames: [...frames],
      size: layout.maxSize,
      columns: layout.columns,
    });
    return {
      width: 10,
      height: 10,
      png: new TextEncoder().encode("sheet"),
      pixelsSha256: "px",
      pngSha256: "png",
      cellWidth: 5,
      cellHeight: 5,
      columns: Math.min(layout.columns, frames.length),
      frames: frames.map((frame) => ({ frame, skipped: [], warnings: [] })),
    };
  }

  async close() {}
}

async function rejection(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a ToolError");
}

describe("KynimoService: rendering", () => {
  let renderer: FakeRenderer;
  let svc: KynimoService;
  let project: string;

  beforeEach(async () => {
    renderer = new FakeRenderer();
    svc = new KynimoService(new MemoryStore(), "agent", { renderer });
    project = (
      await svc.createProject({
        name: "Demo",
        idempotency_key: "c",
        width: 1920,
        height: 1080,
        fps: { num: 30, den: 1 },
        duration_frames: 90,
        background: "#000000",
      })
    ).id;
  });

  const frames = (list: number[], max_size = 960) =>
    svc.renderFrames(project, { frames: list, max_size });

  it("renders frames in the requested order with hashes and aggregated skips", async () => {
    const { result, images } = await frames([30, 0, 30]);
    expect(result.frames.map((f) => [f.frame, f.width, f.cached])).toEqual([
      [30, 960, false],
      [0, 960, false],
    ]);
    expect(new TextDecoder().decode(images[0])).toBe("frame 30");
    expect(result.skipped).toEqual([
      { layer: "fx", type: "adjustment", reason: "not yet", frames: [0] },
    ]);
    expect(result).toMatchObject({ project_id: project, version: 1, composition: "main" });
  });

  it("serves repeated frames from the cache and renders only the misses", async () => {
    await frames([0, 10]);
    const { result } = await frames([10, 20, 0]);
    expect(result.frames.map((f) => f.cached)).toEqual([true, false, true]);
    expect(renderer.calls.map((c) => c.frames)).toEqual([[0, 10], [20]]);
    // Another size, another build: other keys.
    await frames([0], 480);
    renderer.buildId = "build-2";
    await frames([0]);
    expect(renderer.calls).toHaveLength(4);
  });

  it("renders again once the document changes", async () => {
    await frames([0]);
    await svc.write(
      { project_id: project, base_version: 1, idempotency_key: "w" },
      {
        kind: "ops",
        ops: [
          {
            op: "addLayer",
            composition: "main",
            layer: withLayerDefaults(
              { type: "solid", name: "S", width: 10, height: 10, color: "#ffffff" },
              { width: 1920, height: 1080, durationFrames: 90 } as never,
            ),
          },
        ],
      },
    );
    const { result } = await frames([0]);
    expect(result).toMatchObject({
      version: 2,
      frames: [expect.objectContaining({ cached: false })],
    });
  });

  it("names out-of-range frames and unknown compositions", async () => {
    const e = await rejection(frames([0, 90, 3]));
    expect(e.kind).toBe("invalid");
    expect(e.message).toMatch(/frames 0 to 89/);
    expect(e.errors).toEqual([{ path: ["frames", 1], message: "must be a frame from 0 to 89" }]);
    const missing = await rejection(
      svc.renderFrames(project, { composition: "nope", frames: [0], max_size: 960 }),
    );
    expect(missing.kind).toBe("not_found");
    expect(renderer.calls).toEqual([]);
  });

  it("reports renderer failures as render_failed, and no renderer as unavailable", async () => {
    renderer.fail = new Error("layer 'pic' shows image asset 'a', which was not loaded");
    const e = await rejection(frames([0]));
    expect([e.kind, e.message]).toEqual(["render_failed", renderer.fail.message]);
    const bare = new KynimoService(new MemoryStore(), "agent");
    expect((await rejection(bare.renderFrames(project, { frames: [0], max_size: 960 }))).kind).toBe(
      "unavailable",
    );
  });

  describe("contact sheets", () => {
    const sheet = (input: Partial<Parameters<KynimoService["renderContactSheet"]>[1]> = {}) =>
      svc.renderContactSheet(project, { count: 12, cell_size: 320, ...input });

    it("samples count frames over the composition, about square, and caches the sheet", async () => {
      const { result, images } = await sheet();
      expect(result.frames).toEqual([0, 8, 16, 24, 32, 40, 49, 57, 65, 73, 81, 89]);
      expect(renderer.calls).toEqual([
        { kind: "sheet", frames: result.frames, size: 320, columns: 4 },
      ]);
      expect([result.columns, result.rows, result.cached]).toEqual([4, 3, false]);
      expect(new TextDecoder().decode(images[0])).toBe("sheet");
      expect((await sheet()).result.cached).toBe(true);
      expect(renderer.calls).toHaveLength(1);
    });

    it("takes explicit frames or a range", async () => {
      expect((await sheet({ frames: [5, 1, 5, 9] })).result.frames).toEqual([5, 1, 9]);
      expect((await sheet({ from_frame: 30, to_frame: 60, count: 4 })).result.frames).toEqual([
        30, 40, 50, 60,
      ]);
      const e = await rejection(sheet({ from_frame: 60, to_frame: 30 }));
      expect(e.errors[0]?.path).toEqual(["to_frame"]);
      expect((await rejection(sheet({ frames: [3, 3] }))).message).toMatch(/at least 2 different/);
    });

    it("refuses a sheet over the size limit and names a cell_size that fits", async () => {
      // 8 columns of 320 px cells: 8 × 320 + 7 × 4 = 2588 px wide.
      const e = await rejection(sheet({ count: 16, columns: 8 }));
      expect(e.kind).toBe("invalid");
      expect(e.message).toMatch(/2588×.* over the 2048 px limit; use cell_size 252 or less/);
      expect(e.errors[0]?.path).toEqual(["cell_size"]);
      expect(renderer.calls).toEqual([]);
      // The suggestion fits.
      await sheet({ count: 16, columns: 8, cell_size: 252 });
      expect(renderer.calls).toHaveLength(1);
    });
  });
});
