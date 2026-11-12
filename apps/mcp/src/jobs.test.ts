import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_LIMITS, type JobContext, JobQueue, JobQueueError } from "./jobs.js";

interface Deferred {
  promise: Promise<string>;
  resolve(v: string): void;
  reject(e: unknown): void;
}
const deferred = (): Deferred => {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>((r) => setImmediate(r));

let clock = 1_000;
let n = 0;
const make = (limits: Partial<{ -readonly [K in keyof typeof JOB_LIMITS]: number }> = {}) =>
  new JobQueue<string>({
    now: () => clock,
    makeId: () => `j-${++n}`,
    limits,
    describeError: (e) => ({ code: "boom", message: `described ${(e as Error).message}` }),
  });
const base = { account: "a", actor: "x", projectId: "p", kind: "export", frames_total: 10 };

beforeEach(() => {
  clock = 1_000;
  n = 0;
});

describe("JobQueue", () => {
  it("runs jobs FIFO, one at a time", async () => {
    const q = make();
    const d1 = deferred();
    const d2 = deferred();
    const started: string[] = [];
    const a = q.submit({
      ...base,
      run: () => {
        started.push("1");
        return d1.promise;
      },
    }).job;
    const b = q.submit({
      ...base,
      run: () => {
        started.push("2");
        return d2.promise;
      },
    }).job;
    expect(a.state).toBe("queued");
    await tick();
    expect(started).toEqual(["1"]);
    expect(q.get("a", a.id)).toMatchObject({ state: "running", startedAt: 1_000 });
    expect(q.get("a", a.id)?.progress.phase).toBe("rendering");
    expect(q.get("a", b.id)?.state).toBe("queued");
    d1.resolve("one");
    await tick();
    expect(started).toEqual(["1", "2"]);
    expect(q.get("a", a.id)).toMatchObject({
      state: "succeeded",
      result: "one",
      progress: { phase: "done", frames_done: 10, frames_total: 10 },
      finishedAt: 1_000,
    });
    d2.resolve("two");
    await q.wait("a", b.id, 1000);
    expect(q.get("a", b.id)?.result).toBe("two");
  });

  it("merges progress while running and ignores it afterwards", async () => {
    const q = make();
    const d = deferred();
    let ctx!: JobContext;
    const { job } = q.submit({
      ...base,
      run: (c) => {
        ctx = c;
        return d.promise;
      },
    });
    await tick();
    ctx.progress({ frames_done: 4 });
    ctx.progress({ phase: "encoding" });
    expect(q.get("a", job.id)?.progress).toEqual({
      phase: "encoding",
      frames_done: 4,
      frames_total: 10,
    });
    d.reject(new Error("bad"));
    await tick();
    ctx.progress({ frames_done: 9 });
    expect(q.get("a", job.id)?.progress.frames_done).toBe(4);
  });

  it("fails with the described error", async () => {
    const q = make();
    const { job } = q.submit({ ...base, run: async () => Promise.reject(new Error("bad")) });
    const done = await q.wait("a", job.id, 1000);
    expect(done).toMatchObject({
      state: "failed",
      error: { code: "boom", message: "described bad" },
      finishedAt: 1_000,
    });
  });

  it("uses a default error description", async () => {
    const q = new JobQueue<string>();
    const { job } = q.submit({ ...base, run: async () => Promise.reject(new Error("bad")) });
    expect((await q.wait("a", job.id, 1000))?.error).toEqual({ code: "failed", message: "bad" });
  });

  it("never runs a cancelled queued job", async () => {
    const q = make();
    const d = deferred();
    const ran = vi.fn(async () => "x");
    q.submit({ ...base, run: () => d.promise });
    const { job } = q.submit({ ...base, run: ran });
    expect(q.cancel("a", job.id)?.state).toBe("cancelled");
    d.resolve("ok");
    await tick();
    await tick();
    expect(ran).not.toHaveBeenCalled();
    expect(q.get("a", job.id)?.state).toBe("cancelled");
  });

  it("aborts a running job and ends cancelled even if run resolves", async () => {
    const q = make();
    const d = deferred();
    let signal!: AbortSignal;
    const { job } = q.submit({
      ...base,
      run: (c) => {
        signal = c.signal;
        return d.promise;
      },
    });
    await tick();
    expect(q.cancel("a", job.id)?.state).toBe("running");
    expect(signal.aborted).toBe(true);
    d.resolve("late");
    const done = await q.wait("a", job.id, 1000);
    expect(done).toMatchObject({ state: "cancelled", result: null });
  });

  it("ends cancelled when an aborted run rejects", async () => {
    const q = make();
    const { job } = q.submit({
      ...base,
      run: (c) =>
        new Promise<string>((_, reject) =>
          c.signal.addEventListener("abort", () => reject(new Error("stopped"))),
        ),
    });
    await tick();
    q.cancel("a", job.id);
    expect(await q.wait("a", job.id, 1000)).toMatchObject({ state: "cancelled", error: null });
  });

  it("leaves a finished job unchanged on cancel", async () => {
    const q = make();
    const { job } = q.submit({ ...base, run: async () => "ok" });
    await q.wait("a", job.id, 1000);
    expect(q.cancel("a", job.id)).toMatchObject({ state: "succeeded", result: "ok" });
  });

  it("replays an idempotent submit", async () => {
    const q = make();
    const run = vi.fn(async () => "ok");
    const key = { idempotencyKey: "k", fingerprint: "f" };
    const first = q.submit({ ...base, key, run });
    const second = q.submit({ ...base, key, run });
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, job: { id: first.job.id } });
    await q.wait("a", first.job.id, 1000);
    expect(q.submit({ ...base, key, run }).job.state).toBe("succeeded");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects a key reused with a different fingerprint", () => {
    const q = make();
    q.submit({ ...base, key: { idempotencyKey: "k", fingerprint: "f" }, run: async () => "ok" });
    const attempt = () =>
      q.submit({ ...base, key: { idempotencyKey: "k", fingerprint: "g" }, run: async () => "ok" });
    expect(attempt).toThrow(JobQueueError);
    expect(attempt).toThrow(/different request/);
    try {
      attempt();
    } catch (e) {
      expect((e as JobQueueError).kind).toBe("key_reused");
    }
  });

  it("scopes keys to account, actor and project", () => {
    const q = make();
    const key = { idempotencyKey: "k", fingerprint: "f" };
    const a = q.submit({ ...base, key, run: async () => "ok" });
    for (const other of [{ account: "b" }, { actor: "y" }, { projectId: "q" }]) {
      const r = q.submit({ ...base, ...other, key, run: async () => "ok" });
      expect(r.replayed).toBe(false);
      expect(r.job.id).not.toBe(a.job.id);
    }
  });

  it("limits active jobs per account", () => {
    const q = make();
    const d = deferred();
    for (let i = 0; i < JOB_LIMITS.maxActivePerAccount; i++)
      q.submit({ ...base, run: () => d.promise });
    expect(() => q.submit({ ...base, run: () => d.promise })).toThrow(
      "this account already has 4 exports queued or running; wait for one to finish or cancel one",
    );
    expect(q.submit({ ...base, account: "other", run: () => d.promise }).replayed).toBe(false);
  });

  it("limits active jobs server-wide", () => {
    const q = make({ maxActive: 2 });
    const d = deferred();
    q.submit({ ...base, account: "a", run: () => d.promise });
    q.submit({ ...base, account: "b", run: () => d.promise });
    expect(() => q.submit({ ...base, account: "c", run: () => d.promise })).toThrow(
      "the server is busy with 2 exports; retry in a minute",
    );
  });

  it("does not fail a replay as busy", () => {
    const q = make({ maxActivePerAccount: 1 });
    const d = deferred();
    const key = { idempotencyKey: "k", fingerprint: "f" };
    const first = q.submit({ ...base, key, run: () => d.promise });
    expect(q.submit({ ...base, key, run: () => d.promise }).job.id).toBe(first.job.id);
  });

  it("hides other accounts' jobs", async () => {
    const q = make();
    const { job } = q.submit({ ...base, run: async () => "ok" });
    expect(q.get("b", job.id)).toBeUndefined();
    expect(q.cancel("b", job.id)).toBeUndefined();
    expect(await q.wait("b", job.id, 10)).toBeUndefined();
    expect(q.get("a", "j-nope")).toBeUndefined();
  });

  describe("wait", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("resolves when the job finishes", async () => {
      const q = make();
      const d = deferred();
      const { job } = q.submit({ ...base, run: () => d.promise });
      const waiting = q.wait("a", job.id, 60_000);
      await vi.advanceTimersByTimeAsync(10);
      d.resolve("ok");
      expect((await waiting)?.state).toBe("succeeded");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("resolves with the current record after the timeout", async () => {
      const q = make();
      const d = deferred();
      const { job } = q.submit({ ...base, run: () => d.promise });
      const waiting = q.wait("a", job.id, 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await waiting)?.state).toBe("running");
      d.resolve("ok");
    });

    it("resolves immediately for 0 ms", async () => {
      const q = make();
      const d = deferred();
      const { job } = q.submit({ ...base, run: () => d.promise });
      expect((await q.wait("a", job.id, 0))?.state).toBe("queued");
      d.resolve("ok");
    });
  });

  it("drops finished records after the retention time, with their keys", async () => {
    const q = make({ retentionMs: 100 });
    const key = { idempotencyKey: "k", fingerprint: "f" };
    const { job } = q.submit({ ...base, key, run: async () => "ok" });
    await q.wait("a", job.id, 1000);
    clock += 99;
    expect(q.get("a", job.id)).toBeDefined();
    clock += 1;
    expect(q.get("a", job.id)).toBeUndefined();
    const again = q.submit({ ...base, key: { ...key, fingerprint: "g" }, run: async () => "ok" });
    expect(again.replayed).toBe(false);
  });

  it("keeps at most maxRecordsPerAccount finished records, dropping the oldest", async () => {
    const q = make({ maxRecordsPerAccount: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock += 10;
      const { job } = q.submit({
        ...base,
        key: { idempotencyKey: `k${i}`, fingerprint: "f" },
        run: async () => "ok",
      });
      ids.push(job.id);
      await q.wait("a", job.id, 1000);
    }
    expect(q.get("a", ids[0] as string)).toBeUndefined();
    expect(q.get("a", ids[1] as string)).toBeDefined();
    expect(q.get("a", ids[2] as string)).toBeDefined();
    const reused = q.submit({
      ...base,
      key: { idempotencyKey: "k0", fingerprint: "other" },
      run: async () => "ok",
    });
    expect(reused.replayed).toBe(false);
  });

  it("closes: cancels queued, aborts running, rejects new submits", async () => {
    const q = make();
    const d = deferred();
    let signal!: AbortSignal;
    const running = q.submit({
      ...base,
      run: (c) => {
        signal = c.signal;
        return d.promise;
      },
    }).job;
    const queued = q.submit({ ...base, run: async () => "never" }).job;
    await tick();
    let closed = false;
    const closing = q.close().then(() => {
      closed = true;
    });
    await tick();
    expect(signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(q.get("a", queued.id)?.state).toBe("cancelled");
    d.reject(new Error("aborted"));
    await closing;
    expect(q.get("a", running.id)?.state).toBe("cancelled");
    try {
      q.submit({ ...base, run: async () => "x" });
      expect.unreachable();
    } catch (e) {
      expect((e as JobQueueError).kind).toBe("closed");
    }
  });

  it("returns copies", async () => {
    const q = make();
    const { job } = q.submit({ ...base, run: async () => "ok" });
    job.progress.frames_done = 99;
    expect(q.get("a", job.id)?.progress.frames_done).toBe(0);
  });
});
