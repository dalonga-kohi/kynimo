import { describe, expect, it } from "vitest";
import { RunScriptRequest } from "./schemas.js";
import { KynimoService, SCRIPT_CONCURRENCY, ServiceRuntime } from "./service.js";
import { MemoryStore } from "./store.js";

const settings = {
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  duration_frames: 90,
  background: "#000000",
};

describe("script concurrency", () => {
  it("expands at most SCRIPT_CONCURRENCY scripts at once; later ones wait their turn", async () => {
    expect(SCRIPT_CONCURRENCY).toBe(2);
    const rt = new ServiceRuntime({ scriptLimits: { deadlineMs: 60_000 } });
    const svc = new KynimoService(new MemoryStore(), "agent", rt);
    // Observe the slots the service really goes through.
    const slots = rt.scriptSlots;
    const original = slots.run.bind(slots);
    const events: string[] = [];
    let active = 0;
    let peak = 0;
    let n = 0;
    slots.run = (fn) =>
      original(async () => {
        const id = ++n;
        active++;
        peak = Math.max(peak, active);
        events.push(`start ${id}`);
        try {
          return await fn();
        } finally {
          active--;
          events.push(`end ${id}`);
        }
      });

    const ids: string[] = [];
    for (const i of [1, 2, 3]) {
      ids.push(
        (await svc.createProject({ name: `P${i}`, idempotency_key: `c${i}`, ...settings })).id,
      );
    }
    const results = await Promise.all(
      ids.map((project_id, i) =>
        svc.runScript(
          { project_id, base_version: 1, idempotency_key: `s${i}` },
          { source: "kynimo.composition();" },
          true,
          RunScriptRequest,
        ),
      ),
    );
    expect(results).toHaveLength(3);
    expect(peak).toBe(SCRIPT_CONCURRENCY);
    // The third script starts only after one of the first two has finished.
    expect(events.indexOf("start 3")).toBeGreaterThan(
      Math.min(events.indexOf("end 1"), events.indexOf("end 2")),
    );
  });
});
